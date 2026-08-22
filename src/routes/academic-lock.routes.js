const express = require('express');
const { query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const router = express.Router();
router.use(authenticateToken);

router.get('/', async (req, res, next) => {
  try {
    const { classe_id, ue_id, annee } = req.query;
    const rows = await query('SELECT * FROM ue_class_locks WHERE (? IS NULL OR IDCLASSE = ?) AND (? IS NULL OR IDUE = ?) AND (? IS NULL OR ANNEE = ?)', [classe_id || null, classe_id || null, ue_id || null, ue_id || null, annee || null, annee || null]);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/lock', requirePermission('ue.lock'), async (req, res, next) => {
  try {
    const { classe_id, ue_id, annee, motif } = req.body;
    if (!classe_id || !ue_id || !annee || !motif?.trim()) return res.status(400).json({ message: 'classe_id, ue_id, annee et motif requis.' });
    await query(`INSERT INTO ue_class_locks (IDCLASSE, IDUE, ANNEE, statut, motif, locked_by, locked_at, created_at, updated_at)
      VALUES (?, ?, ?, 'LOCKED', ?, ?, NOW(), NOW(), NOW())
      ON DUPLICATE KEY UPDATE statut='LOCKED', motif=VALUES(motif), locked_by=VALUES(locked_by), locked_at=NOW(), unlocked_by=NULL, unlocked_at=NULL, updated_at=NOW()`, [classe_id, ue_id, annee, motif.trim(), req.user.id]);
    const row = (await query('SELECT * FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?', [classe_id, ue_id, annee]))[0];
    await audit({ user: req.user, action: 'LOCK', module: 'NOTES', resourceType: 'ue_class_locks', resourceId: row.id, description: motif.trim(), newValues: row, request: req });
    res.json(row);
  } catch (error) { next(error); }
});

router.post('/unlock', requirePermission('ue.unlock'), async (req, res, next) => {
  try {
    const { classe_id, ue_id, annee, motif } = req.body;
    if (!classe_id || !ue_id || !annee || !motif?.trim()) return res.status(400).json({ message: 'classe_id, ue_id, annee et motif requis.' });
    const old = (await query('SELECT * FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?', [classe_id, ue_id, annee]))[0];
    if (!old) return res.status(404).json({ message: 'Verrou introuvable.' });
    await query("UPDATE ue_class_locks SET statut='OPEN', motif=?, unlocked_by=?, unlocked_at=NOW(), updated_at=NOW() WHERE id=?", [motif.trim(), req.user.id, old.id]);
    const row = (await query('SELECT * FROM ue_class_locks WHERE id=?', [old.id]))[0];
    await audit({ user: req.user, action: 'UNLOCK', module: 'NOTES', resourceType: 'ue_class_locks', resourceId: row.id, description: motif.trim(), oldValues: old, newValues: row, request: req });
    res.json(row);
  } catch (error) { next(error); }
});
module.exports = router;
