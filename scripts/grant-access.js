// Usage: node scripts/grant-access.js <user_id> role|permission <name>
const { pool } = require('../src/config/mysql');
const [userId, kind, name] = process.argv.slice(2);
if (!userId || !['role','permission'].includes(kind) || !name) { console.error('Usage: node scripts/grant-access.js <user_id> role|permission <name>'); process.exit(1); }
(async()=>{const c=await pool.getConnection();try{const table=kind==='role'?'roles':'permissions';const column=kind==='role'?'role_id':'permission_id';const pivot=kind==='role'?'model_has_roles':'model_has_permissions';const [items]=await c.query(`SELECT id FROM ${table} WHERE name=? LIMIT 1`,[name]);if(!items[0])throw new Error(`${kind} introuvable: ${name}`);await c.query(`INSERT IGNORE INTO ${pivot} (${column},model_type,model_id) VALUES (?,'App\\\\Models\\\\User',?)`,[items[0].id,userId]);console.log(`${kind} attribué.`)}catch(e){console.error(`Erreur: ${e.message}`);process.exitCode=1}finally{c.release();await pool.end()}})();
