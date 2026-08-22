const mysql = require('mysql2/promise');
require('dotenv').config();

// Pool de connexions (pas de connexion unique) : chaque requete emprunte une
// connexion au pool et la restitue ensuite. Evite d'ouvrir/fermer une
// connexion TCP a chaque requete et gere la concurrence entre requetes HTTP.
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'laravel',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Les colonnes DECIMAL (MOYENNE, MGP, CAP, QdP...) reviennent en string par
  // defaut avec mysql2, pour ne pas perdre de precision en JS float. On les
  // reconvertit nous-memes au moment du calcul (Number(...)), donc pas besoin
  // de decimalNumbers:true ici -- le laisser en string evite les surprises
  // d'arrondi silencieux sur les colonnes financieres (tranche.MONTANT etc).
  dateStrings: true, // plusieurs colonnes "date" du schema sont en fait des VARCHAR ; force la coherence
});

// Petit helper pour ne pas repeter [rows] partout dans les controllers
const query = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};

module.exports = { pool, query };