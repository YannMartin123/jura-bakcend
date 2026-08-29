const { pool, query } = require('../config/mysql');
const { audit } = require('../services/audit.service');
const { getJuryWithDetails } = require('../services/deliberation.service');

// ----------------------------------------------------------------------
// Liste des jurys avec filtres
// ----------------------------------------------------------------------
async function listJuries(req, res, next) {
  try {
    const { classe_id, annee, statut } = req.query;
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(req.user.role);

    let sql = `
      SELECT j.*, 
             c.NIVEAU, c.CODGRADE,
             f.NOM AS filiere_nom,
             s.INTITULE AS specialite_nom,
             u.name AS president_nom, u.email AS president_email,
             (SELECT COUNT(*) FROM jury_membres WHERE jury_id = j.id) AS total_membres,
             (SELECT COUNT(*) FROM deliberation_sessions WHERE jury_id = j.id) AS total_sessions
      FROM jury j
      LEFT JOIN Classe c ON c.IDCLASSE = j.IDCLASSE
      LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
      LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
      LEFT JOIN users u ON u.id = j.president_id
      WHERE 1=1
    `;
    const params = [];

    // Restriction : si non-admin, ne voir que les jurys dont on est président ou membre
    if (!isAdmin) {
      sql += ` AND (j.president_id = ? OR EXISTS (
        SELECT 1 FROM jury_membres jm WHERE jm.jury_id = j.id AND jm.user_id = ?
      ))`;
      params.push(req.user.id, req.user.id);
    }

    if (classe_id) {
      sql += ' AND j.IDCLASSE = ?';
      params.push(Number(classe_id));
    }
    if (annee) {
      sql += ' AND j.annee = ?';
      params.push(Number(annee));
    }
    if (statut) {
      sql += ' AND j.statut = ?';
      params.push(statut);
    }

    sql += ' ORDER BY j.created_at DESC, j.annee DESC, j.nom ASC';

    const juries = await query(sql, params);

    // Charger les membres pour chaque jury
    for (const j of juries) {
      const membres = await query(`
        SELECT jm.*, u.name, u.email, u.username
        FROM jury_membres jm
        JOIN users u ON u.id = jm.user_id
        WHERE jm.jury_id = ?
        ORDER BY FIELD(jm.role, 'PRESIDENT', 'SECRETAIRE', 'MEMBRE'), u.name ASC
      `, [j.id]);
      j.membres = membres;
    }

    res.json(juries);
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Détails d'un jury
// ----------------------------------------------------------------------
async function getJury(req, res, next) {
  try {
    const jury = await getJuryWithDetails(req.params.id);
    if (!jury) return res.status(404).json({ message: 'Jury introuvable.' });

    // Restriction : un non-admin doit être membre ou président
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(req.user.role);
    if (!isAdmin) {
      const isMember = jury.membres && jury.membres.some(m => Number(m.user_id) === Number(req.user.id));
      const isPresident = Number(jury.president_id) === Number(req.user.id);
      if (!isMember && !isPresident) {
        return res.status(403).json({ message: 'Accès refusé : vous n\'êtes pas membre de ce jury.' });
      }
    }

    res.json(jury);
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Création d'un nouveau jury
// ----------------------------------------------------------------------
async function createJury(req, res, next) {
  const connection = await pool.getConnection();
  try {
    const { nom, description, IDCLASSE, annee, president_id, membres = [] } = req.body;

    if (!nom || !nom.trim()) {
      return res.status(400).json({ message: 'Le nom du jury est requis.' });
    }
    if (!IDCLASSE) {
      return res.status(400).json({ message: 'La classe associée est requise.' });
    }
    if (!annee) {
      return res.status(400).json({ message: 'L’année académique est requise.' });
    }

    // Vérifier la classe
    const [classes] = await connection.query('SELECT IDCLASSE FROM Classe WHERE IDCLASSE = ?', [Number(IDCLASSE)]);
    if (!classes[0]) {
      return res.status(404).json({ message: 'Classe introuvable.' });
    }

    // Vérifier l'année académique
    const [years] = await connection.query('SELECT annee FROM academic_years WHERE annee = ?', [Number(annee)]);
    if (!years[0]) {
      return res.status(404).json({ message: 'Année académique introuvable dans le référentiel.' });
    }

    await connection.beginTransaction();

    const [juryResult] = await connection.query(`
      INSERT INTO jury (nom, description, IDCLASSE, annee, president_id, statut, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIF', ?, NOW(), NOW())
    `, [
      nom.trim(),
      description || null,
      Number(IDCLASSE),
      Number(annee),
      president_id ? Number(president_id) : null,
      req.user.id
    ]);

    const juryId = juryResult.insertId;

    // Si un président est défini, s'assurer qu'il est aussi dans jury_membres avec le rôle PRESIDENT
    const membersToInsert = [...membres];
    if (president_id && !membersToInsert.some(m => Number(m.user_id) === Number(president_id))) {
      membersToInsert.push({ user_id: Number(president_id), role: 'PRESIDENT' });
    }

    for (const membre of membersToInsert) {
      if (!membre.user_id) continue;
      await connection.query(`
        INSERT INTO jury_membres (jury_id, user_id, role, date_assignation, created_at, updated_at)
        VALUES (?, ?, ?, NOW(), NOW(), NOW())
        ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = NOW()
      `, [juryId, Number(membre.user_id), membre.role || 'MEMBRE']);
    }

    await connection.commit();

    const created = await getJuryWithDetails(juryId);
    await audit({
      user: req.user,
      action: 'CREATE',
      module: 'JURY',
      resourceType: 'jury',
      resourceId: juryId,
      description: `Création du jury : ${nom}`,
      newValues: created,
      request: req
    });

    res.status(201).json(created);
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Modification d'un jury existant
// ----------------------------------------------------------------------
async function updateJury(req, res, next) {
  const connection = await pool.getConnection();
  try {
    const juryId = Number(req.params.id);
    const existing = await getJuryWithDetails(juryId, connection);
    if (!existing) return res.status(404).json({ message: 'Jury introuvable.' });

    const { nom, description, president_id, statut, IDCLASSE, annee, membres } = req.body;

    await connection.beginTransaction();

    await connection.query(`
      UPDATE jury SET
        nom = COALESCE(?, nom),
        description = COALESCE(?, description),
        president_id = COALESCE(?, president_id),
        statut = COALESCE(?, statut),
        IDCLASSE = COALESCE(?, IDCLASSE),
        annee = COALESCE(?, annee),
        updated_at = NOW()
      WHERE id = ?
    `, [
      nom !== undefined ? nom.trim() : null,
      description !== undefined ? description : null,
      president_id !== undefined ? (president_id ? Number(president_id) : null) : null,
      statut !== undefined ? statut : null,
      IDCLASSE !== undefined ? Number(IDCLASSE) : null,
      annee !== undefined ? Number(annee) : null,
      juryId
    ]);

    if (Array.isArray(membres)) {
      // Synchroniser les membres
      await connection.query('DELETE FROM jury_membres WHERE jury_id = ?', [juryId]);
      for (const membre of membres) {
        if (!membre.user_id) continue;
        await connection.query(`
          INSERT INTO jury_membres (jury_id, user_id, role, date_assignation, created_at, updated_at)
          VALUES (?, ?, ?, NOW(), NOW(), NOW())
        `, [juryId, Number(membre.user_id), membre.role || 'MEMBRE']);
      }
    }

    await connection.commit();

    const updated = await getJuryWithDetails(juryId);
    await audit({
      user: req.user,
      action: 'UPDATE',
      module: 'JURY',
      resourceType: 'jury',
      resourceId: juryId,
      description: `Mise à jour du jury #${juryId}`,
      oldValues: existing,
      newValues: updated,
      request: req
    });

    res.json(updated);
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Suppression d'un jury
// ----------------------------------------------------------------------
async function deleteJury(req, res, next) {
  try {
    const juryId = Number(req.params.id);
    const existing = await getJuryWithDetails(juryId);
    if (!existing) return res.status(404).json({ message: 'Jury introuvable.' });

    // Vérifier les sessions de délibération actives
    const activeSessions = await query(`
      SELECT id, nom_session, statut FROM deliberation_sessions
      WHERE jury_id = ? AND statut IN ('OUVERTE', 'EN_COURS', 'EN_ATTENTE_VALIDATION')
    `, [juryId]);

    if (activeSessions.length > 0) {
      return res.status(409).json({
        message: `Impossible de supprimer ce jury : ${activeSessions.length} session(s) de délibération sont en cours.`,
        activeSessions
      });
    }

    await query('DELETE FROM jury WHERE id = ?', [juryId]);

    await audit({
      user: req.user,
      action: 'DELETE',
      module: 'JURY',
      resourceType: 'jury',
      resourceId: juryId,
      description: `Suppression du jury #${juryId} (${existing.nom})`,
      oldValues: existing,
      request: req
    });

    res.json({ success: true, message: 'Jury supprimé avec succès.' });
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Gestion des membres
// ----------------------------------------------------------------------
async function getJuryMembers(req, res, next) {
  try {
    const juryId = Number(req.params.id);

    // Restriction : un non-admin doit être membre ou président
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(req.user.role);
    if (!isAdmin) {
      const [memberCheck] = await require('../config/mysql').pool.query(
        'SELECT id FROM jury_membres WHERE jury_id = ? AND user_id = ? UNION SELECT id FROM jury WHERE id = ? AND president_id = ?',
        [juryId, req.user.id, juryId, req.user.id]
      );
      if (!memberCheck || memberCheck.length === 0) {
        return res.status(403).json({ message: 'Accès refusé : vous n\'êtes pas membre de ce jury.' });
      }
    }

    const membres = await query(`
      SELECT jm.*, u.name, u.email, u.username
      FROM jury_membres jm
      JOIN users u ON u.id = jm.user_id
      WHERE jm.jury_id = ?
      ORDER BY FIELD(jm.role, 'PRESIDENT', 'SECRETAIRE', 'MEMBRE'), u.name ASC
    `, [juryId]);
    res.json(membres);
  } catch (error) {
    next(error);
  }
}

async function addJuryMember(req, res, next) {
  try {
    const juryId = Number(req.params.id);
    const { user_id, role = 'MEMBRE' } = req.body;

    if (!user_id) return res.status(400).json({ message: 'L’utilisateur est requis.' });

    await query(`
      INSERT INTO jury_membres (jury_id, user_id, role, date_assignation, created_at, updated_at)
      VALUES (?, ?, ?, NOW(), NOW(), NOW())
      ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = NOW()
    `, [juryId, Number(user_id), role]);

    const membres = await query(`
      SELECT jm.*, u.name, u.email, u.username
      FROM jury_membres jm
      JOIN users u ON u.id = jm.user_id
      WHERE jm.jury_id = ? AND jm.user_id = ?
    `, [juryId, Number(user_id)]);

    res.status(201).json(membres[0]);
  } catch (error) {
    next(error);
  }
}

async function removeJuryMember(req, res, next) {
  try {
    const juryId = Number(req.params.id);
    const userId = Number(req.params.user_id);

    await query('DELETE FROM jury_membres WHERE jury_id = ? AND user_id = ?', [juryId, userId]);
    res.json({ success: true, message: 'Membre retiré du jury avec succès.' });
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------
// Options pour les sélecteurs UI (années, classes, enseignants)
// ----------------------------------------------------------------------
async function getOptions(req, res, next) {
  try {
    const [years, classes, teachers] = await Promise.all([
      query('SELECT annee, est_active FROM academic_years ORDER BY annee DESC'),
      query(`
        SELECT c.IDCLASSE, c.NIVEAU, c.CODGRADE,
               f.NOM AS filiere_nom,
               s.INTITULE AS specialite_nom
        FROM Classe c
        LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
        LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
        ORDER BY f.NOM, c.NIVEAU, c.IDCLASSE
      `),
      query(`
        SELECT id, name, email, username FROM users
        WHERE is_active = 1
        ORDER BY name ASC
      `)
    ]);

    res.json({ years, classes, teachers });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listJuries,
  getJury,
  createJury,
  updateJury,
  deleteJury,
  getJuryMembers,
  addJuryMember,
  removeJuryMember,
  getOptions
};
