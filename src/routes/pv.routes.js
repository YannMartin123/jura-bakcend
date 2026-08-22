const express = require('express');
const router = express.Router();
const pvController = require('../controllers/pv.controller');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireUeAssignment } = require('../middleware/ue-assignment');

router.use(authenticateToken);

// PV global d'une UE pour une classe (roster + moyennes + stats par decision)
router.post('/generate-ue', requirePermission('pv.ue.generate'), requireUeAssignment, pvController.generatePvUe);

// PV recapitulatif de cycle pour un etudiant (base sur ulmdpvrecap)
router.post('/generate-recap', requirePermission('pv.generate'), pvController.generateRecap);

// PV recapitulatif de cycle pour une classe (base sur ulmdpvrecap)
router.post('/generate-recap-classe', requirePermission('pv.generate'), pvController.generatePvRecapClasse);

module.exports = router;
