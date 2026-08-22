const express = require('express');
const router = express.Router();
const pvController = require('../controllers/pv.controller');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken, requirePermission('pv.generate'));

// PV global d'une UE pour une classe (roster + moyennes + stats par decision)
router.post('/generate-ue', pvController.generatePvUe);

// PV recapitulatif de cycle pour un etudiant (base sur ulmdpvrecap)
router.post('/generate-recap', pvController.generateRecap);

// PV recapitulatif de cycle pour une classe (base sur ulmdpvrecap)
router.post('/generate-recap-classe', pvController.generatePvRecapClasse);

module.exports = router;
