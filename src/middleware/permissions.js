const { query } = require('../config/mysql');

const SUPER_ADMIN = 'SUPER_ADMIN';

function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentification requise.' });
    if (req.user.role === SUPER_ADMIN) return next();

    try {
      const rows = await query(
        `SELECT 1 FROM permissions p
         LEFT JOIN model_has_permissions mp ON mp.permission_id = p.id AND mp.model_id = ? AND mp.model_type LIKE '%User'
         LEFT JOIN role_has_permissions rp ON rp.permission_id = p.id
         LEFT JOIN model_has_roles mr ON mr.role_id = rp.role_id AND mr.model_id = ? AND mr.model_type LIKE '%User'
         WHERE p.name = ? AND (mp.permission_id IS NOT NULL OR mr.role_id IS NOT NULL) LIMIT 1`,
        [req.user.id, req.user.id, permission]
      );
      if (rows.length) return next();
      return res.status(403).json({ message: `Permission requise : ${permission}` });
    } catch (error) {
      return res.status(503).json({ message: 'Contrôle des permissions indisponible. Exécutez la migration de gouvernance.', detail: error.message });
    }
  };
}

module.exports = { requirePermission, SUPER_ADMIN };
