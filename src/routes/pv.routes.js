const express = require('express');
const router = express.Router();
const pvController = require('../controllers/pv.controller');

router.post('/generate', pvController.generatePV);
router.post('/generate-recap', pvController.generateRecap);

module.exports = router;
