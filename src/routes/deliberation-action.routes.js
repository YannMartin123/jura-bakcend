const express = require('express');
const router = express.Router();
const actionController = require('../controllers/deliberation-action.controller');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Actions de délibération
router.post('/preview', requirePermission('deliberation.execute'), actionController.previewAction);
router.post('/ajout-points', requirePermission('deliberation.execute'), actionController.ajoutPoints);
router.post('/moyenne-cible', requirePermission('deliberation.execute'), actionController.moyenneCible);
router.post('/:id/confirmer', requirePermission('deliberation.execute'), actionController.confirmAction);
router.post('/:id/annuler', requirePermission('deliberation.execute'), actionController.cancelAction);

module.exports = router;
