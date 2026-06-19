const express = require('express');
const router = express.Router();
const multer = require('multer');
const importController = require('../controllers/import.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const upload = multer({ dest: 'uploads/' });

router.post('/validate', 
  authenticateToken, 
  authorizeRoles('ADMIN', 'ENSEIGNANT'), 
  upload.single('file'), 
  importController.validate
);

router.post('/confirm', 
  authenticateToken, 
  authorizeRoles('ADMIN', 'ENSEIGNANT'), 
  importController.confirm
);

module.exports = router;
