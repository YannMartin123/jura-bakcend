const express = require('express');
const { query, pool } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const router = express.Router();
router.use(authenticateToken);

// Résumé des soumissions avec filtres avancés
router.get('/summary', async (req, res, next) => {
  try {
    const { annee, filiere_id, niveau, classe_id, search, statut } = req.query;
    if (!annee) {
      return res.status(400).json({ message: 'L\'année académique (annee) est requise.' });
    }

    let sql = `
      SELECT p.IDCLASSE, p.IDUE, p.ANNEE, p.CREDIT, p.CATEGORIE,
             c.NIVEAU, c.IDFILIERE, f.NOM AS FILIERE_NOM, f.CODFILIERE,
             u.CODUE, u.INTITULE AS UE_INTITULE,
             l.statut AS lock_status, l.motif AS lock_motif, l.locked_by, l.locked_at,
             (SELECT COUNT(*) FROM Inscript i WHERE i.IDCLASSE = p.IDCLASSE AND i.ANNEE = p.ANNEE) AS student_count,
             (SELECT COUNT(*) 
              FROM Moyennes m 
              JOIN Inscript i ON i.MATRICULE = m.MATRICULE AND i.ANNEE = m.ANNEE
              WHERE m.IDUE = p.IDUE 
                AND m.ANNEE = p.ANNEE 
                AND i.IDCLASSE = p.IDCLASSE) AS grade_count
      FROM Programme p
      JOIN Classe c ON c.IDCLASSE = p.IDCLASSE
      JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
      JOIN UE u ON u.IDUE = p.IDUE
      LEFT JOIN ue_class_locks l ON l.IDCLASSE = p.IDCLASSE AND l.IDUE = p.IDUE AND l.ANNEE = p.ANNEE
      WHERE p.ANNEE = ?
    `;
    const params = [Number(annee)];

    if (filiere_id) {
      sql += ' AND c.IDFILIERE = ?';
      params.push(Number(filiere_id));
    }
    if (niveau) {
      sql += ' AND c.NIVEAU = ?';
      params.push(niveau);
    }
    if (classe_id) {
      sql += ' AND c.IDCLASSE = ?';
      params.push(Number(classe_id));
    }
    if (search) {
      sql += ' AND (u.CODUE LIKE ? OR u.INTITULE LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY f.NOM, c.NIVEAU, u.CODUE';

    let rows = await query(sql, params);

    // Mappage des statuts
    rows = rows.map(row => {
      let calculatedStatus = 'non-importe';
      if (row.lock_status === 'LOCKED') {
        calculatedStatus = 'soumis';
      } else if (row.grade_count > 0) {
        calculatedStatus = 'importe';
      }
      return {
        ...row,
        status: calculatedStatus
      };
    });

    if (statut) {
      rows = rows.filter(row => row.status === statut);
    }

    res.json(rows);
  } catch (error) { next(error); }
});

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
router.post('/bulk', requirePermission('ue.lock'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { annee, filiere_id, niveau, classe_id, action, motif } = req.body;
    if (!annee || !action || !motif?.trim()) {
      return res.status(400).json({ message: 'annee, action et motif sont requis.' });
    }
    if (action !== 'LOCK' && action !== 'UNLOCK') {
      return res.status(400).json({ message: 'action doit être LOCK ou UNLOCK.' });
    }

    // Si action est UNLOCK, on vérifie l'autorisation explicite 'ue.unlock'
    if (action === 'UNLOCK' && !req.user.permissions.includes('ue.unlock') && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Permission non accordée pour déverrouiller.' });
    }

    // Sélectionner les programmes concernés par les filtres
    let sql = `
      SELECT p.IDCLASSE, p.IDUE
      FROM Programme p
      JOIN Classe c ON c.IDCLASSE = p.IDCLASSE
      WHERE p.ANNEE = ?
    `;
    const params = [Number(annee)];
    if (filiere_id) {
      sql += ' AND c.IDFILIERE = ?';
      params.push(Number(filiere_id));
    }
    if (niveau) {
      sql += ' AND c.NIVEAU = ?';
      params.push(niveau);
    }
    if (classe_id) {
      sql += ' AND c.IDCLASSE = ?';
      params.push(Number(classe_id));
    }

    const [targetUes] = await connection.query(sql, params);
    if (!targetUes.length) {
      return res.json({ affectedRows: 0, message: 'Aucune UE ne correspond aux critères.' });
    }

    await connection.beginTransaction();

    let affectedRows = 0;
    for (const item of targetUes) {
      if (action === 'LOCK') {
        await connection.query(
          `INSERT INTO ue_class_locks (IDCLASSE, IDUE, ANNEE, statut, motif, locked_by, locked_at, created_at, updated_at)
           VALUES (?, ?, ?, 'LOCKED', ?, ?, NOW(), NOW(), NOW())
           ON DUPLICATE KEY UPDATE statut='LOCKED', motif=VALUES(motif), locked_by=VALUES(locked_by), locked_at=NOW(), unlocked_by=NULL, unlocked_at=NULL, updated_at=NOW()`,
          [item.IDCLASSE, item.IDUE, annee, motif.trim(), req.user.id]
        );
      } else {
        // UNLOCK
        const [oldLock] = await connection.query('SELECT id FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=? LIMIT 1', [item.IDCLASSE, item.IDUE, annee]);
        if (oldLock[0]) {
          await connection.query(
            `UPDATE ue_class_locks SET statut='OPEN', motif=?, unlocked_by=?, unlocked_at=NOW(), updated_at=NOW() WHERE id=?`,
            [motif.trim(), req.user.id, oldLock[0].id]
          );
        }
      }
      affectedRows++;
    }

    await connection.commit();

    await audit({
      user: req.user,
      action: action === 'LOCK' ? 'BULK_LOCK' : 'BULK_UNLOCK',
      module: 'NOTES',
      resourceType: 'ue_class_locks',
      resourceId: null,
      description: `Bulk ${action} pour ${affectedRows} UE(s). Filtres: filiere=${filiere_id || 'all'}, niveau=${niveau || 'all'}, class=${classe_id || 'all'}. Motif: ${motif.trim()}`,
      newValues: { annee, filiere_id, niveau, classe_id, action, affectedRows },
      request: req
    });

    res.json({ success: true, affectedRows, message: `${affectedRows} UE(s) ${action === 'LOCK' ? 'verrouillée(s)' : 'déverrouillée(s)'} avec succès.` });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
