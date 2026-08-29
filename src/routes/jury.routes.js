const express = require('express');
const router = express.Router();
const juryController = require('../controllers/jury.controller');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Options de sélection (années, classes, enseignants)
router.get('/options', requirePermission('deliberation.view'), juryController.getOptions);

// Liste et détails des jurys
router.get('/', requirePermission('deliberation.view'), juryController.listJuries);
router.get('/:id', requirePermission('deliberation.view'), juryController.getJury);

// Création, modification, suppression de jurys
router.post('/', requirePermission('jury.manage'), juryController.createJury);
router.put('/:id', requirePermission('jury.manage'), juryController.updateJury);
router.delete('/:id', requirePermission('jury.manage'), juryController.deleteJury);

// Membres du jury
router.get('/:id/membres', requirePermission('deliberation.view'), juryController.getJuryMembers);
router.post('/:id/membres', requirePermission('jury.manage'), juryController.addJuryMember);
router.delete('/:id/membres/:user_id', requirePermission('jury.manage'), juryController.removeJuryMember);

module.exports = router;
