const express = require('express');
const router = express.Router();
const deliberationService = require('../services/deliberation.service');
const { pool } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Helper : vérifie que l'utilisateur est admin ou membre/président du jury donné
async function assertJuryMembership(juryId, user) {
  const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(user.role);
  if (isAdmin) return true;
  const [rows] = await pool.query(
    'SELECT id FROM jury_membres WHERE jury_id = ? AND user_id = ? UNION SELECT id FROM jury WHERE id = ? AND president_id = ?',
    [juryId, user.id, juryId, user.id]
  );
  if (!rows || rows.length === 0) {
    throw Object.assign(new Error('Accès refusé : vous n\'êtes pas membre de ce jury.'), { status: 403 });
  }
  return true;
}

// PV de synthèse d'une session de délibération
router.get('/session/:session_id', requirePermission('deliberation.view'), async (req, res, next) => {
  try {
    const sessionId = Number(req.params.session_id);
    const session = await deliberationService.getSessionWithDetails(sessionId);
    if (!session) return res.status(404).json({ message: 'Session introuvable.' });
    await assertJuryMembership(session.jury_id, req.user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pv-deliberation-session-${sessionId}.pdf"`);
    await deliberationService.generateSessionPvPdf(sessionId, res);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
});

// PV de synthèse pour un jury (toutes sessions)
router.get('/jury/:jury_id', requirePermission('deliberation.view'), async (req, res, next) => {
  try {
    const juryId = Number(req.params.jury_id);
    await assertJuryMembership(juryId, req.user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pv-deliberation-jury-${juryId}.pdf"`);
    await deliberationService.generateJuryPvPdf(juryId, res);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
});

module.exports = router;

