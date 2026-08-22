const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { supabase } = require('../config/supabase');
const pdfService = require('../services/pdf.service');
const path = require('path');
const { audit } = require('../services/audit.service');

// Écriture officielle d'une note. Les interfaces ne doivent pas écrire directement dans Supabase.
router.put('/:noteId', authenticateToken, requirePermission('notes.write'), async (req, res) => {
  const { noteId } = req.params;
  const { valeur_cc, valeur_tp, valeur_sn, motif, classe_id } = req.body;
  if (!classe_id || !motif?.trim()) return res.status(400).json({ message: 'classe_id et motif sont requis pour toute correction de note.' });
  const values = { valeur_cc, valeur_tp, valeur_sn };
  if (Object.values(values).some(value => value !== null && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 20))) {
    return res.status(400).json({ message: 'Les notes doivent être comprises entre 0 et 20.' });
  }
  try {
    const { data: old, error: readError } = await supabase.from('note').select('*').eq('id_note', noteId).single();
    if (readError || !old) return res.status(404).json({ message: 'Note introuvable.' });
    const { data: ec, error: ecError } = await supabase.from('ec').select('ue_id').eq('id_ec', old.ec_id).single();
    if (ecError) throw ecError;
    const { data: lock, error: lockError } = await supabase.from('ue_classe_annee_lock').select('statut').match({ ue_id: ec.ue_id, classe_id, annee_id: old.annee_id }).maybeSingle();
    if (lockError) throw lockError;
    if (lock && lock.statut !== 'OPEN') return res.status(423).json({ message: 'UE verrouillée pour cette classe et cette année.' });

    const { data: decision } = await supabase.from('deliberation_decision')
      .select('id, deliberation!inner(classe_id, annee_id, statut)')
      .eq('etudiant_id', old.etudiant_id).eq('deliberation.classe_id', classe_id).eq('deliberation.annee_id', old.annee_id).eq('deliberation.statut', 'PUBLISHED').eq('decision', 'ADMIS').maybeSingle();
    if (decision && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'La note d’un étudiant admis ne peut être modifiée que par un super-administrateur autorisé.' });
    }
    if (decision) {
      // Vérifie aussi l'autorisation explicite, même pour un compte qui revendique le rôle SUPER_ADMIN.
      const { data: grant, error: grantError } = await supabase.from('role_permission').select('permission_code').eq('role', req.user.role).eq('permission_code', 'notes.override_admitted').maybeSingle();
      if (grantError) throw grantError;
      if (!grant) return res.status(403).json({ message: 'Permission notes.override_admitted requise.' });
    }
    const update = { valeur_cc, valeur_tp, valeur_sn, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('note').update(update).eq('id_note', noteId).select().single();
    if (error) throw error;
    const action = decision ? 'OVERRIDE_ADMITTED' : 'UPDATE';
    await supabase.from('note_audit').insert({ note_id: Number(noteId), etudiant_id: old.etudiant_id, ec_id: old.ec_id, session_id: old.session_id, annee_id: old.annee_id, action, old_values: old, new_values: data, motif: motif.trim(), utilisateur_id: req.user.id });
    await audit({ user: req.user, action, module: 'NOTES', resourceType: 'note', resourceId: noteId, description: motif.trim(), oldValues: old, newValues: data, request: req });
    res.json(data);
  } catch (error) {
    console.error('Erreur de correction note:', error);
    res.status(500).json({ message: 'Correction de note impossible.', detail: error.message });
  }
});

// ─── Route existante : Export PV PDF ──────────────────────────────────────────
router.get('/export/:ecId', 
  authenticateToken, 
  authorizeRoles('ENSEIGNANT', 'ADMIN'), 
  async (req, res) => {
    const { ecId } = req.params;

    try {
      // 1. Fetch data from Supabase
      const { data: notes, error: notesErr } = await supabase
        .from('note')
        .select(`
          *,
          etudiant:etudiant_id (matricule, nom)
        `)
        .eq('ec_id', ecId);

      if (notesErr) throw notesErr;

      const { data: ec, error: ecErr } = await supabase
        .from('ec')
        .select('*')
        .eq('id', ecId)
        .single();

      if (ecErr) throw ecErr;

      // 2. Format data for PDF
      const formattedData = notes.map(n => ({
        matricule: n.etudiant.matricule,
        nom: n.etudiant.nom,
        cc: n.value_cc,
        sn: n.value_sn,
        tp: n.value_tp
      }));

      const metadata = {
        ecName: ec.nom,
        ecCode: ec.code,
        annee: '2023-2024', // Should be dynamic
        semestre: '1'
      };

      // 3. Generate PDF
      const { filePath, filename } = await pdfService.generatePV(formattedData, metadata);

      // 4. Send file
      res.download(filePath, filename);
    } catch (err) {
      console.error('Export error:', err);
      res.status(500).json({ message: 'Error generating PV.' });
    }
  }
);

// ─── Nouvelle route : Lire les erreurs d'import pour un EC ────────────────────
// GET /api/notes/errors/:ecId
// Retourne toutes les erreurs (EN_ERREUR + RESOLU) pour un EC donné
router.get('/errors/:ecId',
  authenticateToken,
  authorizeRoles('ENSEIGNANT', 'ADMIN'),
  async (req, res) => {
    const { ecId } = req.params;
    const { anneeId } = req.query; // optionnel : filtrer par année

    try {
      let query = supabase
        .from('import_error')
        .select(`
          id,
          ec_id,
          session_id,
          annee_id,
          etudiant_id,
          matricule_brut,
          problemes,
          statut,
          date_detection,
          date_resolution,
          import_batch_id,
          etudiant:etudiant_id (matricule, nom, prenom)
        `)
        .eq('ec_id', ecId)
        .order('date_detection', { ascending: false });

      if (anneeId) {
        query = query.eq('annee_id', anneeId);
      }

      const { data, error } = await query;

      if (error) throw error;

      res.status(200).json({
        errors: data || [],
        stats: {
          total: (data || []).length,
          enErreur: (data || []).filter(e => e.statut === 'EN_ERREUR').length,
          resolus: (data || []).filter(e => e.statut === 'RESOLU').length
        }
      });
    } catch (err) {
      console.error('Erreur lecture import_error:', err);
      res.status(500).json({ message: 'Erreur lors de la récupération des erreurs.', detail: err.message });
    }
  }
);

// ─── Nouvelle route : Synchroniser les erreurs après modification du tableau ──
// POST /api/notes/sync-errors/:ecId
// Corps : { sessionId, anneeId, rows: [{ matricule_brut, problemes: string[], isResolved: boolean }] }
// Pour chaque ligne :
//   - isResolved = true  → UPDATE import_error SET statut='RESOLU', date_resolution=NOW()
//   - isResolved = false → UPSERT import_error avec les nouveaux problèmes (statut='EN_ERREUR')
//   - Sans entrée dans le body → ne touche pas aux enregistrements non mentionnés
router.post('/sync-errors/:ecId',
  authenticateToken,
  authorizeRoles('ENSEIGNANT', 'ADMIN'),
  async (req, res) => {
    const { ecId } = req.params;
    const { sessionId, anneeId, rows } = req.body;

    if (!sessionId || !anneeId || !Array.isArray(rows)) {
      return res.status(400).json({ message: 'Paramètres manquants (sessionId, anneeId, rows).' });
    }

    try {
      console.log(`[sync-errors] Request for EC ${ecId}, Session ${sessionId}, Annee ${anneeId}`);
      console.log(`[sync-errors] Received ${rows.length} rows to sync`);
      const resolved = [];
      const updated = [];
      const errors = [];

      for (const row of rows) {
        const { matricule_brut, problemes, isResolved } = row;
        if (!matricule_brut) {
           console.log(`[sync-errors] Skipping row with empty matricule_brut`);
           continue;
        }

        if (isResolved) {
          // Marquer comme résolu
          const { error: resolveErr } = await supabase
            .from('import_error')
            .update({
              statut: 'RESOLU',
              date_resolution: new Date().toISOString()
            })
            .eq('ec_id', parseInt(ecId))
            .eq('session_id', parseInt(sessionId))
            .eq('matricule_brut', matricule_brut)
            .eq('statut', 'EN_ERREUR'); // Ne toucher qu'aux erreurs encore ouvertes

          if (resolveErr) {
            errors.push(`Erreur résolution ${matricule_brut}: ${resolveErr.message}`);
          } else {
            resolved.push(matricule_brut);
          }
        } else if (problemes && problemes.length > 0) {
          // Mettre à jour ou créer l'entrée d'erreur
          const { error: upsertErr } = await supabase
            .from('import_error')
            .upsert({
              ec_id: parseInt(ecId),
              session_id: parseInt(sessionId),
              annee_id: anneeId,
              matricule_brut,
              problemes,
              statut: 'EN_ERREUR',
              date_detection: new Date().toISOString(),
              date_resolution: null
            }, { onConflict: 'ec_id,session_id,matricule_brut' });

          if (upsertErr) {
            errors.push(`Erreur upsert ${matricule_brut}: ${upsertErr.message}`);
          } else {
            updated.push(matricule_brut);
          }
        }
      }

      res.status(200).json({
        message: 'Synchronisation terminée',
        resolved: resolved.length,
        updated: updated.length,
        errors
      });
    } catch (err) {
      console.error('Erreur sync import_error:', err);
      res.status(500).json({ message: 'Erreur lors de la synchronisation des erreurs.', detail: err.message });
    }
  }
);

module.exports = router;
