// Usage: node scripts/reset-password.js <user_id|email> <new_password>
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/mysql');

const [identifier, password] = process.argv.slice(2);
if (!identifier || !password) {
  console.error('Usage: node scripts/reset-password.js <user_id|email> <new_password>');
  process.exit(1);
}

(async () => {
  try {
    const hash = await bcrypt.hash(password, 12);
    const numericId = /^\d+$/.test(identifier);
    const [result] = await pool.query(
      `UPDATE users SET password = ?, updated_at = NOW()
       WHERE ${numericId ? 'id = ?' : 'email = ?'}`,
      [hash, numericId ? Number(identifier) : identifier],
    );
    if (!result.affectedRows) throw new Error('Compte introuvable');
    console.log('Mot de passe réinitialisé.');
  } catch (error) {
    console.error(`Erreur: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
