const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { supabase } = require('../config/supabase');
const pdfService = require('../services/pdf.service');
const path = require('path');

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
