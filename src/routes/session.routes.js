const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/session.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

router.get('/active', 
  authenticateToken, 
  authorizeRoles('ENSEIGNANT', 'ADMIN'), 
  sessionController.getActiveSessions
);

router.post('/:id/close', 
  authenticateToken, 
  authorizeRoles('ENSEIGNANT', 'ADMIN'), 
  sessionController.closeSession
);

module.exports = router;
