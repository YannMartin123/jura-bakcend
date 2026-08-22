// Usage: node scripts/deactivate-user.js <user_id>
const { pool } = require('../src/config/mysql'); const id=process.argv[2]; if(!id){console.error('Usage: node scripts/deactivate-user.js <user_id>');process.exit(1)}
(async()=>{try{const [r]=await pool.query('UPDATE users SET is_active=0,updated_at=NOW() WHERE id=?',[id]);if(!r.affectedRows)throw new Error('Compte introuvable');console.log('Compte désactivé.')}catch(e){console.error(`Erreur: ${e.message}`);process.exitCode=1}finally{await pool.end()}})();
