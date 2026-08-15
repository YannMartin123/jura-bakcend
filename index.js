const app = require('./src/app');
require('dotenv').config();

// Les variables d'environnement sont des chaînes : sans conversion, "5000"
// est interprété par Node comme un chemin de socket plutôt qu'un port HTTP.
const PORT = Number(process.env.PORT) || 5000;

const server = app.listen(PORT, () => {
  console.log(`
🚀 JURA Backend running on port ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
  `);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err, promise) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

// Gestion de l'arrêt gracieux
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
