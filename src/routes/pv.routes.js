const express = require('express');
const router = express.Router();
const pvController = require('../controllers/pv.controller');

router.post('/generate', pvController.generatePV);

module.exports = router;
