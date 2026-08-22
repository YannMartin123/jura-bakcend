const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(morgan('dev'));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Routes placeholders
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/import', require('./routes/import.routes'));
app.use('/api/ue-import', require('./routes/ue-import.routes'));
app.use('/api/sessions', require('./routes/session.routes'));
app.use('/api/notes', require('./routes/note.routes'));
app.use('/api/moyennes', require('./routes/moyenne.routes'));
app.use('/api/pv', require('./routes/pv.routes'));
app.use('/api/governance', require('./routes/governance.routes'));
app.use('/api/academic-locks', require('./routes/academic-lock.routes'));
app.use('/api/teacher-work', require('./routes/teacher-work.routes'));
app.use('/api/ec', require('./routes/ec.routes'));
app.use('/api/ue-management', require('./routes/ue-management.routes'));
app.use('/api/deliberations', require('./routes/deliberation.routes'));

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
      status: err.status || 500
    }
  });
});

module.exports = app;
