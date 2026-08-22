// Usage: node scripts/list-users.js
const { pool } = require('../src/config/mysql');
const modelType = 'App\\Models\\User';

(async () => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username, u.name, u.email, u.is_active,
             COALESCE(GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ', '), '-') AS roles,
             COALESCE(GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', '), '-') AS permissions
      FROM users u
      LEFT JOIN model_has_roles mhr
        ON mhr.model_id = u.id AND mhr.model_type = ?
      LEFT JOIN roles r ON r.id = mhr.role_id
      LEFT JOIN model_has_permissions mhp
        ON mhp.model_id = u.id AND mhp.model_type = ?
      LEFT JOIN permissions p ON p.id = mhp.permission_id
      GROUP BY u.id, u.username, u.name, u.email, u.is_active
      ORDER BY u.id;
    `, [modelType, modelType]);
    console.table(users);
  } catch (error) {
    console.error(`Erreur: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
