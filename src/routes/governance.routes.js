const express = require('express');
const { pool, query } = require('../config/mysql');
const bcrypt = require('bcryptjs');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const router = express.Router();
router.use(authenticateToken);

router.post('/users', authorizeRoles('SUPER_ADMIN'), async (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;

  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    return res.status(400).json({ message: 'L’identifiant doit comporter de 3 à 50 caractères : lettres, chiffres, point, tiret ou souligné.' });
  }
  if (name.length < 2 || name.length > 255) return res.status(400).json({ message: 'Le nom complet est requis (2 à 255 caractères).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) return res.status(400).json({ message: 'Une adresse e-mail valide est requise.' });
  if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ message: 'Le mot de passe initial doit contenir au moins 12 caractères.' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const hash = await bcrypt.hash(password, 12);
    const [result] = await connection.query(
      "INSERT INTO users (username, name, email, password, password_changed_at, locale, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'fr', 1, NOW(), NOW())",
      [username, name, email, hash]
    );
    await connection.commit();
    const user = { id: result.insertId, username, name, email, is_active: 1, must_change_password: true };
    await audit({ user: req.user, action: 'CREATE', module: 'ADMIN', resourceType: 'users', resourceId: result.insertId, resourceLabel: email, description: `Création du compte ${username}`, newValues: { ...user, password: undefined }, request: req });
    return res.status(201).json(user);
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Cet identifiant ou cette adresse e-mail est déjà utilisé.' });
    return next(error);
  } finally {
    connection.release();
  }
});

router.get('/accounts', authorizeRoles('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const accounts = await query(
      'SELECT id, username, name, email, is_active, password_changed_at, last_login, created_at FROM users ORDER BY created_at DESC, name ASC, email ASC'
    );
    res.json(accounts.map(account => ({ ...account, must_change_password: !account.password_changed_at })));
  } catch (error) {
    next(error);
  }
});

router.patch('/accounts/:id/status', authorizeRoles('SUPER_ADMIN'), async (req, res, next) => {
  const accountId = Number(req.params.id);
  const isActive = req.body.is_active;
  if (!Number.isSafeInteger(accountId) || accountId < 1) return res.status(400).json({ message: 'Identifiant de compte invalide.' });
  if (isActive !== true && isActive !== false && isActive !== 0 && isActive !== 1) return res.status(400).json({ message: 'Le statut du compte est invalide.' });
  if (accountId === req.user.id) return res.status(400).json({ message: 'Vous ne pouvez pas désactiver votre propre compte.' });

  try {
    const account = (await query('SELECT id, name, email, is_active FROM users WHERE id = ? LIMIT 1', [accountId]))[0];
    if (!account) return res.status(404).json({ message: 'Compte introuvable.' });
    const nextStatus = Boolean(isActive);
    if (Boolean(account.is_active) !== nextStatus) {
      await query('UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?', [nextStatus ? 1 : 0, accountId]);
      await audit({ user: req.user, action: nextStatus ? 'ACTIVATE' : 'DEACTIVATE', module: 'ADMIN', resourceType: 'users', resourceId: accountId, resourceLabel: account.email, description: `${nextStatus ? 'Activation' : 'Désactivation'} du compte ${account.name}`, oldValues: { is_active: account.is_active }, newValues: { is_active: nextStatus ? 1 : 0 }, request: req });
    }
    res.json({ id: accountId, is_active: nextStatus });
  } catch (error) {
    next(error);
  }
});

router.post('/accounts/:id/reset-password', authorizeRoles('SUPER_ADMIN'), async (req, res, next) => {
  const accountId = Number(req.params.id);
  const password = req.body.password;
  if (!Number.isSafeInteger(accountId) || accountId < 1) return res.status(400).json({ message: 'Identifiant de compte invalide.' });
  if (accountId === req.user.id) return res.status(400).json({ message: 'Utilisez votre propre changement de mot de passe pour votre compte.' });
  if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ message: 'Le mot de passe provisoire doit contenir au moins 12 caractères.' });

  try {
    const account = (await query('SELECT id, name, email FROM users WHERE id = ? LIMIT 1', [accountId]))[0];
    if (!account) return res.status(404).json({ message: 'Compte introuvable.' });
    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password = ?, password_changed_at = NULL, updated_at = NOW() WHERE id = ?', [hash, accountId]);
    await audit({ user: req.user, action: 'RESET_PASSWORD', module: 'ADMIN', resourceType: 'users', resourceId: accountId, resourceLabel: account.email, description: `Réinitialisation du mot de passe de ${account.name}`, request: req });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/users', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try {
    const role = req.query.role;
    const users = role
      ? await query(`SELECT DISTINCT u.id,u.name,u.email,u.is_active FROM users u
                     JOIN model_has_roles mhr ON mhr.model_id=u.id AND mhr.model_type LIKE '%User'
                     JOIN roles r ON r.id=mhr.role_id WHERE r.name=? ORDER BY u.name,u.email`, [role])
      : await query('SELECT id,name,email,is_active FROM users ORDER BY name,email');
    res.json(users);
  } catch(e){ next(e); }
});
router.get('/roles', requirePermission('users.manage_permissions'), async (req,res,next) => { try { res.json(await query('SELECT name FROM roles ORDER BY name')); } catch(e){next(e)} });
router.get('/permissions', requirePermission('users.manage_permissions'), async (req,res,next) => { try { res.json(await query('SELECT name FROM permissions ORDER BY name')); } catch(e){next(e)} });

router.get('/academic-years', async (req,res,next) => { try { res.json(await query('SELECT * FROM academic_years ORDER BY annee DESC')); } catch(e){ next(e); } });
router.post('/academic-years', requirePermission('academic_year.manage'), async (req,res,next) => {
  try { const { annee,date_debut,date_fin }=req.body; if(!annee||!date_debut||!date_fin) return res.status(400).json({message:'annee, date_debut et date_fin requis.'});
    await query('INSERT INTO academic_years (annee,date_debut,date_fin,est_active,created_by,created_at,updated_at) VALUES (?,?,?,0,?,NOW(),NOW())',[annee,date_debut,date_fin,req.user.id]);
    const item=(await query('SELECT * FROM academic_years WHERE annee=?',[annee]))[0]; await audit({user:req.user,action:'CREATE',module:'PARAMETRES',resourceType:'academic_years',resourceId:annee,description:'Création année académique',newValues:item,request:req}); res.status(201).json(item);
  } catch(e){ next(e); }
});
router.post('/academic-years/:annee/activate', requirePermission('academic_year.manage'), async (req,res,next) => {
  const connection=await pool.getConnection(); try { await connection.beginTransaction(); await connection.query('UPDATE academic_years SET est_active=0,updated_at=NOW() WHERE est_active=1'); const [result]=await connection.query('UPDATE academic_years SET est_active=1,updated_at=NOW() WHERE annee=?',[req.params.annee]); if(!result.affectedRows) throw Object.assign(new Error('Année introuvable.'),{status:404}); await connection.commit(); await audit({user:req.user,action:'UPDATE',module:'PARAMETRES',resourceType:'academic_years',resourceId:req.params.annee,description:'Activation année académique',newValues:{est_active:true},request:req}); res.json({success:true,annee:Number(req.params.annee)}); } catch(e){await connection.rollback();next(e)} finally {connection.release()}
});
router.put('/users/:id/roles/:role', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try { const role=(await query('SELECT id FROM roles WHERE name=? LIMIT 1',[req.params.role]))[0]; if(!role) return res.status(404).json({message:'Rôle introuvable.'}); await query("INSERT IGNORE INTO model_has_roles (role_id,model_type,model_id) VALUES (?,'App\\\\Models\\\\User',?)",[role.id,req.params.id]); await audit({user:req.user,action:'ASSIGN',module:'ADMIN',resourceType:'users',resourceId:req.params.id,description:`Attribution rôle ${req.params.role}`,request:req}); res.status(204).end(); } catch(e){next(e)}
});
router.put('/users/:id/permissions/:permission', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try { const permission=(await query('SELECT id FROM permissions WHERE name=? LIMIT 1',[req.params.permission]))[0]; if(!permission) return res.status(404).json({message:'Permission introuvable.'}); await query("INSERT IGNORE INTO model_has_permissions (permission_id,model_type,model_id) VALUES (?,'App\\\\Models\\\\User',?)",[permission.id,req.params.id]); await audit({user:req.user,action:'ASSIGN',module:'ADMIN',resourceType:'users',resourceId:req.params.id,description:`Attribution permission ${req.params.permission}`,request:req}); res.status(204).end(); } catch(e){next(e)}
});
// Rôles et permissions actuels d'un utilisateur
router.get('/users/:id/roles', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try {
    const userRoles = await query(
      `SELECT r.name, r.id FROM roles r
       JOIN model_has_roles mhr ON mhr.role_id = r.id AND mhr.model_type LIKE '%User'
       WHERE mhr.model_id = ? ORDER BY r.name`,
      [req.params.id]
    );
    const userPerms = await query(
      `SELECT p.name, p.id FROM permissions p
       JOIN model_has_permissions mhp ON mhp.permission_id = p.id AND mhp.model_type LIKE '%User'
       WHERE mhp.model_id = ? ORDER BY p.name`,
      [req.params.id]
    );
    res.json({ roles: userRoles, permissions: userPerms });
  } catch(e){ next(e); }
});

// Permissions d'un rôle
router.get('/roles/:name/permissions', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try {
    const roleRow = (await query('SELECT id FROM roles WHERE name=? LIMIT 1', [req.params.name]))[0];
    if (!roleRow) return res.status(404).json({ message: 'Rôle introuvable.' });
    const perms = await query(
      `SELECT p.name FROM permissions p
       JOIN role_has_permissions rhp ON rhp.permission_id = p.id
       WHERE rhp.role_id = ? ORDER BY p.name`,
      [roleRow.id]
    );
    res.json(perms.map(p => p.name));
  } catch(e){ next(e); }
});

// Révoquer un rôle d'un utilisateur
router.delete('/users/:id/roles/:role', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try {
    const role = (await query('SELECT id FROM roles WHERE name=? LIMIT 1', [req.params.role]))[0];
    if (!role) return res.status(404).json({ message: 'Rôle introuvable.' });
    await query("DELETE FROM model_has_roles WHERE role_id=? AND model_type LIKE '%User' AND model_id=?", [role.id, req.params.id]);
    await audit({ user: req.user, action: 'REVOKE', module: 'ADMIN', resourceType: 'users', resourceId: req.params.id, description: `Révocation rôle ${req.params.role}`, request: req });
    res.status(204).end();
  } catch(e){ next(e); }
});

// Révoquer une permission directe d'un utilisateur
router.delete('/users/:id/permissions/:permission', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try {
    const perm = (await query('SELECT id FROM permissions WHERE name=? LIMIT 1', [req.params.permission]))[0];
    if (!perm) return res.status(404).json({ message: 'Permission introuvable.' });
    await query("DELETE FROM model_has_permissions WHERE permission_id=? AND model_type LIKE '%User' AND model_id=?", [perm.id, req.params.id]);
    await audit({ user: req.user, action: 'REVOKE', module: 'ADMIN', resourceType: 'users', resourceId: req.params.id, description: `Révocation permission ${req.params.permission}`, request: req });
    res.status(204).end();
  } catch(e){ next(e); }
});

module.exports=router;
