const { query } = require('../config/mysql');
const { audit } = require('../services/audit.service');
const deliberationService = require('../services/deliberation.service');

// ----------------------------------------------------------------------
// Liste des sessions de délibération
// ----------------------------------------------------------------------
async function listSessions(req, res, next) {
  try {
    const { jury_id, annee, statut, classe_id } = req.query;
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(req.user.role);

    let sql = `
      SELECT s.*,
             j.nom AS jury_nom, j.IDCLASSE, j.annee, j.president_id,
             c.NIVEAU, c.CODGRADE,
             f.NOM AS filiere_nom,
             sp.INTITULE AS specialite_nom,
             u.name AS president_nom,
             (SELECT COUNT(*) FROM deliberation_temp_notes WHERE session_id = s.id) AS total_notes_modifiees,
             (SELECT COUNT(*) FROM deliberation_validations WHERE session_id = s.id AND validation = 'APPROUVE') AS total_validations,
             (SELECT COUNT(*) FROM jury_membres WHERE jury_id = s.jury_id) AS total_membres
      FROM deliberation_sessions s
      JOIN jury j ON j.id = s.jury_id
      LEFT JOIN Classe c ON c.IDCLASSE = j.IDCLASSE
      LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
      LEFT JOIN Specialite sp ON sp.IDSPECIALITE = c.IDSPECIALITE
      LEFT JOIN users u ON u.id = j.president_id
      WHERE 1=1
    `;
    const params = [];

    // Restriction : si non-admin, ne voir que les sessions des jurys dont on est président ou membre
    if (!isAdmin) {
      sql += ` AND (j.president_id = ? OR EXISTS (
        SELECT 1 FROM jury_membres jm WHERE jm.jury_id = s.jury_id AND jm.user_id = ?
      ))`;
      params.push(req.user.id, req.user.id);
    }

    if (jury_id) {
      sql += ' AND s.jury_id = ?';
      params.push(Number(jury_id));
    }
    if (annee) {
      sql += ' AND j.annee = ?';
      params.push(Number(annee));
    }
    if (statut) {
      sql += ' AND s.statut = ?';
      params.push(statut);
    }
    if (classe_id) {
      sql += ' AND j.IDCLASSE = ?';
      params.push(Number(classe_id));
    }

    sql += ' ORDER BY s.created_at DESC, s.id DESC';

    const sessions = await query(sql, params);
    res.json(sessions);
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Détails d'une session
// ----------------------------------------------------------------------
async function getSession(req, res, next) {
  try {
    const session = await deliberationService.getSessionWithDetails(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session introuvable.' });

    // Restriction : un non-admin doit être membre ou président du jury de la session
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(req.user.role);
    if (!isAdmin) {
      const [memberCheck] = await require('../config/mysql').pool.query(
        'SELECT id FROM jury_membres WHERE jury_id = ? AND user_id = ? UNION SELECT id FROM jury WHERE id = ? AND president_id = ?',
        [session.jury_id, req.user.id, session.jury_id, req.user.id]
      );
      if (!memberCheck || memberCheck.length === 0) {
        return res.status(403).json({ message: 'Accès refusé : vous n\'êtes pas membre du jury de cette session.' });
      }
    }

    res.json(session);
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Création d'une session
// ----------------------------------------------------------------------
async function createSession(req, res, next) {
  try {
    const { jury_id, nom_session, description, date_debut, date_fin_prevue } = req.body;

    if (!jury_id) return res.status(400).json({ message: 'Le jury associé est requis.' });
    if (!nom_session || !nom_session.trim()) return res.status(400).json({ message: 'Le nom de la session est requis.' });

    const jury = await deliberationService.getJuryWithDetails(jury_id);
    if (!jury) return res.status(404).json({ message: 'Jury introuvable.' });

    const result = await query(`
      INSERT INTO deliberation_sessions (jury_id, nom_session, description, date_debut, date_fin_prevue, statut, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PREPARATION', ?, NOW(), NOW())
    `, [
      Number(jury_id),
      nom_session.trim(),
      description || null,
      date_debut || null,
      date_fin_prevue || null,
      req.user.id
    ]);

    const created = await deliberationService.getSessionWithDetails(result.insertId);

    await audit({
      user: req.user,
      action: 'CREATE',
      module: 'JURY',
      resourceType: 'deliberation_sessions',
      resourceId: result.insertId,
      description: `Création de la session : ${nom_session}`,
      newValues: created,
      request: req
    });

    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Modification d'une session
// ----------------------------------------------------------------------
async function updateSession(req, res, next) {
  try {
    const sessionId = Number(req.params.id);
    const existing = await deliberationService.getSessionWithDetails(sessionId);
    if (!existing) return res.status(404).json({ message: 'Session introuvable.' });

    if (existing.statut === 'CLOTURE' || existing.statut === 'ANNULEE') {
      return res.status(409).json({ message: 'Une session clôturée ou annulée ne peut plus être modifiée.' });
    }

    const { nom_session, description, date_debut, date_fin_prevue } = req.body;

    await query(`
      UPDATE deliberation_sessions SET
        nom_session = COALESCE(?, nom_session),
        description = COALESCE(?, description),
        date_debut = COALESCE(?, date_debut),
        date_fin_prevue = COALESCE(?, date_fin_prevue),
        updated_at = NOW()
      WHERE id = ?
    `, [
      nom_session !== undefined ? nom_session.trim() : null,
      description !== undefined ? description : null,
      date_debut !== undefined ? date_debut : null,
      date_fin_prevue !== undefined ? date_fin_prevue : null,
      sessionId
    ]);

    const updated = await deliberationService.getSessionWithDetails(sessionId);

    await audit({
      user: req.user,
      action: 'UPDATE',
      module: 'JURY',
      resourceType: 'deliberation_sessions',
      resourceId: sessionId,
      description: `Mise à jour de la session #${sessionId}`,
      oldValues: existing,
      newValues: updated,
      request: req
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Suppression d'une session (si PREPARATION ou ANNULEE)
// ----------------------------------------------------------------------
async function deleteSession(req, res, next) {
  try {
    const sessionId = Number(req.params.id);
    const existing = await deliberationService.getSessionWithDetails(sessionId);
    if (!existing) return res.status(404).json({ message: 'Session introuvable.' });

    if (['OUVERTE', 'EN_COURS', 'EN_ATTENTE_VALIDATION', 'CLOTURE'].includes(existing.statut)) {
      return res.status(409).json({ message: 'Seule une session en préparation ou annulée peut être supprimée.' });
    }

    await query('DELETE FROM deliberation_sessions WHERE id = ?', [sessionId]);

    await audit({
      user: req.user,
      action: 'DELETE',
      module: 'JURY',
      resourceType: 'deliberation_sessions',
      resourceId: sessionId,
      description: `Suppression de la session #${sessionId} (${existing.nom_session})`,
      request: req
    });

    res.json({ success: true, message: 'Session supprimée.' });
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Roster et Notes pour l'interface de délibération
// ----------------------------------------------------------------------
async function getRosterAndGrades(req, res, next) {
  try {
    const session = await deliberationService.getSessionWithDetails(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session introuvable.' });

    // Restriction : un non-admin doit être membre ou président du jury de la session
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(req.user.role);
    if (!isAdmin) {
      const [memberCheck] = await require('../config/mysql').pool.query(
        'SELECT id FROM jury_membres WHERE jury_id = ? AND user_id = ? UNION SELECT id FROM jury WHERE id = ? AND president_id = ?',
        [session.jury_id, req.user.id, session.jury_id, req.user.id]
      );
      if (!memberCheck || memberCheck.length === 0) {
        return res.status(403).json({ message: 'Accès refusé : vous n\'êtes pas membre du jury de cette session.' });
      }
    }

    const rosterData = await deliberationService.getSessionRosterAndGrades(session);
    const gradebook = deliberationService.buildCombinedGradebook(rosterData);

    res.json({
      session,
      ues: rosterData.ues,
      gradebook,
      stats: {
        total_etudiants: gradebook.length,
        total_modifies: gradebook.filter(g => g.current_summary.is_improved).length,
        admis_avant: gradebook.filter(g => g.original_summary.decision === 'ADMIS').length,
        admis_apres: gradebook.filter(g => g.current_summary.decision === 'ADMIS').length
      }
    });
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Transitions du cycle de vie
// ----------------------------------------------------------------------
async function ouvrirSession(req, res, next) {
  try {
    const session = await deliberationService.openSession(req.params.id, req.user, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function commencerSession(req, res, next) {
  try {
    const session = await deliberationService.startSession(req.params.id, req.user, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function demanderValidation(req, res, next) {
  try {
    const session = await deliberationService.requestValidation(req.params.id, req.user, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function validerSession(req, res, next) {
  try {
    const { validation, commentaire } = req.body;
    const session = await deliberationService.submitValidation(req.params.id, req.user, { validation, commentaire }, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function cloturerSession(req, res, next) {
  try {
    const session = await deliberationService.closeSession(req.params.id, req.user, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function annulerSession(req, res, next) {
  try {
    const session = await deliberationService.cancelSession(req.params.id, req.user, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function verrouillerSession(req, res, next) {
  try {
    const { motif } = req.body;
    const session = await deliberationService.lockSession(req.params.id, req.user, motif, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

async function deverrouillerSession(req, res, next) {
  try {
    const session = await deliberationService.unlockSession(req.params.id, req.user, req);
    res.json(session);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  getRosterAndGrades,
  ouvrirSession,
  commencerSession,
  demanderValidation,
  validerSession,
  cloturerSession,
  annulerSession,
  verrouillerSession,
  deverrouillerSession
};
