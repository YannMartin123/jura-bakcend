const express = require('express');
const { pool, query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const { assertCanManageUe } = require('../middleware/ue-assignment');
const router = express.Router();
router.use(authenticateToken);

async function getActiveYear(connection = null) {
  const executor = connection || { query: async (sql, params) => [await query(sql, params)] };
  const [years] = await executor.query('SELECT annee FROM academic_years WHERE est_active=1 LIMIT 1');
  if (!years[0]) throw Object.assign(new Error('Aucune année académique active.'), { status: 409 });
  return Number(years[0].annee);
}

async function getUeContext(connection, classeId, ueId, annee) {
  const [programme] = await connection.query(`SELECT p.CREDIT, ps.IDSEMESTRE
    FROM Programme p LEFT JOIN programme_semestres ps ON ps.IDCLASSE=p.IDCLASSE AND ps.IDUE=p.IDUE AND ps.ANNEE=p.ANNEE
    WHERE p.IDCLASSE=? AND p.IDUE=? AND p.ANNEE=? LIMIT 1`, [classeId, ueId, annee]);
  if (!programme[0] || !programme[0].IDSEMESTRE) throw Object.assign(new Error('Cette UE n’est pas correctement programmée (semestre manquant).'), { status: 409 });
  const [ecRows] = await connection.query(`SELECT e.IDEC, e.INTITULE, e.CREDIT, t.type, t.echelle
    FROM ec e LEFT JOIN ec_evaluation_types t ON t.IDEC=e.IDEC WHERE e.IDUE=? ORDER BY e.IDEC, t.type`, [ueId]);
  const components = new Map();
  ecRows.forEach((row) => {
    if (!components.has(row.IDEC)) components.set(row.IDEC, { id: row.IDEC, intitule: row.INTITULE, credit: Number(row.CREDIT), evaluations: [] });
    if (row.type) components.get(row.IDEC).evaluations.push({ type: row.type, echelle: Number(row.echelle) });
  });
  const ecs = [...components.values()];
  // Sans EC configuré, la note UE est saisie directement. Dès qu'un EC existe,
  // ses évaluations (CC/TP/SN) sont saisies puis la note UE est calculée.
  const mode = ecs.length > 0 ? 'MULTIPLE' : 'SINGLE';
  return { credit: Number(programme[0].CREDIT), semestre: programme[0].IDSEMESTRE, mode, ecs };
}

async function getCompletion(connection, classeId, ueId, annee, context) {
  if (context.mode === 'SINGLE') {
    const [missing] = await connection.query(`SELECT COUNT(*) AS total FROM Inscript i LEFT JOIN Moyennes m
      ON m.MATRICULE=i.MATRICULE AND m.IDUE=? AND m.IDSEMESTRE=? AND m.ANNEE=?
      WHERE i.IDCLASSE=? AND i.ANNEE=? AND m.MATRICULE IS NULL`, [ueId, context.semestre, annee, classeId, annee]);
    return Number(missing[0].total);
  }
  const [missing] = await connection.query(`SELECT COUNT(*) AS total FROM Inscript i CROSS JOIN ec e LEFT JOIN ec_notes n
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
    const [assignment] = await connection.query('SELECT 1 FROM teacher_ue_assignments WHERE user_id=? AND IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [req.user.id, classeId, ueId, annee]);
    if (!assignment[0] && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'UE non affectée à cet enseignant.' });
    const context = await getUeContext(connection, classeId, ueId, annee);
    
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
        FROM ec_notes n JOIN ec e ON e.IDEC=n.IDEC WHERE e.IDUE=? AND n.IDCLASSE=? AND n.ANNEE=?`, [ueId, classeId, annee]),
    ]);
    const notesByStudent = {};
    ecNotes[0].forEach((note) => { if (!notesByStudent[note.MATRICULE]) notesByStudent[note.MATRICULE] = {}; notesByStudent[note.MATRICULE][note.IDEC] = note; });
    const missing = isRattrapage ? 0 : await getCompletion(connection, classeId, ueId, annee, targetContext);
    res.json({ annee, classe_id: classeId, ue: ueRows[0][0], locked: locks[0][0]?.statut && locks[0][0].statut !== 'OPEN', context: targetContext, students: students[0].map((student) => ({ ...student, ec_notes: notesByStudent[student.MATRICULE] || {} })), missing });
  } catch (error) { next(error); } finally { connection.release(); }
});

router.put('/gradebook', requirePermission('ue_notes.write'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { classe_id, ue_id, ec_id, rows, motif, is_rattrapage } = req.body;
    if (!classe_id || !ue_id || !Array.isArray(rows) || !rows.length || !motif?.trim()) return res.status(400).json({ message: 'classe_id, ue_id, rows et motif sont requis.' });
    const annee = await getActiveYear(connection);
    await assertCanManageUe({ user: req.user, idue: Number(ue_id), idclasse: Number(classe_id), annee });
    const [assignment] = await connection.query('SELECT 1 FROM teacher_ue_assignments WHERE user_id=? AND IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [req.user.id, classe_id, ue_id, annee]);
    if (!assignment[0] && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'UE non affectée à cet enseignant.' });
    const context = await getUeContext(connection, Number(classe_id), Number(ue_id), annee);
    const [locks] = await connection.query('SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [classe_id, ue_id, annee]);
    if (locks[0] && locks[0].statut !== 'OPEN') return res.status(423).json({ message: 'UE verrouillée : les notes ne peuvent plus être modifiées.' });
    const [enrolledRows] = await connection.query('SELECT MATRICULE FROM Inscript WHERE IDCLASSE=? AND ANNEE=?', [classe_id, annee]);
    const enrolled = new Set(enrolledRows.map((row) => String(row.MATRICULE).toUpperCase()));
    const normalized = rows.map((row) => ({ ...row, matricule: String(row.matricule || '').trim().toUpperCase() }));
    if (normalized.some((row) => !enrolled.has(row.matricule))) return res.status(400).json({ message: 'Le fichier contient au moins un étudiant non inscrit dans cette classe.' });
    if (new Set(normalized.map((row) => row.matricule)).size !== normalized.length) return res.status(400).json({ message: 'Le fichier contient des matricules dupliqués.' });
    
    const isRattrapage = is_rattrapage === true || is_rattrapage === 'true';
    const targetSemester = isRattrapage ? (context.semestre === 1 ? 3 : 4) : context.semestre;
    const targetContext = { ...context, semestre: targetSemester };

    const ecAuditRows = [];
    await connection.beginTransaction();
    if (context.mode === 'SINGLE') {
      for (const row of normalized) {
        const moyenne = Number(row.moyenne);
        if (!Number.isFinite(moyenne) || moyenne < 0 || moyenne > 100) throw Object.assign(new Error(`Note UE invalide pour ${row.matricule}.`), { status: 400 });
        const [admitted] = await connection.query("SELECT 1 FROM Admission WHERE MATRICULE=? AND IDCLASSE=? AND ANNEE=? AND UPPER(TRIM(`DEC`))='ADMIS' LIMIT 1", [row.matricule, classe_id, annee]);
        if (admitted[0] && req.user.role !== 'SUPER_ADMIN') throw Object.assign(new Error(`Étudiant admis : modification interdite (${row.matricule}).`), { status: 403 });
        const [previous] = await connection.query('SELECT * FROM Moyennes WHERE MATRICULE=? AND IDUE=? AND IDSEMESTRE=? AND ANNEE=?', [row.matricule, ue_id, targetSemester, annee]);
        await connection.query('INSERT INTO Moyennes (MATRICULE,IDUE,IDSEMESTRE,ANNEE,MOYENNE,CREDIT,created_at,updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE MOYENNE=VALUES(MOYENNE),CREDIT=VALUES(CREDIT),updated_at=NOW()', [row.matricule, ue_id, targetSemester, annee, moyenne, context.credit]);
        await connection.query('INSERT INTO moyenne_audit (MATRICULE,IDUE,IDSEMESTRE,ANNEE,action,old_values,new_values,motif,user_id) VALUES (?,?,?,?,?,?,?,?,?)', [row.matricule, ue_id, targetSemester, annee, previous[0] ? 'UPDATE' : 'CREATE', JSON.stringify(previous[0] || null), JSON.stringify({ moyenne, credit: context.credit }), motif.trim(), req.user.id]);
      }
    } else {
      const component = context.ecs.find((ec) => Number(ec.id) === Number(ec_id));
      if (!component) throw Object.assign(new Error('EC requis pour cette UE composée.'), { status: 400 });
      for (const row of normalized) {
        const [admitted] = await connection.query("SELECT 1 FROM Admission WHERE MATRICULE=? AND IDCLASSE=? AND ANNEE=? AND UPPER(TRIM(`DEC`))='ADMIS' LIMIT 1", [row.matricule, classe_id, annee]);
        if (admitted[0] && req.user.role !== 'SUPER_ADMIN') throw Object.assign(new Error(`Étudiant admis : modification interdite (${row.matricule}).`), { status: 403 });
        let total = 0; const values = {};
        for (const evaluation of component.evaluations) {
          const value = Number(row[evaluation.type]);
          if (!Number.isFinite(value) || value < 0 || value > Number(evaluation.echelle)) throw Object.assign(new Error(`Note ${evaluation.type} invalide pour ${row.matricule} : valeur attendue entre 0 et ${evaluation.echelle}.`), { status: 400 });
          values[evaluation.type] = value; total += value;
        }
        const moyenneEc = total;
        const [previousEc] = await connection.query('SELECT * FROM ec_notes WHERE IDEC=? AND MATRICULE=? AND IDCLASSE=? AND ANNEE=?', [component.id, row.matricule, classe_id, annee]);
        await connection.query('INSERT INTO ec_notes (IDEC,MATRICULE,IDCLASSE,ANNEE,note_cc,note_tp,note_sn,moyenne_ec,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE note_cc=VALUES(note_cc),note_tp=VALUES(note_tp),note_sn=VALUES(note_sn),moyenne_ec=VALUES(moyenne_ec),updated_at=NOW()', [component.id, row.matricule, classe_id, annee, values.CC ?? null, values.TP ?? null, values.SN ?? null, moyenneEc]);
        ecAuditRows.push({ matricule:row.matricule, oldValues:previousEc[0] || {}, newValues:{ ...values, moyenne_ec:moyenneEc } });
      }
      for (const row of normalized) {
        const [allNotes] = await connection.query(`SELECT e.CREDIT,n.moyenne_ec FROM ec e LEFT JOIN ec_notes n ON n.IDEC=e.IDEC AND n.MATRICULE=? AND n.IDCLASSE=? AND n.ANNEE=? WHERE e.IDUE=?`, [row.matricule, classe_id, annee, ue_id]);
        if (allNotes.some((note) => note.moyenne_ec === null)) continue;
        const totalCredits = allNotes.reduce((sum, note) => sum + Number(note.CREDIT), 0);
        const moyenneUe = allNotes.reduce((sum, note) => sum + Number(note.CREDIT) * Number(note.moyenne_ec), 0) / totalCredits;
        await connection.query('INSERT INTO Moyennes (MATRICULE,IDUE,IDSEMESTRE,ANNEE,MOYENNE,CREDIT,created_at,updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE MOYENNE=VALUES(MOYENNE),CREDIT=VALUES(CREDIT),updated_at=NOW()', [row.matricule, ue_id, targetSemester, annee, moyenneUe, context.credit]);
      }
    }
    await connection.commit();
    for (const row of ecAuditRows) await audit({ user:req.user, action:row.oldValues.IDEC ? 'UPDATE' : 'CREATE', module:'NOTES', resourceType:'ec_notes', resourceId:ec_id, description:motif.trim(), oldValues:row.oldValues, newValues:row.newValues, request:req });
    await audit({ user:req.user, action:'IMPORT', module:'NOTES', resourceType:context.mode === 'SINGLE' ? 'Moyennes' : 'ec_notes', resourceId:ec_id || ue_id, description:motif.trim(), newValues:{ classe_id, ue_id, ec_id:ec_id || null, annee, lignes:normalized.length }, request:req });
    res.json({ success:true, annee, saved:normalized.length, mode:context.mode, missing: isRattrapage ? 0 : await getCompletion(connection, Number(classe_id), Number(ue_id), annee, targetContext) });
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
    await audit({ user:req.user, action:'ASSIGN', module:'ADMIN', resourceType:'teacher_ue_assignments', resourceId:null, description:'Affectation enseignant UE', newValues:{user_id,classe_id,ue_id,annee}, request:req });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.delete('/assignments/:id', requirePermission('users.manage_permissions'), async (req, res, next) => {
  try {
    const assignments = await query('SELECT * FROM teacher_ue_assignments WHERE id=? LIMIT 1', [req.params.id]);
    if (!assignments[0]) return res.status(404).json({ message: 'Affectation introuvable.' });
    await query('DELETE FROM teacher_ue_assignments WHERE id=?', [req.params.id]);
    await audit({ user:req.user, action:'REVOKE', module:'ADMIN', resourceType:'teacher_ue_assignments', resourceId:req.params.id, description:'Révocation affectation enseignant UE', oldValues:assignments[0], request:req });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/submit', requirePermission('ue_notes.submit'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { classe_id, ue_id } = req.body;
    if (!classe_id || !ue_id) return res.status(400).json({ message:'classe_id et ue_id requis.' });
    const active = (await connection.query('SELECT annee FROM academic_years WHERE est_active=1 LIMIT 1'))[0][0];
    if (!active) return res.status(409).json({ message:'Aucune année active.' });
    const assigned = (await connection.query('SELECT 1 FROM teacher_ue_assignments WHERE user_id=? AND IDCLASSE=? AND IDUE=? AND ANNEE=?', [req.user.id,classe_id,ue_id,active.annee]))[0];
    if (!assigned.length && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message:'UE non affectée à cet enseignant.' });
    const [lock] = await connection.query('SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [classe_id, ue_id, active.annee]);
    if (lock[0] && lock[0].statut !== 'OPEN') return res.status(423).json({ message: 'Cette UE est déjà soumise et verrouillée.' });
    const context = await getUeContext(connection, Number(classe_id), Number(ue_id), Number(active.annee));
    const [roster] = await connection.query('SELECT COUNT(*) AS total FROM Inscript WHERE IDCLASSE=? AND ANNEE=?', [classe_id, active.annee]);
    if (!Number(roster[0].total)) return res.status(409).json({ message: 'Soumission impossible : aucun étudiant n’est inscrit dans cette classe pour l’année active.' });
    const missing = await getCompletion(connection, Number(classe_id), Number(ue_id), Number(active.annee), context);
    if (missing > 0) return res.status(409).json({ message: `Soumission impossible : ${missing} note(s) obligatoire(s) manquante(s).`, missing });
    await connection.beginTransaction();
    await connection.query(`INSERT INTO ue_class_locks (IDCLASSE,IDUE,ANNEE,statut,motif,locked_by,locked_at,created_at,updated_at)
      VALUES (?,?,'${active.annee}','LOCKED','Soumission par l’enseignant',?,NOW(),NOW(),NOW())
      ON DUPLICATE KEY UPDATE statut='LOCKED',motif=VALUES(motif),locked_by=VALUES(locked_by),locked_at=NOW(),updated_at=NOW()`, [classe_id,ue_id,req.user.id]);
    await connection.commit();
    await audit({ user:req.user, action:'SUBMIT', module:'SOUMISSION', resourceType:'ue_class_locks', resourceId:null, description:'Soumission et verrouillage UE', newValues:{classe_id,ue_id,annee:active.annee}, request:req });
    res.json({ success:true, annee:active.annee, statut:'LOCKED' });
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});
module.exports = router;
