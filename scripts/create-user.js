// Usage: node scripts/create-user.js <username> <name> <email> <password> [ROLE]
const bcrypt = require('bcryptjs');
const { pool, query } = require('../src/config/mysql');
const [username, name, email, password, role] = process.argv.slice(2);
if (!username || !name || !email || !password) { console.error('Usage: node scripts/create-user.js <username> <name> <email> <password> [ROLE]'); process.exit(1); }
(async () => { const connection = await pool.getConnection(); try {
  await connection.beginTransaction();
  const hash = await bcrypt.hash(password, 12);
  const [result] = await connection.query("INSERT INTO users (username,name,email,password,locale,is_active,created_at,updated_at) VALUES (?,?,?,?, 'fr',1,NOW(),NOW())", [username,name,email,hash]);
  if (role) { const [roles] = await connection.query('SELECT id FROM roles WHERE name=? LIMIT 1',[role]); if (!roles[0]) throw new Error(`Rôle introuvable: ${role}`); await connection.query("INSERT INTO model_has_roles (role_id,model_type,model_id) VALUES (?,'App\\\\Models\\\\User',?)",[roles[0].id,result.insertId]); }
  await connection.commit(); console.log(`Compte créé: id=${result.insertId}, username=${username}${role ? `, rôle=${role}` : ''}`);
} catch(e) { await connection.rollback(); console.error(`Erreur: ${e.message}`); process.exitCode=1; } finally { connection.release(); await pool.end(); } })();
