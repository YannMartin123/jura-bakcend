const { query } = require('../config/mysql');

async function assertCanManageUe({ user, idue, idclasse, annee }) {
  if (user.role !== 'ENSEIGNANT') return;

  const assignments = await query(
    `SELECT 1 FROM teacher_ue_assignments
     WHERE user_id = ? AND IDUE = ? AND IDCLASSE = ? AND ANNEE = ? LIMIT 1`,
    [user.id, idue, idclasse, annee],
  );
  if (!assignments.length) {
    const error = new Error('Cette UE n’est pas affectée à cet enseignant pour cette classe et cette année.');
    error.status = 403;
    throw error;
  }
}

function requireUeAssignment(req, res, next) {
  const { idue, idclasse, annee } = req.body;
  if (!idue || !idclasse || !annee) {
    return res.status(400).json({ message: 'idue, idclasse et annee sont requis.' });
  }
  assertCanManageUe({ user: req.user, idue, idclasse, annee }).then(() => next()).catch(next);
}

module.exports = { assertCanManageUe, requireUeAssignment };
