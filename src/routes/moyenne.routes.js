const express = require('express');
const { query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const router = express.Router();
router.use(authenticateToken);

async function assertWritable({ matricule, idue, idsemestre, annee, idclasse, user }) {
  const locks = await query("SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?", [idclasse, idue, annee]);
  if (locks[0] && locks[0].statut !== 'OPEN') { const error = new Error('UE verrouillée.'); error.status = 423; throw error; }
  const admitted = await query("SELECT 1 FROM Admission WHERE MATRICULE=? AND IDCLASSE=? AND ANNEE=? AND UPPER(TRIM(DEC))='ADMIS' LIMIT 1", [matricule, idclasse, annee]);
  if (admitted.length && user.role !== 'SUPER_ADMIN') { const error = new Error('Étudiant admis : correction réservée au super-administrateur.'); error.status = 403; throw error; }
  return admitted.length > 0;
}

router.put('/', requirePermission('ue_notes.write'), async (req, res, next) => {
  try {
    const { matricule, idue, idsemestre, annee, idclasse, moyenne, credit, motif } = req.body;
    if (!matricule || !idue || !idsemestre || !annee || !idclasse || moyenne === undefined || !credit || !motif?.trim()) return res.status(400).json({ message: 'matricule, idue, idsemestre, annee, idclasse, moyenne, credit et motif sont requis.' });
    if (!Number.isFinite(Number(moyenne)) || Number(moyenne) < 0 || Number(moyenne) > 100) return res.status(400).json({ message: 'La moyenne UE doit être entre 0 et 100.' });
    const previous = (await query('SELECT * FROM Moyennes WHERE MATRICULE=? AND IDUE=? AND IDSEMESTRE=? AND ANNEE=?', [matricule.toUpperCase(), idue, idsemestre, annee]))[0] || null;
    const isOverride = await assertWritable({ matricule: matricule.toUpperCase(), idue, idsemestre, annee, idclasse, user: req.user });
    if (isOverride && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Permission spéciale requise.' });
    await query(`INSERT INTO Moyennes (MATRICULE,IDUE,IDSEMESTRE,ANNEE,MOYENNE,CREDIT,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE MOYENNE=VALUES(MOYENNE), CREDIT=VALUES(CREDIT), updated_at=NOW()`, [matricule.toUpperCase(), idue, idsemestre, annee, moyenne, credit]);
    const current = (await query('SELECT * FROM Moyennes WHERE MATRICULE=? AND IDUE=? AND IDSEMESTRE=? AND ANNEE=?', [matricule.toUpperCase(), idue, idsemestre, annee]))[0];
    const action = isOverride ? 'OVERRIDE_ADMITTED' : previous ? 'UPDATE' : 'CREATE';
    await query('INSERT INTO moyenne_audit (MATRICULE,IDUE,IDSEMESTRE,ANNEE,action,old_values,new_values,motif,user_id) VALUES (?,?,?,?,?,?,?,?,?)', [matricule.toUpperCase(), idue, idsemestre, annee, action, JSON.stringify(previous), JSON.stringify(current), motif.trim(), req.user.id]);
    await audit({ user: req.user, action, module: 'NOTES', resourceType: 'Moyennes', resourceId: null, description: motif.trim(), oldValues: previous || {}, newValues: current, request: req });
    res.json(current);
  } catch (error) { next(error); }
});
module.exports = router;
