const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/mysql');
const { audit } = require('../services/audit.service');
require('dotenv').config();

const tokenFor = (user, mustChangePassword) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, mustChangePassword },
  process.env.JWT_SECRET,
  { expiresIn: '24h' }
);

const passwordError = (password) => {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Le mot de passe doit contenir au moins 12 caractères.';
  }
  return null;
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const users = await query('SELECT id, email, password, is_active, password_changed_at FROM users WHERE email = ? LIMIT 1', [email]);
    const user = users[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Generate JWT
    const roles = await query(`SELECT r.name FROM roles r JOIN model_has_roles mr ON mr.role_id = r.id WHERE mr.model_id = ? AND mr.model_type LIKE '%User'`, [user.id]);
    const role = roles.map((item) => item.name).includes('SUPER_ADMIN') ? 'SUPER_ADMIN' : roles[0]?.name || 'USER';
    const mustChangePassword = !user.password_changed_at;
    const token = tokenFor({ ...user, role }, mustChangePassword);
    await query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    res.status(200).json({
      message: mustChangePassword ? 'Changement du mot de passe initial requis.' : 'Login successful',
      token,
      mustChangePassword,
      user: {
        id: user.id,
        email: user.email,
        role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Internal server error during login.' });
  }
};

exports.changeInitialPassword = async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const validationError = passwordError(newPassword);
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ message: 'Le mot de passe actuel, le nouveau mot de passe et sa confirmation sont requis.' });
  }
  if (validationError) return res.status(400).json({ message: validationError });
  if (newPassword !== confirmPassword) return res.status(400).json({ message: 'La confirmation du mot de passe ne correspond pas.' });
  if (currentPassword === newPassword) return res.status(400).json({ message: 'Le nouveau mot de passe doit être différent du mot de passe initial.' });

  try {
    const users = await query('SELECT id, email, password, is_active FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    const user = users[0];
    if (!user || !user.is_active) return res.status(401).json({ message: 'Compte introuvable ou désactivé.' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Le mot de passe actuel est incorrect.' });

    const password = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password = ?, password_changed_at = NOW(), updated_at = NOW() WHERE id = ?', [password, user.id]);
    const token = tokenFor({ ...user, role: req.user.role }, false);

    res.json({ message: 'Mot de passe mis à jour.', token, mustChangePassword: false });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ message: 'Impossible de mettre à jour le mot de passe.' });
  }
};

exports.me = async (req, res) => {
  try {
    const user = (await query('SELECT id, username, name, email, locale, is_active, password_changed_at, last_login, created_at FROM users WHERE id = ? LIMIT 1', [req.user.id]))[0];
    if (!user || !user.is_active) return res.status(401).json({ message: 'Compte introuvable ou désactivé.' });
    const roles = await query(
      `SELECT r.name FROM roles r
       JOIN model_has_roles mr ON mr.role_id = r.id AND mr.model_type LIKE '%User'
       WHERE mr.model_id = ? ORDER BY r.name`,
      [user.id]
    );
    res.json({ ...user, roles: roles.map(role => role.name), must_change_password: !user.password_changed_at });
  } catch (err) {
    console.error('Current user error:', err);
    res.status(500).json({ message: 'Impossible de charger le profil utilisateur.' });
  }
};

exports.updateProfile = async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2 || name.length > 255) return res.status(400).json({ message: 'Le nom doit contenir entre 2 et 255 caractères.' });

  try {
    const current = (await query('SELECT id, name, email FROM users WHERE id = ? LIMIT 1', [req.user.id]))[0];
    if (!current) return res.status(404).json({ message: 'Compte introuvable.' });
    await query('UPDATE users SET name = ?, updated_at = NOW() WHERE id = ?', [name, current.id]);
    await audit({ user: req.user, action: 'UPDATE_PROFILE', module: 'AUTH', resourceType: 'users', resourceId: current.id, resourceLabel: current.email, description: 'Mise à jour du profil utilisateur', oldValues: { name: current.name }, newValues: { name }, request: req });
    res.json({ id: current.id, name, email: current.email });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ message: 'Impossible de mettre à jour le profil.' });
  }
};

