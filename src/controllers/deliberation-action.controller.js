const { pool } = require('../config/mysql');
const deliberationService = require('../services/deliberation.service');

// Vérifie que l'utilisateur est admin ou membre/président du jury de la session donnée
async function assertSessionMembership(sessionId, user) {
  const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(user.role);
  if (isAdmin) return true;

  const session = await deliberationService.getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });

  const [rows] = await pool.query(
    'SELECT id FROM jury_membres WHERE jury_id = ? AND user_id = ? UNION SELECT id FROM jury WHERE id = ? AND president_id = ?',
    [session.jury_id, user.id, session.jury_id, user.id]
  );
  if (!rows || rows.length === 0) {
    throw Object.assign(new Error('Accès refusé : vous n\'êtes pas membre du jury de cette session.'), { status: 403 });
  }
  return true;
}

// Vérifie que l'utilisateur est admin ou membre/président du jury via l'action temp_note
async function assertActionMembership(actionId, user) {
  const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(user.role);
  if (isAdmin) return true;

  const [rows] = await pool.query(
    `SELECT ds.jury_id FROM deliberation_temp_notes dtn
     JOIN deliberation_sessions ds ON ds.id = dtn.session_id
     WHERE dtn.id = ?`,
    [actionId]
  );
  if (!rows || rows.length === 0) throw Object.assign(new Error('Action introuvable.'), { status: 404 });

  const juryId = rows[0].jury_id;
  const [memberRows] = await pool.query(
    'SELECT id FROM jury_membres WHERE jury_id = ? AND user_id = ? UNION SELECT id FROM jury WHERE id = ? AND president_id = ?',
    [juryId, user.id, juryId, user.id]
  );
  if (!memberRows || memberRows.length === 0) {
    throw Object.assign(new Error('Accès refusé : vous n\'êtes pas membre du jury de cette action.'), { status: 403 });
  }
  return true;
}

async function previewAction(req, res, next) {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ message: 'session_id requis.' });
    await assertSessionMembership(session_id, req.user);
    const preview = await deliberationService.previewDeliberationAction(session_id, req.body);
    res.json(preview);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
}

async function ajoutPoints(req, res, next) {
  try {
    const { session_id, points_a_ajouter } = req.body;
    if (!session_id) return res.status(400).json({ message: 'session_id requis.' });
    if (points_a_ajouter === undefined || points_a_ajouter === null) {
      return res.status(400).json({ message: 'points_a_ajouter requis.' });
    }
    await assertSessionMembership(session_id, req.user);
    const result = await deliberationService.executeAjoutPoints(session_id, req.body, req.user, req);
    res.status(201).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
}

async function moyenneCible(req, res, next) {
  try {
    const { session_id, moyenne_cible } = req.body;
    if (!session_id) return res.status(400).json({ message: 'session_id requis.' });
    if (moyenne_cible === undefined || moyenne_cible === null) {
      return res.status(400).json({ message: 'moyenne_cible requise.' });
    }
    await assertSessionMembership(session_id, req.user);
    const result = await deliberationService.executeMoyenneCible(session_id, req.body, req.user, req);
    res.status(201).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
}

async function mgpCible(req, res, next) {
  try {
    const { session_id, mgp_cible } = req.body;
    if (!session_id) return res.status(400).json({ message: 'session_id requis.' });
    if (mgp_cible === undefined || mgp_cible === null) {
      return res.status(400).json({ message: 'mgp_cible requise (ex: 2.0, 2.3, 3.0).' });
    }
    await assertSessionMembership(session_id, req.user);
    const result = await deliberationService.executeMgpCible(session_id, req.body, req.user, req);
    res.status(201).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
}

async function confirmAction(req, res, next) {
  try {
    await assertActionMembership(req.params.id, req.user);
    const result = await deliberationService.confirmAction(req.params.id, req.user, req);
    res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
}

async function cancelAction(req, res, next) {
  try {
    await assertActionMembership(req.params.id, req.user);
    const result = await deliberationService.cancelAction(req.params.id, req.user, req);
    res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
}

module.exports = {
  previewAction,
  ajoutPoints,
  moyenneCible,
  mgpCible,
  confirmAction,
  cancelAction
};
