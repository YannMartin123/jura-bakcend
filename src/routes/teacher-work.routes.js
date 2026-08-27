const express = require('express');
const { pool, query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const { assertCanManageUe } = require('../middleware/ue-assignment');
const router = express.Router();
router.use(authenticateToken);

// ----------------------------------------------------------------------
// PRECISION NUMERIQUE (critique : les seuils d'admission dependent de la
// 2e decimale de la moyenne)
// ----------------------------------------------------------------------
// Les colonnes DB (note_cc/tp/sn, moyenne_ec, MOYENNE...) sont en
// DECIMAL(5,2) -- arithmetique base 10 exacte cote MySQL. Le risque vient
// du cote JS : les `double` IEEE-754 ne representent pas exactement la
// plupart des decimaux (0.1 + 0.2 !== 0.3), et `toFixed()` a un bug connu
// sur les cas limites (`(1.005).toFixed(2) === '1.00'`, pas '1.01').
//
// Regle appliquee ici : arrondir a 2 decimales avec `round2` A CHAQUE
// ETAPE ou une note/moyenne est calculee et stockee -- jamais seulement a
// l'affichage -- pour que la valeur en base soit deja la valeur exacte
// utilisee ensuite pour les decisions d'admission (>= 50, etc.), sans
// bruit binaire residuel. Pour la moyenne ponderee de l'UE (division,
// l'operation la plus a risque), on delegue le calcul a MySQL lui-meme
// (arithmetique DECIMAL exacte) plutot que de sommer/diviser en JS.
const round2 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

async function getActiveYear(connection = null) {
  const executor = connection || { query: async (sql, params) => [await query(sql, params)] };
  const [years] = await executor.query('SELECT annee FROM academic_years WHERE est_active=1 LIMIT 1');
  if (!years[0]) throw Object.assign(new Error('Aucune année académique active.'), { status: 409 });
  return Number(years[0].annee);
}

// ----------------------------------------------------------------------
// NOUVEAU SCHEMA UNIFIE EC/UE (migration "EC-miroir")
// ----------------------------------------------------------------------
// Depuis la migration, TOUTE UE correctement configurée possède AU MOINS
// un EC : soit un ou plusieurs vrais EC (origine='SAISIE'), soit un
// EC-miroir unique auto-généré (origine='AUTO_UE_SEULE') représentant
// l'UE elle-même quand elle n'a pas d'EC détaillé.
//
// Conséquence : il n'y a plus de branche SINGLE / MULTIPLE dans la saisie
// des notes. La saisie se fait TOUJOURS au niveau EC (CC/TP/SN), qu'il y
// en ait un seul (miroir ou EC unique) ou plusieurs. `mode` (issu de
// `ue_ec_modes`) redevient une simple information d'affichage pour le
// frontend, plus un aiguillage de logique métier.
// ----------------------------------------------------------------------

async function getUeContext(connection, classeId, ueId, annee, userId) {
  const [programme] = await connection.query(`SELECT p.CREDIT, ps.IDSEMESTRE
    FROM Programme p LEFT JOIN programme_semestres ps ON ps.IDCLASSE=p.IDCLASSE AND ps.IDUE=p.IDUE AND ps.ANNEE=p.ANNEE
    WHERE p.IDCLASSE=? AND p.IDUE=? AND p.ANNEE=? LIMIT 1`, [classeId, ueId, annee]);
  if (!programme[0] || !programme[0].IDSEMESTRE) throw Object.assign(new Error('Cette UE n’est pas correctement programmée (semestre manquant).'), { status: 409 });

  const EC_QUERY = `SELECT e.IDEC, e.INTITULE, e.poids AS CREDIT, e.origine, t.type, t.echelle
    FROM ec e LEFT JOIN ec_evaluation_types t ON t.IDEC=e.IDEC WHERE e.IDUE=? ORDER BY e.IDEC, t.type`;

  // e.poids (ex e.CREDIT) est un poids relatif interne entre EC d'une même
  // UE, PAS un crédit académique (celui-ci vient de Programme.CREDIT
  // ci-dessus). Alias `CREDIT` conservé côté SQL pour ne pas casser le
  // contrat JSON existant côté frontend (ecs[].credit).
  let [ecRows] = await connection.query(EC_QUERY, [ueId]);

  if (ecRows.length === 0) {
    // Par défaut, une UE sans AUCUN EC est considérée SINGLE : elle EST
    // sa propre EC, sans action admin préalable. Le mode ne diverge que
    // si quelqu'un configure explicitement de vrais EC (mode MULTIPLE)
    // via sp_definir_mode_ue. On auto-provisionne donc l'EC-miroir ici,
    // à la volée, au premier accès à cette UE.
    await ensureUeHasEc(connection, ueId, userId);
    [ecRows] = await connection.query(EC_QUERY, [ueId]);
  }

  const components = new Map();
  ecRows.forEach((row) => {
    if (!components.has(row.IDEC)) components.set(row.IDEC, { id: row.IDEC, intitule: row.INTITULE, credit: Number(row.CREDIT), origine: row.origine, evaluations: [] });
    if (row.type) components.get(row.IDEC).evaluations.push({ type: row.type, echelle: Number(row.echelle) });
  });
  const ecs = [...components.values()];

  if (ecs.length === 0) {
    // Ne devrait plus arriver (l'auto-provisioning ci-dessus vient de
    // créer l'EC-miroir) -- filet de sécurité si la procédure a échoué
    // silencieusement pour une raison imprévue.
    throw Object.assign(new Error("Impossible de provisionner automatiquement l'EC de cette UE. Contacter un administrateur."), { status: 500 });
  }

  const [modeRows] = await connection.query('SELECT `mode` FROM ue_ec_modes WHERE IDUE=? LIMIT 1', [ueId]);
  const mode = modeRows[0]?.mode || (ecs.length > 1 ? 'MULTIPLE' : 'SINGLE');

  return { credit: Number(programme[0].CREDIT), semestre: programme[0].IDSEMESTRE, mode, ecs };
}

// Crée l'EC-miroir (mode SINGLE) pour une UE qui n'a encore aucun EC.
// Tolère la course concurrentielle : si un autre appel a déjà créé l'EC
// entre notre lecture et cet appel (contrainte uq_ec_ue_seule), on ignore
// l'erreur de doublon -- l'appelant relira simplement l'état à jour juste après.
async function ensureUeHasEc(connection, ueId, userId) {
  try {
    await connection.query('CALL sp_definir_mode_ue(?, ?, ?)', [ueId, 'SINGLE', userId]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
}

// Complétude toujours calculée au niveau EC : un (étudiant, EC) sans ligne
// dans `notes` compte comme manquant, que l'UE ait 1 EC (miroir) ou N.
async function getCompletion(connection, classeId, ueId, annee) {
  const [missing] = await connection.query(`SELECT COUNT(*) AS total FROM Inscript i CROSS JOIN ec e LEFT JOIN notes n
    ON n.IDEC=e.IDEC AND n.MATRICULE=i.MATRICULE AND n.IDCLASSE=? AND n.ANNEE=?
    WHERE i.IDCLASSE=? AND i.ANNEE=? AND e.IDUE=? AND n.IDEC IS NULL`, [classeId, annee, classeId, annee, ueId]);
  return Number(missing[0].total);
}

router.get('/my-assignments', async (req, res, next) => {
  try {
    const years = await query('SELECT annee FROM academic_years WHERE est_active=1 LIMIT 1');
    if (!years[0]) return res.status(409).json({ message: 'Aucune année académique active.' });
    const annee = years[0].annee;
    const rows = await query(`SELECT a.IDCLASSE, a.IDUE, a.ANNEE, c.NIVEAU, u.CODUE, u.INTITULE, p.CREDIT
      FROM teacher_ue_assignments a JOIN Classe c ON c.IDCLASSE=a.IDCLASSE JOIN UE u ON u.IDUE=a.IDUE
      LEFT JOIN Programme p ON p.IDCLASSE=a.IDCLASSE AND p.IDUE=a.IDUE AND p.ANNEE=a.ANNEE
      WHERE a.user_id=? AND a.ANNEE=? ORDER BY a.IDCLASSE,u.CODUE`, [req.user.id, annee]);
    res.json({ annee, assignments: rows });
  } catch (error) { next(error); }
});

router.get('/gradebook/:classeId/:ueId', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const classeId = Number(req.params.classeId); const ueId = Number(req.params.ueId);
    const annee = await getActiveYear(connection);
    await assertCanManageUe({ user: req.user, idue: ueId, idclasse: classeId, annee });
    if (req.user.role === 'ENSEIGNANT') {
      const [assignment] = await connection.query('SELECT 1 FROM teacher_ue_assignments WHERE user_id=? AND IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [req.user.id, classeId, ueId, annee]);
      if (!assignment[0]) return res.status(403).json({ message: 'UE non affectée à cet enseignant.' });
    }
    const context = await getUeContext(connection, classeId, ueId, annee, req.user.id);

    const isRattrapage = req.query.rattrapage === 'true';
    const targetSemester = isRattrapage ? (context.semestre === 1 ? 3 : 4) : context.semestre;
    const targetContext = { ...context, semestre: targetSemester };

    const [ueRows, students, locks, ecNotes] = await Promise.all([
      connection.query('SELECT IDUE,CODUE,INTITULE FROM UE WHERE IDUE=? LIMIT 1', [ueId]),
      connection.query(`SELECT i.MATRICULE, e.NOM, m.MOYENNE AS moyenne_ue
        FROM Inscript i JOIN Etudiant e ON e.MATRICULE=i.MATRICULE
        LEFT JOIN Moyennes m ON m.MATRICULE=i.MATRICULE AND m.IDUE=? AND m.IDSEMESTRE=? AND m.ANNEE=?
        WHERE i.IDCLASSE=? AND i.ANNEE=? ORDER BY e.NOM, i.MATRICULE`, [ueId, targetSemester, annee, classeId, annee]),
      connection.query('SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [classeId, ueId, annee]),
      connection.query(`SELECT n.IDEC,n.MATRICULE,n.note_cc,n.note_tp,n.note_sn,n.moyenne_ec
        FROM notes n JOIN ec e ON e.IDEC=n.IDEC WHERE e.IDUE=? AND n.IDCLASSE=? AND n.ANNEE=?`, [ueId, classeId, annee]),
    ]);
    const notesByStudent = {};
    ecNotes[0].forEach((note) => { if (!notesByStudent[note.MATRICULE]) notesByStudent[note.MATRICULE] = {}; notesByStudent[note.MATRICULE][note.IDEC] = note; });
    const missing = isRattrapage ? 0 : await getCompletion(connection, classeId, ueId, annee);
    res.json({ annee, classe_id: classeId, ue: ueRows[0][0], locked: locks[0][0]?.statut && locks[0][0].statut !== 'OPEN', context: targetContext, students: students[0].map((student) => ({ ...student, ec_notes: notesByStudent[student.MATRICULE] || {} })), missing });
  } catch (error) { next(error); } finally { connection.release(); }
});

router.put('/gradebook', requirePermission('ue_notes.write'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { classe_id, ue_id, ec_id, rows, motif, is_rattrapage } = req.body;
    // ec_id est désormais TOUJOURS requis : même une UE sans EC réel se
    // note via son EC-miroir (un seul composant, mais un composant quand même).
    if (!classe_id || !ue_id || !ec_id || !Array.isArray(rows) || !rows.length || !motif?.trim()) return res.status(400).json({ message: 'classe_id, ue_id, ec_id, rows et motif sont requis.' });
    const annee = await getActiveYear(connection);
    await assertCanManageUe({ user: req.user, idue: Number(ue_id), idclasse: Number(classe_id), annee });
    if (req.user.role === 'ENSEIGNANT') {
      const [assignment] = await connection.query('SELECT 1 FROM teacher_ue_assignments WHERE user_id=? AND IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [req.user.id, classe_id, ue_id, annee]);
      if (!assignment[0]) return res.status(403).json({ message: 'UE non affectée à cet enseignant.' });
    }
    const context = await getUeContext(connection, Number(classe_id), Number(ue_id), annee, req.user.id);
    const [locks] = await connection.query('SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [classe_id, ue_id, annee]);
    if (locks[0] && locks[0].statut !== 'OPEN') return res.status(423).json({ message: 'UE verrouillée : les notes ne peuvent plus être modifiées.' });
    const [enrolledRows] = await connection.query('SELECT MATRICULE FROM Inscript WHERE IDCLASSE=? AND ANNEE=?', [classe_id, annee]);
    const enrolled = new Set(enrolledRows.map((row) => String(row.MATRICULE).toUpperCase()));
    const normalized = rows.map((row) => ({ ...row, matricule: String(row.matricule || '').trim().toUpperCase() }));
    if (normalized.some((row) => !enrolled.has(row.matricule))) return res.status(400).json({ message: 'Le fichier contient au moins un étudiant non inscrit dans cette classe.' });
    if (new Set(normalized.map((row) => row.matricule)).size !== normalized.length) return res.status(400).json({ message: 'Le fichier contient des matricules dupliqués.' });

    const isRattrapage = is_rattrapage === true || is_rattrapage === 'true';
    const targetSemester = isRattrapage ? (context.semestre === 1 ? 3 : 4) : context.semestre;

    const component = context.ecs.find((ec) => Number(ec.id) === Number(ec_id));
    if (!component) throw Object.assign(new Error('EC introuvable pour cette UE.'), { status: 400 });
    if (!component.evaluations.length) throw Object.assign(new Error('Cet EC n’a pas encore de types d’évaluation configurés (CC/TP/SN) : le configurer avant de saisir des notes.'), { status: 409 });

    const ecAuditRows = [];
    await connection.beginTransaction();

    // 1) Saisie des notes du composant EC ciblé (miroir ou réel — chemin unique).
    for (const row of normalized) {
      const [admitted] = await connection.query("SELECT 1 FROM Admission WHERE MATRICULE=? AND IDCLASSE=? AND ANNEE=? AND UPPER(TRIM(`DEC`))='ADMIS' LIMIT 1", [row.matricule, classe_id, annee]);
      if (admitted[0] && req.user.role !== 'SUPER_ADMIN') throw Object.assign(new Error(`Étudiant admis : modification interdite (${row.matricule}).`), { status: 403 });
      let total = 0; const values = {};
      for (const evaluation of component.evaluations) {
        const value = Number(row[evaluation.type]);
        if (!Number.isFinite(value) || value < 0 || value > Number(evaluation.echelle)) throw Object.assign(new Error(`Note ${evaluation.type} invalide pour ${row.matricule} : valeur attendue entre 0 et ${evaluation.echelle}.`), { status: 400 });
        values[evaluation.type] = value; total += value;
      }
      // round2 ici : total est une somme de 2-3 decimaux JS (CC+TP+SN),
      // potentiellement bruitee au-dela de la 2e decimale avant stockage.
      const moyenneEc = round2(total);
      const [previousEc] = await connection.query('SELECT * FROM notes WHERE IDEC=? AND MATRICULE=? AND IDCLASSE=? AND ANNEE=?', [component.id, row.matricule, classe_id, annee]);
      await connection.query('INSERT INTO notes (IDEC,MATRICULE,IDCLASSE,ANNEE,note_cc,note_tp,note_sn,moyenne_ec,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE note_cc=VALUES(note_cc),note_tp=VALUES(note_tp),note_sn=VALUES(note_sn),moyenne_ec=VALUES(moyenne_ec),updated_at=NOW()', [component.id, row.matricule, classe_id, annee, values.CC ?? null, values.TP ?? null, values.SN ?? null, moyenneEc]);
      ecAuditRows.push({ matricule: row.matricule, oldValues: previousEc[0] || {}, newValues: { ...values, moyenne_ec: moyenneEc } });
    }

    // 2) Recalcul de la moyenne UE dès que TOUS les EC de l'UE ont une note
    // pour l'étudiant (y compris le cas trivial à 1 seul EC : moyenne_ue =
    // moyenne_ec). Pondération par e.poids (ex-credit) entre EC.
    //
    // Le SUM(poids*moyenne_ec)/SUM(poids) est calculé PAR MYSQL (arithmétique
    // DECIMAL exacte, base 10), pas en JS : c'est l'opération la plus à
    // risque de bruit binaire (division), donc la seule qu'on ne fait
    // surtout pas nous-mêmes.
    for (const row of normalized) {
      const [[aggregate]] = await connection.query(
        `SELECT SUM(e.poids * n.moyenne_ec) / SUM(e.poids) AS moyenne_ue,
                SUM(CASE WHEN n.moyenne_ec IS NULL THEN 1 ELSE 0 END) AS manquants
           FROM ec e
           LEFT JOIN notes n ON n.IDEC = e.IDEC AND n.MATRICULE = ? AND n.IDCLASSE = ? AND n.ANNEE = ?
          WHERE e.IDUE = ?`,
        [row.matricule, classe_id, annee, ue_id]
      );
      if (Number(aggregate.manquants) > 0 || aggregate.moyenne_ue === null) continue;
      // round2 final : MySQL renvoie déjà une valeur DECIMAL exacte (scale
      // étendue par la division), on ne fait que la ramener proprement à
      // 2 décimales pour le stockage/l'audit.
      const moyenneUe = round2(aggregate.moyenne_ue);

      const [previousMoy] = await connection.query('SELECT * FROM Moyennes WHERE MATRICULE=? AND IDUE=? AND IDSEMESTRE=? AND ANNEE=?', [row.matricule, ue_id, targetSemester, annee]);
      // Note : Moyennes.CREDIT est de toute façon recalculé par un trigger
      // BEFORE INSERT/UPDATE depuis Programme.CREDIT — la valeur envoyée
      // ici (context.credit) est écrasée si elle diverge, "le programme fait loi".
      await connection.query('INSERT INTO Moyennes (MATRICULE,IDUE,IDSEMESTRE,ANNEE,MOYENNE,CREDIT,created_at,updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE MOYENNE=VALUES(MOYENNE),CREDIT=VALUES(CREDIT),updated_at=NOW()', [row.matricule, ue_id, targetSemester, annee, moyenneUe, context.credit]);
      await connection.query('INSERT INTO moyenne_audit (MATRICULE,IDUE,IDSEMESTRE,ANNEE,action,old_values,new_values,motif,user_id) VALUES (?,?,?,?,?,?,?,?,?)', [row.matricule, ue_id, targetSemester, annee, previousMoy[0] ? 'UPDATE' : 'CREATE', JSON.stringify(previousMoy[0] || null), JSON.stringify({ moyenne: moyenneUe, credit: context.credit }), `Recalcul automatique depuis EC (${motif.trim()})`, req.user.id]);
    }

    await connection.commit();
    for (const row of ecAuditRows) await audit({ user: req.user, action: row.oldValues.IDEC ? 'UPDATE' : 'CREATE', module: 'NOTES', resourceType: 'notes', resourceId: ec_id, description: motif.trim(), oldValues: row.oldValues, newValues: row.newValues, request: req });
    await audit({ user: req.user, action: 'IMPORT', module: 'NOTES', resourceType: 'notes', resourceId: ec_id, description: motif.trim(), newValues: { classe_id, ue_id, ec_id, annee, lignes: normalized.length }, request: req });
    res.json({ success: true, annee, saved: normalized.length, mode: context.mode, missing: isRattrapage ? 0 : await getCompletion(connection, Number(classe_id), Number(ue_id), annee) });
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

router.get('/assignment-options', requirePermission('users.manage_permissions'), async (req, res, next) => {
  try {
    const active = await query('SELECT annee FROM academic_years WHERE est_active=1 LIMIT 1');
    const annee = Number(req.query.annee || active[0]?.annee);
    if (!annee) return res.status(409).json({ message: 'Aucune année académique active.' });
    const classeId = req.query.classe_id ? Number(req.query.classe_id) : null;
    const [years, classes, ues, assignments] = await Promise.all([
      query('SELECT annee, est_active FROM academic_years ORDER BY annee DESC'),
      query(`SELECT c.IDCLASSE, c.NIVEAU, f.NOM AS FILIERE, s.INTITULE AS SPECIALITE
             FROM Classe c
             LEFT JOIN Filiere f ON f.IDFILIERE=c.IDFILIERE
             LEFT JOIN Specialite s ON s.IDSPECIALITE=c.IDSPECIALITE
             ORDER BY f.NOM, c.NIVEAU, c.IDCLASSE`),
      query(`SELECT DISTINCT p.IDUE, u.CODUE, u.INTITULE, p.CREDIT
             FROM Programme p JOIN UE u ON u.IDUE=p.IDUE
             WHERE p.ANNEE=? ${classeId ? 'AND p.IDCLASSE=?' : ''}
             ORDER BY u.CODUE, u.INTITULE`, classeId ? [annee, classeId] : [annee]),
      query(`SELECT a.id, a.user_id, a.IDCLASSE, a.IDUE, a.ANNEE, u.name AS enseignant,
                    ue.CODUE, ue.INTITULE, c.NIVEAU, f.NOM AS FILIERE, s.INTITULE AS SPECIALITE
             FROM teacher_ue_assignments a
             JOIN users u ON u.id=a.user_id
             JOIN UE ue ON ue.IDUE=a.IDUE
             JOIN Classe c ON c.IDCLASSE=a.IDCLASSE
             LEFT JOIN Filiere f ON f.IDFILIERE=c.IDFILIERE
             LEFT JOIN Specialite s ON s.IDSPECIALITE=c.IDSPECIALITE
             WHERE a.ANNEE=?
             ORDER BY f.NOM, c.NIVEAU, ue.CODUE, u.name`, [annee]),
    ]);
    res.json({ activeYear: Number(active[0]?.annee || annee), years, classes, ues, assignments });
  } catch (error) { next(error); }
});

router.post('/assignments', requirePermission('users.manage_permissions'), async (req, res, next) => {
  try {
    const { user_id, classe_id, ue_id, annee } = req.body;
    if (!user_id || !classe_id || !ue_id || !annee) return res.status(400).json({ message: 'user_id, classe_id, ue_id et annee requis.' });
    const existing = await query(`SELECT a.id, u.name AS enseignant FROM teacher_ue_assignments a
                                  JOIN users u ON u.id=a.user_id
                                  WHERE a.IDCLASSE=? AND a.IDUE=? AND a.ANNEE=? LIMIT 1`, [classe_id, ue_id, annee]);
    if (existing[0]) return res.status(409).json({ message: `Cette UE est déjà affectée à ${existing[0].enseignant || 'un enseignant'} pour cette classe et cette année.` });
    await query('INSERT IGNORE INTO teacher_ue_assignments (user_id,IDCLASSE,IDUE,ANNEE,assigned_by,created_at,updated_at) VALUES (?,?,?,?,?,NOW(),NOW())', [user_id, classe_id, ue_id, annee, req.user.id]);
    await audit({ user: req.user, action: 'ASSIGN', module: 'ADMIN', resourceType: 'teacher_ue_assignments', resourceId: null, description: 'Affectation enseignant UE', newValues: { user_id, classe_id, ue_id, annee }, request: req });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.delete('/assignments/:id', requirePermission('users.manage_permissions'), async (req, res, next) => {
  try {
    const assignments = await query('SELECT * FROM teacher_ue_assignments WHERE id=? LIMIT 1', [req.params.id]);
    if (!assignments[0]) return res.status(404).json({ message: 'Affectation introuvable.' });
    await query('DELETE FROM teacher_ue_assignments WHERE id=?', [req.params.id]);
    await audit({ user: req.user, action: 'REVOKE', module: 'ADMIN', resourceType: 'teacher_ue_assignments', resourceId: req.params.id, description: 'Révocation affectation enseignant UE', oldValues: assignments[0], request: req });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/submit', requirePermission('ue_notes.submit'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { classe_id, ue_id } = req.body;
    if (!classe_id || !ue_id) return res.status(400).json({ message: 'classe_id et ue_id requis.' });
    const active = (await connection.query('SELECT annee FROM academic_years WHERE est_active=1 LIMIT 1'))[0][0];
    if (!active) return res.status(409).json({ message: 'Aucune année active.' });
    if (req.user.role === 'ENSEIGNANT') {
      const assigned = (await connection.query('SELECT 1 FROM teacher_ue_assignments WHERE user_id=? AND IDCLASSE=? AND IDUE=? AND ANNEE=?', [req.user.id, classe_id, ue_id, active.annee]))[0];
      if (!assigned.length) return res.status(403).json({ message: 'UE non affectée à cet enseignant.' });
    }
    const [lock] = await connection.query('SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [classe_id, ue_id, active.annee]);
    if (lock[0] && lock[0].statut !== 'OPEN') return res.status(423).json({ message: 'Cette UE est déjà soumise et verrouillée.' });
    await getUeContext(connection, Number(classe_id), Number(ue_id), Number(active.annee), req.user.id);
    const [roster] = await connection.query('SELECT COUNT(*) AS total FROM Inscript WHERE IDCLASSE=? AND ANNEE=?', [classe_id, active.annee]);
    if (!Number(roster[0].total)) return res.status(409).json({ message: 'Soumission impossible : aucun étudiant n’est inscrit dans cette classe pour l’année active.' });
    const missing = await getCompletion(connection, Number(classe_id), Number(ue_id), Number(active.annee));
    if (missing > 0) return res.status(409).json({ message: `Soumission impossible : ${missing} note(s) obligatoire(s) manquante(s).`, missing });
    await connection.beginTransaction();
    await connection.query(`INSERT INTO ue_class_locks (IDCLASSE,IDUE,ANNEE,statut,motif,locked_by,locked_at,created_at,updated_at)
      VALUES (?,?,'${active.annee}','LOCKED','Soumission par l’enseignant',?,NOW(),NOW(),NOW())
      ON DUPLICATE KEY UPDATE statut='LOCKED',motif=VALUES(motif),locked_by=VALUES(locked_by),locked_at=NOW(),updated_at=NOW()`, [classe_id, ue_id, req.user.id]);
    await connection.commit();
    await audit({ user: req.user, action: 'SUBMIT', module: 'SOUMISSION', resourceType: 'ue_class_locks', resourceId: null, description: 'Soumission et verrouillage UE', newValues: { classe_id, ue_id, annee: active.annee }, request: req });
    res.json({ success: true, annee: active.annee, statut: 'LOCKED' });
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});
module.exports = router;