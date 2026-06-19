const app = require('./src/app');
require('dotenv').config();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`
🚀 JURA Backend running on port ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
  `);
});