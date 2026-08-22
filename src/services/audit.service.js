const { query } = require('../config/mysql');

async function audit({ user, action, module, resourceType, resourceId, resourceLabel, description, oldValues = {}, newValues = {}, status = 'SUCCESS', request }) {
  try {
    await query(
      'INSERT INTO activity_log (log_name, description, subject_type, subject_id, event, causer_type, causer_id, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [module || 'JURA', description || action, resourceType || null, resourceId || null, action, 'App\\Models\\User', user?.id || null, JSON.stringify({ resourceLabel, status, oldValues, newValues, ip: request?.ip || null })]
    );
  } catch (error) {
    // Un incident d'audit ne doit jamais masquer l'action métier, mais il est visible dans les logs serveur.
    console.error('Audit write failed:', error.message);
  }
}

module.exports = { audit };
