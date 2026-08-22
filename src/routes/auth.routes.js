const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/change-password', authenticateToken, authController.changeInitialPassword);
router.get('/me', authenticateToken, authController.me);
router.put('/profile', authenticateToken, authController.updateProfile);

module.exports = router;
