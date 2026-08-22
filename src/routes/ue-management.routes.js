const express = require('express');
const { pool, query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');

const router = express.Router();
router.use(authenticateToken, requirePermission('ue_ec.manage'));

async function getUe(id) {
  return (await query('SELECT * FROM UE WHERE IDUE=? LIMIT 1', [id]))[0];
}

function validateEvaluationScales(evaluations) {
  if (!Array.isArray(evaluations) || !evaluations.length) throw Object.assign(new Error('Au moins une évaluation est requise.'), { status: 400 });
  const types = new Set();
  let total = 0;
  for (const item of evaluations) {
    const echelle = Number(item.echelle);
    if (!['CC', 'TP', 'SN'].includes(item.type) || types.has(item.type) || !Number.isFinite(echelle) || echelle <= 0 || echelle > 100) {
      throw Object.assign(new Error('Chaque évaluation CC, TP ou SN doit avoir un barème strictement positif, au plus égal à 100.'), { status: 400 });
    }
    types.add(item.type);
    total += echelle;
  }
  if (Math.abs(total - 100) > 0.001) throw Object.assign(new Error(`La somme des barèmes doit être exactement 100 (actuellement ${total}).`), { status: 400 });
}

router.get('/options', async (req, res, next) => {
  try {
    const [filieres, years, classes] = await Promise.all([
      query('SELECT IDFILIERE,CODFILIERE,NOM FROM Filiere ORDER BY NOM'),
      query('SELECT annee,est_active FROM academic_years ORDER BY annee DESC'),
      query(`SELECT c.IDCLASSE,c.NIVEAU,f.NOM AS FILIERE FROM Classe c
             LEFT JOIN Filiere f ON f.IDFILIERE=c.IDFILIERE ORDER BY f.NOM,c.NIVEAU,c.IDCLASSE`),
    ]);
    res.json({ filieres, years, classes });
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const annee = req.query.annee ? Number(req.query.annee) : null;
    const filiere = req.query.filiere ? Number(req.query.filiere) : null;
    const filters = []; const params = [];
    if (search) { filters.push('(u.CODUE LIKE ? OR u.INTITULE LIKE ? OR u.TITLE LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (annee) { filters.push('u.ANNEE=?'); params.push(annee); }
    if (filiere) { filters.push('u.IDFILIERE=?'); params.push(filiere); }
    const rows = await query(`SELECT u.IDUE,u.IDFILIERE,u.CODUE,u.INTITULE,u.TITLE,u.ANNEE,
      f.NOM AS FILIERE, f.CODFILIERE, COUNT(DISTINCT e.IDEC) AS ec_count, COUNT(DISTINCT p.IDCLASSE) AS programme_count
      FROM UE u LEFT JOIN Filiere f ON f.IDFILIERE=u.IDFILIERE
      LEFT JOIN ec e ON e.IDUE=u.IDUE LEFT JOIN Programme p ON p.IDUE=u.IDUE AND p.ANNEE=u.ANNEE
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      GROUP BY u.IDUE,u.IDFILIERE,u.CODUE,u.INTITULE,u.TITLE,u.ANNEE,f.NOM,f.CODFILIERE
      ORDER BY u.ANNEE DESC,u.CODUE,u.INTITULE`, params);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { code, intitule, title, filiere_id, annee } = req.body;
    if (!code?.trim() || !intitule?.trim() || !annee) return res.status(400).json({ message: 'code, intitule et annee sont requis.' });
    if (String(code).trim().length > 10) return res.status(400).json({ message: 'Le code UE ne doit pas dépasser 10 caractères.' });
    await connection.beginTransaction();
    const [ids] = await connection.query('SELECT COALESCE(MAX(IDUE),0)+1 AS id FROM UE FOR UPDATE');
    const id = Number(ids[0].id);
    await connection.query('INSERT INTO UE (IDUE,IDFILIERE,CODUE,INTITULE,TITLE,ANNEE,created_at,updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW())', [id, filiere_id || null, String(code).trim().toUpperCase(), intitule.trim(), title?.trim() || null, annee]);
    await connection.commit();
    const created = (await query('SELECT * FROM UE WHERE IDUE=?', [id]))[0];
    await audit({ user:req.user, action:'CREATE', module:'STRUCTURE', resourceType:'UE', resourceId:id, description:'Création UE', newValues:created, request:req });
    res.status(201).json(created);
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const previous = await getUe(req.params.id);
    if (!previous) return res.status(404).json({ message: 'UE introuvable.' });
    const { code, intitule, title, filiere_id, annee } = req.body;
    if (!code?.trim() || !intitule?.trim() || !annee) return res.status(400).json({ message: 'code, intitule et annee sont requis.' });
    await query('UPDATE UE SET IDFILIERE=?,CODUE=?,INTITULE=?,TITLE=?,ANNEE=?,updated_at=NOW() WHERE IDUE=?', [filiere_id || null, String(code).trim().toUpperCase(), intitule.trim(), title?.trim() || null, annee, req.params.id]);
    const current = await getUe(req.params.id);
    await audit({ user:req.user, action:'UPDATE', module:'STRUCTURE', resourceType:'UE', resourceId:req.params.id, description:'Modification UE', oldValues:previous, newValues:current, request:req });
    res.json(current);
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const previous = await getUe(req.params.id);
    if (!previous) return res.status(404).json({ message: 'UE introuvable.' });
    const [usage] = await query(`SELECT
      (SELECT COUNT(*) FROM Programme WHERE IDUE=?) AS programmes,
      (SELECT COUNT(*) FROM Moyennes WHERE IDUE=?) AS moyennes,
      (SELECT COUNT(*) FROM ec WHERE IDUE=?) AS ecs`, [req.params.id, req.params.id, req.params.id]);
    if (Number(usage.programmes) || Number(usage.moyennes) || Number(usage.ecs)) return res.status(409).json({ message: 'Suppression impossible : cette UE est déjà utilisée dans une maquette, des notes ou des EC.' });
    await query('DELETE FROM UE WHERE IDUE=?', [req.params.id]);
    await audit({ user:req.user, action:'DELETE', module:'STRUCTURE', resourceType:'UE', resourceId:req.params.id, description:'Suppression UE', oldValues:previous, request:req });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get('/:id/components', async (req, res, next) => {
  try {
    const components = await query(`SELECT e.IDEC,e.INTITULE,e.CREDIT,e.est_actif,
      JSON_ARRAYAGG(JSON_OBJECT('type',t.type,'echelle',t.echelle)) AS evaluations
      FROM ec e LEFT JOIN ec_evaluation_types t ON t.IDEC=e.IDEC WHERE e.IDUE=?
      GROUP BY e.IDEC,e.INTITULE,e.CREDIT,e.est_actif ORDER BY e.IDEC`, [req.params.id]);
    res.json(components);
  } catch (error) { next(error); }
});

router.get('/:id/semesters', async (req, res, next) => {
  try {
    const rows = await query(`SELECT p.IDCLASSE,p.IDUE,p.ANNEE,p.CREDIT,p.CATEGORIE,ps.IDSEMESTRE,
      c.NIVEAU,f.NOM AS FILIERE
      FROM Programme p JOIN Classe c ON c.IDCLASSE=p.IDCLASSE
      LEFT JOIN Filiere f ON f.IDFILIERE=c.IDFILIERE
      LEFT JOIN programme_semestres ps ON ps.IDCLASSE=p.IDCLASSE AND ps.IDUE=p.IDUE AND ps.ANNEE=p.ANNEE
      WHERE p.IDUE=? ORDER BY p.ANNEE DESC,f.NOM,c.NIVEAU,p.IDCLASSE`, [req.params.id]);
    res.json(rows);
  } catch (error) { next(error); }
});

router.put('/:id/semesters', async (req, res, next) => {
  try {
    const { classe_id, annee, semestre } = req.body;
    if (!classe_id || !annee || !semestre) return res.status(400).json({ message:'classe_id, annee et semestre sont requis.' });
    if (!Number.isInteger(Number(semestre)) || Number(semestre) < 1 || Number(semestre) > 2) return res.status(400).json({ message:'Le semestre doit être compris entre 1 et 2.' });
    const [programme] = await query('SELECT 1 FROM Programme WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [classe_id, req.params.id, annee]);
    if (!programme) return res.status(409).json({ message:'Cette UE n’est pas présente dans la maquette de cette classe et année.' });
    const previous = (await query('SELECT * FROM programme_semestres WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?', [classe_id, req.params.id, annee]))[0] || null;
    await query('INSERT INTO programme_semestres (IDCLASSE,IDUE,ANNEE,IDSEMESTRE,created_at,updated_at) VALUES (?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE IDSEMESTRE=VALUES(IDSEMESTRE),updated_at=NOW()', [classe_id, req.params.id, annee, semestre]);
    await audit({ user:req.user, action:previous ? 'UPDATE' : 'CREATE', module:'STRUCTURE', resourceType:'programme_semestres', resourceId:null, description:'Paramétrage semestre UE', oldValues:previous || {}, newValues:{ classe_id, ue_id:Number(req.params.id), annee, semestre:Number(semestre) }, request:req });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/:id/components', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { intitule, credit, evaluations } = req.body;
    if (!Number(credit)) return res.status(400).json({ message: 'credit requis.' });
    validateEvaluationScales(evaluations);
    const ue = await getUe(req.params.id); if (!ue) return res.status(404).json({ message:'UE introuvable.' });
    const [limits] = await connection.query('SELECT MIN(CREDIT) AS credit_max FROM Programme WHERE IDUE=? AND ANNEE=?', [req.params.id, ue.ANNEE]);
    const [used] = await connection.query('SELECT COALESCE(SUM(CREDIT),0) AS total FROM ec WHERE IDUE=?', [req.params.id]);
    if (limits[0].credit_max !== null && Number(used[0].total) + Number(credit) > Number(limits[0].credit_max)) return res.status(409).json({ message: `Crédits EC trop élevés : maximum disponible ${Number(limits[0].credit_max) - Number(used[0].total)}.` });
    await connection.beginTransaction();
    const [created] = await connection.query('INSERT INTO ec (IDUE,INTITULE,CREDIT,created_at,updated_at) VALUES (?,?,?,?,NOW())', [req.params.id, intitule?.trim() || null, credit, new Date()]);
    for (const evaluation of evaluations) await connection.query('INSERT INTO ec_evaluation_types (IDEC,type,echelle) VALUES (?,?,?)', [created.insertId, evaluation.type, evaluation.echelle]);
    await connection.commit();
    await audit({ user:req.user, action:'CREATE', module:'STRUCTURE', resourceType:'ec', resourceId:created.insertId, description:'Création EC', newValues:{ ue_id:req.params.id,intitule,credit,evaluations }, request:req });
    res.status(201).json({ id:created.insertId });
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

router.put('/:id/components/:componentId', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { intitule, credit, evaluations } = req.body;
    if (!Number(credit)) return res.status(400).json({ message: 'credit requis.' });
    validateEvaluationScales(evaluations);
    const [previousRows] = await connection.query('SELECT * FROM ec WHERE IDEC=? AND IDUE=?', [req.params.componentId, req.params.id]);
    if (!previousRows[0]) return res.status(404).json({ message:'EC introuvable.' });
    const [notes] = await connection.query('SELECT COUNT(*) AS total FROM ec_notes WHERE IDEC=?', [req.params.componentId]);
    if (Number(notes[0].total)) return res.status(409).json({ message:'Modification impossible : cet EC possède déjà des notes.' });
    const ue = await getUe(req.params.id);
    const [limits] = await connection.query('SELECT MIN(CREDIT) AS credit_max FROM Programme WHERE IDUE=? AND ANNEE=?', [req.params.id, ue.ANNEE]);
    const [used] = await connection.query('SELECT COALESCE(SUM(CREDIT),0) AS total FROM ec WHERE IDUE=? AND IDEC<>?', [req.params.id, req.params.componentId]);
    if (limits[0].credit_max !== null && Number(used[0].total) + Number(credit) > Number(limits[0].credit_max)) return res.status(409).json({ message: `Crédits EC trop élevés : maximum disponible ${Number(limits[0].credit_max) - Number(used[0].total)}.` });
    await connection.beginTransaction();
    await connection.query('UPDATE ec SET INTITULE=?,CREDIT=?,updated_at=NOW() WHERE IDEC=?', [intitule?.trim() || null, credit, req.params.componentId]);
    await connection.query('DELETE FROM ec_evaluation_types WHERE IDEC=?', [req.params.componentId]);
    for (const evaluation of evaluations) await connection.query('INSERT INTO ec_evaluation_types (IDEC,type,echelle) VALUES (?,?,?)', [req.params.componentId, evaluation.type, evaluation.echelle]);
    await connection.commit();
    await audit({ user:req.user, action:'UPDATE', module:'STRUCTURE', resourceType:'ec', resourceId:req.params.componentId, description:'Modification EC', oldValues:previousRows[0], newValues:{intitule,credit,evaluations}, request:req });
    res.status(204).end();
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

router.delete('/:id/components/:componentId', async (req, res, next) => {
  try {
    const [notes] = await query('SELECT COUNT(*) AS total FROM ec_notes WHERE IDEC=?', [req.params.componentId]);
    if (Number(notes.total)) return res.status(409).json({ message: 'Suppression impossible : cet EC possède déjà des notes.' });
    const [component] = await query('SELECT * FROM ec WHERE IDEC=? AND IDUE=?', [req.params.componentId, req.params.id]);
    if (!component) return res.status(404).json({ message: 'EC introuvable.' });
    await query('DELETE FROM ec WHERE IDEC=?', [req.params.componentId]);
    await audit({ user:req.user, action:'DELETE', module:'STRUCTURE', resourceType:'ec', resourceId:req.params.componentId, description:'Suppression EC', oldValues:component, request:req });
    res.status(204).end();
  } catch (error) { next(error); }
});

module.exports = router;
