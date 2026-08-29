const express = require('express');
const { pool, query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');

const router = express.Router();
router.use(authenticateToken, requirePermission('structure.manage'));

// Get all departments with related data
router.get('/', async (req, res, next) => {
  try {
    const { etablissement_id } = req.query;
    let sql = `
      SELECT d.IDDEPT as id_dept, d.CODE as code, d.NOM as nom_dept, 
             d.IDETAB as etablissement_id, e.NOM_ETAB as nom_etab, e.CODE_ETAB as code_etab,
             u.name as chef_nom, u.email as chef_email, u.id as chef_id
      FROM Departement d
      LEFT JOIN Etablissement e ON e.IDETAB = d.IDETAB
      LEFT JOIN users u ON u.id = d.chef_departement_id
    `;
    const params = [];
    
    if (etablissement_id) {
      sql += ' WHERE d.IDETAB = ?';
      params.push(Number(etablissement_id));
    }
    
    sql += ' ORDER BY e.NOM_ETAB, d.NOM';
    
    const departments = await query(sql, params);
    res.json(departments);
  } catch (error) {
    next(error);
  }
});

// Create department
router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { code, nom, etablissement_id, chef_departement_id } = req.body;
    
    if (!code?.trim() || !nom?.trim()) {
      return res.status(400).json({ message: 'Code et nom du département sont requis.' });
    }
    
    if (!etablissement_id) {
      return res.status(400).json({ message: 'Établissement requis.' });
    }
    
    await connection.beginTransaction();
    
    // Check if code already exists for this etablissement
    const [existing] = await connection.query(
      'SELECT IDDEPT FROM Departement WHERE CODE = ? AND IDETAB = ?',
      [code.trim().toUpperCase(), Number(etablissement_id)]
    );
    
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ message: 'Ce code de département existe déjà pour cet établissement.' });
    }
    
    // Insert department
    const [result] = await connection.query(
      'INSERT INTO Departement (CODE, NOM, IDETAB, chef_departement_id, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
      [code.trim().toUpperCase(), nom.trim(), Number(etablissement_id), chef_departement_id || null]
    );
    
    await connection.commit();
    
    const created = (await query('SELECT * FROM Departement WHERE IDDEPT = ?', [result.insertId]))[0];
    await audit({
      user: req.user,
      action: 'CREATE',
      module: 'STRUCTURE',
      resourceType: 'departement',
      resourceId: result.insertId,
      description: `Création département ${nom}`,
      newValues: created,
      request: req
    });
    
    res.status(201).json(created);
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// Update department
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { code, nom, etablissement_id, chef_departement_id } = req.body;
    
    if (!code?.trim() || !nom?.trim()) {
      return res.status(400).json({ message: 'Code et nom du département sont requis.' });
    }
    
    const previous = (await query('SELECT * FROM Departement WHERE IDDEPT = ?', [id]))[0];
    if (!previous) {
      return res.status(404).json({ message: 'Département introuvable.' });
    }
    
    // Check if code already exists for this etablissement (excluding current)
    const [existing] = await query(
      'SELECT IDDEPT FROM Departement WHERE CODE = ? AND IDETAB = ? AND IDDEPT != ?',
      [code.trim().toUpperCase(), Number(etablissement_id), id]
    );
    
    if (existing.length > 0) {
      return res.status(409).json({ message: 'Ce code de département existe déjà pour cet établissement.' });
    }
    
    await query(
      'UPDATE Departement SET CODE = ?, NOM = ?, IDETAB = ?, chef_departement_id = ?, updated_at = NOW() WHERE IDDEPT = ?',
      [code.trim().toUpperCase(), nom.trim(), Number(etablissement_id), chef_departement_id || null, id]
    );
    
    const current = (await query('SELECT * FROM Departement WHERE IDDEPT = ?', [id]))[0];
    await audit({
      user: req.user,
      action: 'UPDATE',
      module: 'STRUCTURE',
      resourceType: 'departement',
      resourceId: id,
      description: `Modification département ${nom}`,
      oldValues: previous,
      newValues: current,
      request: req
    });
    
    res.json(current);
  } catch (error) {
    next(error);
  }
});

// Delete department
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    
    const previous = (await query('SELECT * FROM Departement WHERE IDDEPT = ?', [id]))[0];
    if (!previous) {
      return res.status(404).json({ message: 'Département introuvable.' });
    }
    
    // Check if department is used
    const [usage] = await query(`
      SELECT 
        (SELECT COUNT(*) FROM Filiere WHERE IDDEPT = ?) AS filieres,
        (SELECT COUNT(*) FROM users WHERE id IN (SELECT id FROM users WHERE id = ?)) AS users
    `, [id, id]);
    
    if (Number(usage.filieres) > 0) {
      return res.status(409).json({ message: 'Suppression impossible : ce département contient des filières.' });
    }
    
    await query('DELETE FROM Departement WHERE IDDEPT = ?', [id]);
    
    await audit({
      user: req.user,
      action: 'DELETE',
      module: 'STRUCTURE',
      resourceType: 'departement',
      resourceId: id,
      description: `Suppression département ${previous.NOM}`,
      oldValues: previous,
      request: req
    });
    
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
