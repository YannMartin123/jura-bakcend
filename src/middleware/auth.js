const jwt = require('jsonwebtoken');
const { query } = require('../config/mysql');
require('dotenv').config();

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    const accounts = await query('SELECT is_active, password_changed_at FROM users WHERE id = ? LIMIT 1', [verified.id]);
    const account = accounts[0];
    if (!account || !account.is_active) {
      return res.status(401).json({ message: 'Compte introuvable ou désactivé.' });
    }
    const isPasswordChangeRequest = req.method === 'POST'
      && req.originalUrl.split('?')[0] === '/api/auth/change-password';
    if (!account.password_changed_at && !isPasswordChangeRequest) {
      return res.status(403).json({ message: 'Vous devez modifier votre mot de passe initial avant d’accéder à l’application.' });
    }
    req.user = verified;
    return next();
  } catch (err) {
    // Le jeton doit être émis par l'API MySQL/Laravel de JURA.
    try {
      return res.status(403).json({ message: 'Invalid or expired token.' });
    } catch (fallbackError) {
      return res.status(403).json({ message: 'Invalid or expired token.' });
    }
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Unauthorized access for your role.' });
    }
    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRoles
};
