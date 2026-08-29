const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { pool, query } = require('../config/mysql');
const { audit } = require('./audit.service');

// ----------------------------------------------------------------------
// Helpers numériques & Utilitaires
// ----------------------------------------------------------------------
const round2 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

const getLogoPath = () => {
  const candidates = [
    path.join(__dirname, '../../ressources/images/uy1_logo.png'),
    path.join(__dirname, '../ressources/images/uy1_logo.png'),
    path.join(__dirname, '../../../ressources/images/uy1_logo.png'),
    path.join(process.cwd(), 'ressources/images/uy1_logo.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const getGradeLocal = (score100) => {
  if (score100 === null || score100 === undefined) return '-';
  if (score100 >= 80) return 'A';
  if (score100 >= 75) return 'A-';
  if (score100 >= 70) return 'B+';
  if (score100 >= 65) return 'B';
  if (score100 >= 60) return 'B-';
  if (score100 >= 55) return 'C+';
  if (score100 >= 50) return 'C';
  if (score100 >= 45) return 'C-';
  if (score100 >= 40) return 'D+';
  if (score100 >= 35) return 'D';
  if (score100 >= 30) return 'E';
  return 'F';
};

const getQdpLocal = (score100) => {
  if (score100 === null || score100 === undefined) return 0.0;
  if (score100 >= 80) return 4.0;
  if (score100 >= 75) return 3.7;
  if (score100 >= 70) return 3.3;
  if (score100 >= 65) return 3.0;
  if (score100 >= 60) return 2.7;
  if (score100 >= 55) return 2.3;
  if (score100 >= 50) return 2.0;
  if (score100 >= 45) return 1.7;
  if (score100 >= 40) return 1.3;
  if (score100 >= 35) return 1.0;
  if (score100 >= 30) return 0.5;
  return 0.0;
};

const getMentionLocal = (score100) => {
  if (score100 === null || score100 === undefined) return '-';
  if (score100 >= 80) return 'EX';
  if (score100 >= 75) return 'TB';
  if (score100 >= 70) return 'B';
  if (score100 >= 65) return 'B';
  if (score100 >= 60) return 'AB';
  if (score100 >= 55) return 'AB';
  if (score100 >= 50) return 'P';
  if (score100 >= 45) return 'P';
  if (score100 >= 40) return 'P';
  return 'F';
};

const getDecisionLocal = (score100) => {
  if (score100 === null || score100 === undefined || Number.isNaN(Number(score100))) return 'NV';
  return Number(score100) >= 50 ? 'VAL' : 'NV';
};

// ----------------------------------------------------------------------
// Évaluation de conditions dynamiques
// ----------------------------------------------------------------------
function evaluateCondition(studentData, condition) {
  if (!condition) return true;

  try {
    let parsed = condition;
    if (typeof condition === 'string') {
      const trimmed = condition.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        parsed = JSON.parse(trimmed);
      } else {
        // Ex: "SN < 35", "MOYENNE < 50", "GLOBAL >= 45", "CC <= 10"
        const match = trimmed.match(/^([a-zA-Z_]+)\s*(<=|>=|<|>|!=|=|==)\s*([0-9.]+)/i);
        if (match) {
          parsed = {
            colonne: match[1].toUpperCase(),
            operateur: match[2] === '==' ? '=' : match[2],
            valeur: parseFloat(match[3])
          };
        } else {
          return true; // Expression non parsable = passe
        }
      }
    }

    const col = (parsed.colonne || parsed.column || '').toUpperCase();
    const op = parsed.operateur || parsed.operator || '=';
    const val = parseFloat(parsed.valeur ?? parsed.value ?? 0);

    let studentVal = null;
    if (col === 'SN' || col === 'NOTE_SN') studentVal = studentData.note_sn;
    else if (col === 'CC' || col === 'NOTE_CC') studentVal = studentData.note_cc;
    else if (col === 'TP' || col === 'NOTE_TP') studentVal = studentData.note_tp;
    else if (col === 'MOYENNE' || col === 'GLOBAL' || col === 'MOY') studentVal = studentData.moyenne ?? studentData.nouvelle_moyenne ?? studentData.ancienne_moyenne;
    else if (col === 'MGP') studentVal = studentData.mgp;
    else if (studentData[col] !== undefined) studentVal = studentData[col];
    else if (studentData[col.toLowerCase()] !== undefined) studentVal = studentData[col.toLowerCase()];

    if (studentVal === null || studentVal === undefined || isNaN(Number(studentVal))) return false;
    const num = Number(studentVal);

    switch (op) {
      case '<': return num < val;
      case '<=': return num <= val;
      case '>': return num > val;
      case '>=': return num >= val;
      case '=': return Math.abs(num - val) < 0.001;
      case '!=': return Math.abs(num - val) >= 0.001;
      default: return true;
    }
  } catch (err) {
    console.warn('Erreur parsing condition:', err);
    return true;
  }
}

// ----------------------------------------------------------------------
// Lecture détaillée d'un jury
// ----------------------------------------------------------------------
async function getJuryWithDetails(juryId, connection = null) {
  const runner = connection || { query: (s, p) => query(s, p) };
  const juries = await runner.query(`
    SELECT j.*,
           c.NIVEAU, c.CODGRADE,
           f.NOM AS filiere_nom,
           s.INTITULE AS specialite_nom,
           u.name AS president_nom, u.email AS president_email
    FROM jury j
    LEFT JOIN Classe c ON c.IDCLASSE = j.IDCLASSE
    LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
    LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
    LEFT JOIN users u ON u.id = j.president_id
    WHERE j.id = ?
    LIMIT 1
  `, [juryId]);

  if (!juries[0]) return null;
  const juryObj = juries[0];

  const membres = await runner.query(`
    SELECT jm.*, u.name, u.email, u.username
    FROM jury_membres jm
    JOIN users u ON u.id = jm.user_id
    WHERE jm.jury_id = ?
    ORDER BY FIELD(jm.role, 'PRESIDENT', 'SECRETAIRE', 'MEMBRE'), u.name ASC
  `, [juryId]);

  juryObj.membres = membres;
  return juryObj;
}

// ----------------------------------------------------------------------
// Lecture détaillée d'une session de délibération
// ----------------------------------------------------------------------
async function getSessionWithDetails(sessionId, connection = null) {
  const runner = connection || { query: (s, p) => query(s, p) };
  const sessions = await runner.query(`
    SELECT s.*,
           j.nom AS jury_nom, j.IDCLASSE, j.annee, j.president_id,
           c.NIVEAU, c.CODGRADE,
           f.NOM AS filiere_nom,
           sp.INTITULE AS specialite_nom,
           creator.name AS creator_name,
           locker.name AS locked_by_name
    FROM deliberation_sessions s
    JOIN jury j ON j.id = s.jury_id
    LEFT JOIN Classe c ON c.IDCLASSE = j.IDCLASSE
    LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
    LEFT JOIN Specialite sp ON sp.IDSPECIALITE = c.IDSPECIALITE
    LEFT JOIN users creator ON creator.id = s.created_by
    LEFT JOIN users locker ON locker.id = s.verrouille_par
    WHERE s.id = ?
    LIMIT 1
  `, [sessionId]);

  if (!sessions[0]) return null;
  const session = sessions[0];

  const [membres, validations, actions, tempNotesSummary] = await Promise.all([
    runner.query(`
      SELECT jm.*, u.name, u.email, u.username
      FROM jury_membres jm
      JOIN users u ON u.id = jm.user_id
      WHERE jm.jury_id = ?
      ORDER BY FIELD(jm.role, 'PRESIDENT', 'SECRETAIRE', 'MEMBRE'), u.name ASC
    `, [session.jury_id]),
    runner.query(`
      SELECT dv.*, u.name AS user_name, u.email AS user_email
      FROM deliberation_validations dv
      JOIN users u ON u.id = dv.user_id
      WHERE dv.session_id = ?
    `, [sessionId]),
    runner.query(`
      SELECT da.*, u.name AS execute_par_nom, uv.name AS valide_par_nom
      FROM deliberation_actions da
      JOIN users u ON u.id = da.execute_par
      LEFT JOIN users uv ON uv.id = da.valide_par
      WHERE da.session_id = ?
      ORDER BY da.date_execution DESC
    `, [sessionId]),
    runner.query(`
      SELECT COUNT(*) AS total_notes_modifiees,
             COUNT(DISTINCT MATRICULE) AS etudiants_touches
      FROM deliberation_temp_notes
      WHERE session_id = ?
    `, [sessionId])
  ]);

  session.membres = membres;
  session.validations = validations;
  session.actions = actions;
  session.stats = {
    total_notes_modifiees: Number(tempNotesSummary[0]?.total_notes_modifiees || 0),
    etudiants_touches: Number(tempNotesSummary[0]?.etudiants_touches || 0),
    membres_total: membres.length,
    validations_count: validations.filter(v => v.validation === 'APPROUVE').length,
    rejections_count: validations.filter(v => v.validation === 'REJECT').length,
    abstentions_count: validations.filter(v => v.validation === 'ABSTAIN').length
  };

  return session;
}

// ----------------------------------------------------------------------
// Chargement du roster étudiant et des notes pour une session
// ----------------------------------------------------------------------
async function getSessionRosterAndGrades(session, connection = null) {
  const runner = connection || { query: (s, p) => query(s, p) };
  const { IDCLASSE, annee, id: session_id } = session;

  // 1. Liste des étudiants inscrits
  const etudiants = await runner.query(`
    SELECT e.MATRICULE, e.NOM, e.SEXE, i.IDCLASSE, i.ANNEE
    FROM Inscript i
    JOIN Etudiant e ON e.MATRICULE = i.MATRICULE
    WHERE i.IDCLASSE = ? AND i.ANNEE = ?
    ORDER BY e.NOM ASC
  `, [IDCLASSE, annee]);

  // 2. UEs du programme
  const ues = await runner.query(`
    SELECT p.IDUE, u.CODUE, u.INTITULE, p.CREDIT, ps.IDSEMESTRE
    FROM Programme p
    JOIN UE u ON u.IDUE = p.IDUE
    LEFT JOIN programme_semestres ps ON ps.IDCLASSE = p.IDCLASSE AND ps.IDUE = p.IDUE AND ps.ANNEE = p.ANNEE
    WHERE p.IDCLASSE = ? AND p.ANNEE = ?
    ORDER BY ps.IDSEMESTRE, u.CODUE
  `, [IDCLASSE, annee]);

  // 3. Notes actuelles dans Moyennes
  const moyennes = await runner.query(`
    SELECT m.MATRICULE, m.IDUE, m.IDSEMESTRE, m.ANNEE, m.MOYENNE, m.CREDIT, m.QdP, m.CODMENTION, m.Decision
    FROM Moyennes m
    WHERE m.MATRICULE IN (SELECT MATRICULE FROM Inscript WHERE IDCLASSE = ? AND ANNEE = ?)
      AND m.ANNEE = ?
  `, [IDCLASSE, annee, annee]);

  // 4. Notes de composantes actuelles dans notes
  const notesComposantes = await runner.query(`
    SELECT n.MATRICULE, e.IDUE, n.IDEC, n.note_cc, n.note_tp, n.note_sn, n.moyenne_ec
    FROM notes n
    JOIN ec e ON e.IDEC = n.IDEC
    WHERE n.IDCLASSE = ? AND n.ANNEE = ?
  `, [IDCLASSE, annee]);

  // 5. Notes temporaires déjà enregistrées pour cette session
  const tempNotes = await runner.query(`
    SELECT * FROM deliberation_temp_notes
    WHERE session_id = ?
  `, [session_id]);

  return { etudiants, ues, moyennes, notesComposantes, tempNotes };
}

// ----------------------------------------------------------------------
// Construction du tableau de bord complet (Avant / Après)
// ----------------------------------------------------------------------
function buildCombinedGradebook(rosterData) {
  const { etudiants, ues, moyennes, notesComposantes, tempNotes } = rosterData;

  const moyennesMap = new Map();
  moyennes.forEach(m => moyennesMap.set(`${m.MATRICULE}_${m.IDUE}`, m));

  const compNotesMap = new Map();
  notesComposantes.forEach(n => {
    const key = `${n.MATRICULE}_${n.IDUE}`;
    if (!compNotesMap.has(key)) compNotesMap.set(key, []);
    compNotesMap.get(key).push(n);
  });

  const tempNotesMap = new Map();
  tempNotes.forEach(t => tempNotesMap.set(`${t.MATRICULE}_${t.IDUE}`, t));

  return etudiants.map(etudiant => {
    let totalCredits = 0;
    let totalOriginalWeighted = 0;
    let totalCurrentWeighted = 0;
    let validatedCredits = 0;
    let originalValidatedCredits = 0;

    const ueGrades = ues.map(ue => {
      const key = `${etudiant.MATRICULE}_${ue.IDUE}`;
      const originalMoy = moyennesMap.get(key);
      const comps = compNotesMap.get(key) || [];
      const tempNote = tempNotesMap.get(key);

      const origMoyVal = originalMoy && originalMoy.MOYENNE !== null ? Number(originalMoy.MOYENNE) : null;

      let noteCcOrig = comps[0]?.note_cc !== undefined && comps[0]?.note_cc !== null ? Number(comps[0].note_cc) : null;
      let noteTpOrig = comps[0]?.note_tp !== undefined && comps[0]?.note_tp !== null ? Number(comps[0].note_tp) : null;
      let noteSnOrig = comps[0]?.note_sn !== undefined && comps[0]?.note_sn !== null ? Number(comps[0].note_sn) : null;

      let currMoyVal = origMoyVal;
      let currCcVal = noteCcOrig;
      let currTpVal = noteTpOrig;
      let currSnVal = noteSnOrig;
      let isModified = false;
      let pointsAjoutes = 0;

      if (tempNote) {
        isModified = true;
        currMoyVal = tempNote.nouvelle_moyenne !== null ? Number(tempNote.nouvelle_moyenne) : currMoyVal;
        currCcVal = tempNote.note_cc_nouveau !== null ? Number(tempNote.note_cc_nouveau) : currCcVal;
        currTpVal = tempNote.note_tp_nouveau !== null ? Number(tempNote.note_tp_nouveau) : currTpVal;
        currSnVal = tempNote.note_sn_nouveau !== null ? Number(tempNote.note_sn_nouveau) : currSnVal;
        pointsAjoutes = Number(tempNote.points_ajoutes || 0);
      }

      const credit = Number(ue.CREDIT || 0);
      totalCredits += credit;
      if (origMoyVal !== null) {
        totalOriginalWeighted += (origMoyVal * credit);
        if (origMoyVal >= 50) originalValidatedCredits += credit;
      }
      if (currMoyVal !== null) {
        totalCurrentWeighted += (currMoyVal * credit);
        if (currMoyVal >= 50) validatedCredits += credit;
      }

      return {
        IDUE: ue.IDUE,
        CODUE: ue.CODUE,
        INTITULE: ue.INTITULE,
        CREDIT: credit,
        IDSEMESTRE: ue.IDSEMESTRE,
        original: {
          moyenne: origMoyVal,
          note_cc: noteCcOrig,
          note_tp: noteTpOrig,
          note_sn: noteSnOrig,
          grade: getGradeLocal(origMoyVal),
          qdp: getQdpLocal(origMoyVal),
          mention: getMentionLocal(origMoyVal),
          decision: getDecisionLocal(origMoyVal)
        },
        current: {
          moyenne: currMoyVal,
          note_cc: currCcVal,
          note_tp: currTpVal,
          note_sn: currSnVal,
          grade: getGradeLocal(currMoyVal),
          qdp: getQdpLocal(currMoyVal),
          mention: getMentionLocal(currMoyVal),
          decision: getDecisionLocal(currMoyVal),
          isModified,
          pointsAjoutes,
          tempNoteId: tempNote?.id || null
        }
      };
    });

    const originalAnnualAverage = totalCredits > 0 ? round2(totalOriginalWeighted / totalCredits) : 0;
    const currentAnnualAverage = totalCredits > 0 ? round2(totalCurrentWeighted / totalCredits) : 0;

    return {
      matricule: etudiant.MATRICULE,
      nom: etudiant.NOM,
      sexe: etudiant.SEXE,
      ues: ueGrades,
      original_summary: {
        moyenne_annuelle: originalAnnualAverage,
        credits_valides: originalValidatedCredits,
        total_credits: totalCredits,
        mgp: getQdpLocal(originalAnnualAverage),
        grade: getGradeLocal(originalAnnualAverage),
        decision: originalAnnualAverage >= 50 ? 'ADMIS' : 'AJOURNE'
      },
      current_summary: {
        moyenne_annuelle: currentAnnualAverage,
        credits_valides: validatedCredits,
        total_credits: totalCredits,
        mgp: getQdpLocal(currentAnnualAverage),
        grade: getGradeLocal(currentAnnualAverage),
        decision: currentAnnualAverage >= 50 ? 'ADMIS' : 'AJOURNE',
        is_improved: currentAnnualAverage > originalAnnualAverage || validatedCredits > originalValidatedCredits
      }
    };
  });
}

// ----------------------------------------------------------------------
// Prévisualisation d'une action de délibération
// ----------------------------------------------------------------------
async function previewDeliberationAction(sessionId, params) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });

  const rosterData = await getSessionRosterAndGrades(session);
  const { ues } = rosterData;
  const gradebook = buildCombinedGradebook(rosterData);

  const {
    type_action,
    type_cible = 'TOUS',
    condition_cible = null,
    etudiants_concernes = [],
    IDUE = null,
    points_a_ajouter = 0,
    moyenne_cible = null,
    composante_cible = 'GLOBAL',
    composante_sn_only = false
  } = params;

  const points = parseFloat(points_a_ajouter || 0);
  const targetMoy = moyenne_cible !== null ? parseFloat(moyenne_cible) : null;
  const targetUe = IDUE ? ues.find(u => u.IDUE === Number(IDUE)) : null;

  const affectedStudents = [];
  const apercuAvant = [];
  const apercuApres = [];

  for (const student of gradebook) {
    let isTargeted = false;

    if (type_cible === 'ETUDIANT_SPECIFIQUE') {
      isTargeted = Array.isArray(etudiants_concernes) && etudiants_concernes.includes(student.matricule);
    } else if (type_cible === 'TOUS') {
      isTargeted = true;
    } else if (type_cible === 'CONDITION') {
      if (IDUE) {
        const ueData = student.ues.find(u => u.IDUE === Number(IDUE));
        if (ueData) {
          isTargeted = evaluateCondition({
            note_sn: ueData.current.note_sn,
            note_cc: ueData.current.note_cc,
            note_tp: ueData.current.note_tp,
            moyenne: ueData.current.moyenne,
            mgp: student.current_summary.mgp
          }, condition_cible);
        }
      } else {
        isTargeted = evaluateCondition({
          moyenne: student.current_summary.moyenne_annuelle,
          mgp: student.current_summary.mgp
        }, condition_cible);
      }
    }

    if (!isTargeted) continue;

    affectedStudents.push(student.matricule);
    const beforeState = {
      matricule: student.matricule,
      nom: student.nom,
      moyenne_annuelle: student.current_summary.moyenne_annuelle,
      credits_valides: student.current_summary.credits_valides,
      decision: student.current_summary.decision,
      modifications: []
    };

    const afterState = {
      matricule: student.matricule,
      nom: student.nom,
      moyenne_annuelle: student.current_summary.moyenne_annuelle,
      credits_valides: student.current_summary.credits_valides,
      decision: student.current_summary.decision,
      modifications: []
    };

    if (type_action === 'AJOUT_POINTS') {
      const uesToModify = targetUe ? [targetUe] : ues;

      uesToModify.forEach(ue => {
        const currUe = student.ues.find(u => u.IDUE === ue.IDUE);
        if (!currUe) return;

        const oldMoy = currUe.current.moyenne ?? 0;
        let newMoy = oldMoy;
        let oldSn = currUe.current.note_sn;
        let newSn = oldSn;
        let oldCc = currUe.current.note_cc;
        let newCc = oldCc;
        let oldTp = currUe.current.note_tp;
        let newTp = oldTp;

        if (composante_cible === 'SN' || composante_sn_only) {
          if (oldSn !== null) {
            newSn = Math.min(100, Math.max(0, round2(oldSn + points)));
            newMoy = Math.min(100, Math.max(0, round2(oldMoy + points)));
          } else {
            newMoy = Math.min(100, Math.max(0, round2(oldMoy + points)));
          }
        } else if (composante_cible === 'CC') {
          if (oldCc !== null) newCc = Math.min(100, Math.max(0, round2(oldCc + points)));
          newMoy = Math.min(100, Math.max(0, round2(oldMoy + points)));
        } else if (composante_cible === 'TP') {
          if (oldTp !== null) newTp = Math.min(100, Math.max(0, round2(oldTp + points)));
          newMoy = Math.min(100, Math.max(0, round2(oldMoy + points)));
        } else {
          newMoy = Math.min(100, Math.max(0, round2(oldMoy + points)));
        }

        beforeState.modifications.push({
          IDUE: ue.IDUE,
          CODUE: ue.CODUE,
          ancienne_moyenne: oldMoy,
          note_sn_ancien: oldSn,
          note_cc_ancien: oldCc,
          note_tp_ancien: oldTp
        });

        afterState.modifications.push({
          IDUE: ue.IDUE,
          CODUE: ue.CODUE,
          points_ajoutes: points,
          nouvelle_moyenne: newMoy,
          note_sn_nouveau: newSn,
          note_cc_nouveau: newCc,
          note_tp_nouveau: newTp
        });
      });
    } else if (type_action === 'MOYENNE_CIBLE' && targetMoy !== null) {
      if (targetUe) {
        const currUe = student.ues.find(u => u.IDUE === targetUe.IDUE);
        if (currUe) {
          const oldMoy = currUe.current.moyenne ?? 0;
          const diff = round2(targetMoy - oldMoy);
          if (diff > 0) {
            const newMoy = Math.min(100, targetMoy);
            const oldSn = currUe.current.note_sn;
            const newSn = oldSn !== null ? Math.min(100, round2(oldSn + diff)) : null;

            beforeState.modifications.push({
              IDUE: targetUe.IDUE,
              CODUE: targetUe.CODUE,
              ancienne_moyenne: oldMoy,
              note_sn_ancien: oldSn
            });

            afterState.modifications.push({
              IDUE: targetUe.IDUE,
              CODUE: targetUe.CODUE,
              points_ajoutes: diff,
              nouvelle_moyenne: newMoy,
              note_sn_nouveau: newSn
            });
          }
        }
      } else {
        // Moyenne cible globale annuelle
        const currentAnnual = student.current_summary.moyenne_annuelle;
        const diffAnnual = round2(targetMoy - currentAnnual);
        if (diffAnnual > 0) {
          // Ajuster proportionnellement ou uniformément sur les UEs non validées
          const nonValidated = student.ues.filter(u => (u.current.moyenne ?? 0) < 50);
          const targets = nonValidated.length > 0 ? nonValidated : student.ues;
          const ptsPerUe = round2(diffAnnual * (student.ues.length / targets.length));

          targets.forEach(ue => {
            const oldMoy = ue.current.moyenne ?? 0;
            const newMoy = Math.min(100, round2(oldMoy + ptsPerUe));
            const oldSn = ue.current.note_sn;
            const newSn = oldSn !== null ? Math.min(100, round2(oldSn + ptsPerUe)) : null;

            beforeState.modifications.push({
              IDUE: ue.IDUE,
              CODUE: ue.CODUE,
              ancienne_moyenne: oldMoy,
              note_sn_ancien: oldSn
            });

            afterState.modifications.push({
              IDUE: ue.IDUE,
              CODUE: ue.CODUE,
              points_ajoutes: ptsPerUe,
              nouvelle_moyenne: newMoy,
              note_sn_nouveau: newSn
            });
          });
        }
      }
    }

    if (beforeState.modifications.length > 0) {
      apercuAvant.push(beforeState);
      apercuApres.push(afterState);
    }
  }

  return {
    affected_students_count: affectedStudents.length,
    affected_matricules: affectedStudents,
    apercu_avant: apercuAvant,
    apercu_apres: apercuApres
  };
}

// ----------------------------------------------------------------------
// Exécution d'une action "Ajout de points"
// ----------------------------------------------------------------------
async function executeAjoutPoints(sessionId, params, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (session.verrouille_par) throw Object.assign(new Error('Session verrouillée.'), { status: 423 });
  if (!['OUVERTE', 'EN_COURS'].includes(session.statut)) {
    throw Object.assign(new Error('La session doit être OUVERTE ou EN_COURS pour effectuer des actions.'), { status: 409 });
  }

  const preview = await previewDeliberationAction(sessionId, {
    ...params,
    type_action: 'AJOUT_POINTS'
  });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [actionRes] = await connection.query(`
      INSERT INTO deliberation_actions (
        session_id, type_action, cible_type, condition_cible, IDUE,
        points_a_ajouter, moyenne_cible, composante_sn_only, etudiants_concernes,
        apercu_avant, apercu_apres, execute_par, date_execution, valide, created_at, updated_at
      ) VALUES (?, 'AJOUT_POINTS', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NOW(), 1, NOW(), NOW())
    `, [
      sessionId,
      params.type_cible || 'TOUS',
      params.condition_cible || null,
      params.IDUE ? Number(params.IDUE) : null,
      params.points_a_ajouter || 0,
      params.composante_cible === 'SN' || params.composante_sn_only ? 1 : 0,
      JSON.stringify(preview.affected_matricules),
      JSON.stringify(preview.apercu_avant),
      JSON.stringify(preview.apercu_apres),
      user.id
    ]);

    const actionId = actionRes.insertId;

    // Mise à jour de deliberation_temp_notes
    for (const item of preview.apercu_apres) {
      const matricule = item.matricule;
      for (const mod of item.modifications) {
        const [semRows] = await connection.query(`
          SELECT ps.IDSEMESTRE FROM programme_semestres ps
          WHERE ps.IDCLASSE = ? AND ps.IDUE = ? AND ps.ANNEE = ? LIMIT 1
        `, [session.IDCLASSE, mod.IDUE, session.annee]);
        const idSemestre = semRows[0]?.IDSEMESTRE || 1;

        await connection.query(`
          INSERT INTO deliberation_temp_notes (
            session_id, MATRICULE, IDUE, IDSEMESTRE, ANNEE,
            ancienne_moyenne, nouvelle_moyenne, points_ajoutes, composante_cible,
            note_cc_ancien, note_cc_nouveau, note_tp_ancien, note_tp_nouveau,
            note_sn_ancien, note_sn_nouveau, motif, modifie_par, date_modification,
            valide, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            ancienne_moyenne = VALUES(ancienne_moyenne),
            nouvelle_moyenne = VALUES(nouvelle_moyenne),
            points_ajoutes = VALUES(points_ajoutes),
            composante_cible = VALUES(composante_cible),
            note_cc_ancien = VALUES(note_cc_ancien),
            note_cc_nouveau = VALUES(note_cc_nouveau),
            note_tp_ancien = VALUES(note_tp_ancien),
            note_tp_nouveau = VALUES(note_tp_nouveau),
            note_sn_ancien = VALUES(note_sn_ancien),
            note_sn_nouveau = VALUES(note_sn_nouveau),
            motif = VALUES(motif),
            modifie_par = VALUES(modifie_par),
            date_modification = NOW(),
            valide = 1,
            updated_at = NOW()
        `, [
          sessionId, matricule, mod.IDUE, idSemestre, session.annee,
          mod.ancienne_moyenne ?? null, mod.nouvelle_moyenne ?? null, mod.points_ajoutes ?? null,
          params.composante_cible || 'GLOBAL',
          mod.note_cc_ancien ?? null, mod.note_cc_nouveau ?? null,
          mod.note_tp_ancien ?? null, mod.note_tp_nouveau ?? null,
          mod.note_sn_ancien ?? null, mod.note_sn_nouveau ?? null,
          params.motif || 'Délibération jury - Ajout de points',
          user.id
        ]);
      }
    }

    if (session.statut === 'OUVERTE') {
      await connection.query('UPDATE deliberation_sessions SET statut = "EN_COURS", updated_at = NOW() WHERE id = ?', [sessionId]);
    }

    await connection.commit();

    await audit({
      user,
      action: 'EXECUTE',
      module: 'JURY',
      resourceType: 'deliberation_actions',
      resourceId: actionId,
      description: `Ajout de points (+${params.points_a_ajouter}) sur la session #${sessionId}`,
      newValues: { sessionId, actionId, affected_count: preview.affected_students_count },
      request: req
    });

    return { success: true, action_id: actionId, preview };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Exécution d'une action "Moyenne Cible"
// ----------------------------------------------------------------------
async function executeMoyenneCible(sessionId, params, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (session.verrouille_par) throw Object.assign(new Error('Session verrouillée.'), { status: 423 });
  if (!['OUVERTE', 'EN_COURS'].includes(session.statut)) {
    throw Object.assign(new Error('La session doit être OUVERTE ou EN_COURS pour effectuer des actions.'), { status: 409 });
  }

  const preview = await previewDeliberationAction(sessionId, {
    ...params,
    type_action: 'MOYENNE_CIBLE'
  });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [actionRes] = await connection.query(`
      INSERT INTO deliberation_actions (
        session_id, type_action, cible_type, condition_cible, IDUE,
        points_a_ajouter, moyenne_cible, composante_sn_only, etudiants_concernes,
        apercu_avant, apercu_apres, execute_par, date_execution, valide, created_at, updated_at
      ) VALUES (?, 'MOYENNE_CIBLE', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NOW(), 1, NOW(), NOW())
    `, [
      sessionId,
      params.type_cible || 'TOUS',
      params.condition_cible || null,
      params.IDUE ? Number(params.IDUE) : null,
      params.moyenne_cible,
      params.composante_sn_only ? 1 : 0,
      JSON.stringify(preview.affected_matricules),
      JSON.stringify(preview.apercu_avant),
      JSON.stringify(preview.apercu_apres),
      user.id
    ]);

    const actionId = actionRes.insertId;

    for (const item of preview.apercu_apres) {
      const matricule = item.matricule;
      for (const mod of item.modifications) {
        const [semRows] = await connection.query(`
          SELECT ps.IDSEMESTRE FROM programme_semestres ps
          WHERE ps.IDCLASSE = ? AND ps.IDUE = ? AND ps.ANNEE = ? LIMIT 1
        `, [session.IDCLASSE, mod.IDUE, session.annee]);
        const idSemestre = semRows[0]?.IDSEMESTRE || 1;

        await connection.query(`
          INSERT INTO deliberation_temp_notes (
            session_id, MATRICULE, IDUE, IDSEMESTRE, ANNEE,
            ancienne_moyenne, nouvelle_moyenne, points_ajoutes, composante_cible,
            note_cc_ancien, note_cc_nouveau, note_tp_ancien, note_tp_nouveau,
            note_sn_ancien, note_sn_nouveau, motif, modifie_par, date_modification,
            valide, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            ancienne_moyenne = VALUES(ancienne_moyenne),
            nouvelle_moyenne = VALUES(nouvelle_moyenne),
            points_ajoutes = VALUES(points_ajoutes),
            composante_cible = VALUES(composante_cible),
            note_cc_ancien = VALUES(note_cc_ancien),
            note_cc_nouveau = VALUES(note_cc_nouveau),
            note_tp_ancien = VALUES(note_tp_ancien),
            note_tp_nouveau = VALUES(note_tp_nouveau),
            note_sn_ancien = VALUES(note_sn_ancien),
            note_sn_nouveau = VALUES(note_sn_nouveau),
            motif = VALUES(motif),
            modifie_par = VALUES(modifie_par),
            date_modification = NOW(),
            valide = 1,
            updated_at = NOW()
        `, [
          sessionId, matricule, mod.IDUE, idSemestre, session.annee,
          mod.ancienne_moyenne ?? null, mod.nouvelle_moyenne ?? null, mod.points_ajoutes ?? null,
          'GLOBAL',
          null, null, null, null,
          mod.note_sn_ancien ?? null, mod.note_sn_nouveau ?? null,
          params.motif || `Délibération jury - Moyenne cible (${params.moyenne_cible})`,
          user.id
        ]);
      }
    }

    if (session.statut === 'OUVERTE') {
      await connection.query('UPDATE deliberation_sessions SET statut = "EN_COURS", updated_at = NOW() WHERE id = ?', [sessionId]);
    }

    await connection.commit();

    await audit({
      user,
      action: 'EXECUTE',
      module: 'JURY',
      resourceType: 'deliberation_actions',
      resourceId: actionId,
      description: `Moyenne cible (${params.moyenne_cible}) appliquée sur la session #${sessionId}`,
      newValues: { sessionId, actionId, affected_count: preview.affected_students_count },
      request: req
    });

    return { success: true, action_id: actionId, preview };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Cycle de vie des sessions
// ----------------------------------------------------------------------
async function openSession(sessionId, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (session.statut !== 'PREPARATION') {
    throw Object.assign(new Error('Seule une session en statut PREPARATION peut être ouverte.'), { status: 409 });
  }

  await query('UPDATE deliberation_sessions SET statut = "OUVERTE", date_debut = COALESCE(date_debut, NOW()), updated_at = NOW() WHERE id = ?', [sessionId]);
  await audit({ user, action: 'UPDATE', module: 'JURY', resourceType: 'deliberation_sessions', resourceId: sessionId, description: `Ouverture de la session de délibération #${sessionId}`, request: req });
  return getSessionWithDetails(sessionId);
}

async function startSession(sessionId, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (session.statut !== 'OUVERTE') {
    throw Object.assign(new Error('Seule une session OUVERTE peut passer en cours.'), { status: 409 });
  }

  await query('UPDATE deliberation_sessions SET statut = "EN_COURS", updated_at = NOW() WHERE id = ?', [sessionId]);
  await audit({ user, action: 'UPDATE', module: 'JURY', resourceType: 'deliberation_sessions', resourceId: sessionId, description: `Démarrage de la délibération #${sessionId}`, request: req });
  return getSessionWithDetails(sessionId);
}

async function requestValidation(sessionId, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (!['EN_COURS', 'OUVERTE'].includes(session.statut)) {
    throw Object.assign(new Error('La session doit être EN_COURS pour demander la validation.'), { status: 409 });
  }

  await query('UPDATE deliberation_sessions SET statut = "EN_ATTENTE_VALIDATION", updated_at = NOW() WHERE id = ?', [sessionId]);
  await audit({ user, action: 'UPDATE', module: 'JURY', resourceType: 'deliberation_sessions', resourceId: sessionId, description: `Demande de validation jury pour la session #${sessionId}`, request: req });
  return getSessionWithDetails(sessionId);
}

async function submitValidation(sessionId, user, { validation, commentaire }, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });

  const isMember = session.membres.some(m => Number(m.user_id) === Number(user.id)) || user.role === 'SUPER_ADMIN';
  if (!isMember) {
    throw Object.assign(new Error('Vous devez faire partie du jury pour émettre un vote de validation.'), { status: 403 });
  }

  if (!['APPROUVE', 'REJECT', 'ABSTAIN'].includes(validation)) {
    throw Object.assign(new Error('Valeur de validation invalide (APPROUVE, REJECT, ABSTAIN).'), { status: 400 });
  }

  await query(`
    INSERT INTO deliberation_validations (session_id, jury_id, user_id, validation, commentaire, date_validation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      validation = VALUES(validation),
      commentaire = VALUES(commentaire),
      date_validation = NOW(),
      updated_at = NOW()
  `, [sessionId, session.jury_id, user.id, validation, commentaire || null]);

  await audit({
    user,
    action: 'VALIDATE',
    module: 'JURY',
    resourceType: 'deliberation_validations',
    resourceId: sessionId,
    description: `Vote [${validation}] par ${user.name} sur la session #${sessionId}`,
    request: req
  });

  return getSessionWithDetails(sessionId);
}

// ----------------------------------------------------------------------
// Clôture d'une session et application définitive des notes
// ----------------------------------------------------------------------
async function closeSession(sessionId, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (session.statut === 'CLOTURE') throw Object.assign(new Error('Session déjà clôturée.'), { status: 409 });
  if (session.verrouille_par) throw Object.assign(new Error('Session verrouillée.'), { status: 423 });

  // Vérifier si des validations existent
  const totalMembres = session.membres.length;
  const approvals = session.validations.filter(v => v.validation === 'APPROUVE').length;
  const rejections = session.validations.filter(v => v.validation === 'REJECT').length;

  if (rejections > 0 && user.role !== 'SUPER_ADMIN') {
    throw Object.assign(new Error(`Clôture impossible : ${rejections} membre(s) du jury ont rejeté la délibération.`), { status: 409 });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Lire les notes temporaires
    const [tempNotes] = await connection.query(`
      SELECT * FROM deliberation_temp_notes WHERE session_id = ?
    `, [sessionId]);

    // 2. Mettre à jour Moyennes et notes (composantes)
    for (const tn of tempNotes) {
      if (tn.nouvelle_moyenne !== null) {
        const [currMoy] = await connection.query(`
          SELECT * FROM Moyennes WHERE MATRICULE = ? AND IDUE = ? AND IDSEMESTRE = ? AND ANNEE = ?
        `, [tn.MATRICULE, tn.IDUE, tn.IDSEMESTRE, tn.ANNEE]);

        const oldVal = currMoy[0] || null;
        const newMoyenne = Number(tn.nouvelle_moyenne);
        const codMention = getMentionLocal(newMoyenne);
        const qdp = getQdpLocal(newMoyenne);
        const decision = newMoyenne >= 50 ? 'VAL' : 'NV';

        await connection.query(`
          INSERT INTO Moyennes (MATRICULE, IDUE, IDSEMESTRE, ANNEE, MOYENNE, CODMENTION, QdP, Decision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            MOYENNE = VALUES(MOYENNE),
            CODMENTION = VALUES(CODMENTION),
            QdP = VALUES(QdP),
            Decision = VALUES(Decision),
            updated_at = NOW()
        `, [tn.MATRICULE, tn.IDUE, tn.IDSEMESTRE, tn.ANNEE, newMoyenne, codMention, qdp, decision]);

        await connection.query(`
          INSERT INTO moyenne_audit (MATRICULE, IDUE, IDSEMESTRE, ANNEE, action, old_values, new_values, motif, user_id)
          VALUES (?, ?, ?, ?, 'UPDATE', ?, ?, ?, ?)
        `, [
          tn.MATRICULE, tn.IDUE, tn.IDSEMESTRE, tn.ANNEE,
          JSON.stringify(oldVal),
          JSON.stringify({ MOYENNE: newMoyenne, CODMENTION: codMention, QdP: qdp, Decision: decision }),
          `Délibération jury #${sessionId} (${tn.motif || 'Clôture de session'})`,
          user.id
        ]);
      }

      // Notes de composantes (si note_sn_nouveau, etc.)
      if (tn.note_sn_nouveau !== null || tn.note_cc_nouveau !== null || tn.note_tp_nouveau !== null) {
        const [ecs] = await connection.query('SELECT IDEC FROM ec WHERE IDUE = ?', [tn.IDUE]);
        for (const ec of ecs) {
          await connection.query(`
            UPDATE notes SET
              note_sn = COALESCE(?, note_sn),
              note_cc = COALESCE(?, note_cc),
              note_tp = COALESCE(?, note_tp),
              moyenne_ec = COALESCE(?, moyenne_ec),
              updated_at = NOW()
            WHERE IDEC = ? AND MATRICULE = ? AND IDCLASSE = ? AND ANNEE = ?
          `, [
            tn.note_sn_nouveau ?? null,
            tn.note_cc_nouveau ?? null,
            tn.note_tp_nouveau ?? null,
            tn.nouvelle_moyenne ?? null,
            ec.IDEC, tn.MATRICULE, session.IDCLASSE, session.annee
          ]);
        }
      }
    }

    // 3. Entrée dans la table deliberations existante
    const [delibRes] = await connection.query(`
      INSERT INTO deliberations (IDCLASSE, ANNEE, cycle, statut, motif, created_by, validated_by, validated_at, created_at, updated_at)
      VALUES (?, ?, ?, 'PUBLISHED', ?, ?, ?, NOW(), NOW(), NOW())
    `, [
      session.IDCLASSE, session.annee, session.CODGRADE || 'LICENCE',
      `Délibération officielle session: ${session.nom_session}`,
      user.id, user.id
    ]);
    const deliberationId = delibRes.insertId;

    // 4. Calcul et insertion des décisions par étudiant dans deliberation_decisions
    const rosterData = await getSessionRosterAndGrades(session, connection);
    const gradebook = buildCombinedGradebook(rosterData);

    for (const student of gradebook) {
      if (!student.matricule) continue;
      const decisionVal = ['ADMIS', 'AJOURNE', 'EXCLU'].includes(student.current_summary.decision)
        ? student.current_summary.decision
        : (student.current_summary.moyenne_annuelle >= 50 ? 'ADMIS' : 'AJOURNE');

      await connection.query(`
        INSERT INTO deliberation_decisions (deliberation_id, MATRICULE, decision, mgp, credits_valides)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          decision = VALUES(decision),
          mgp = VALUES(mgp),
          credits_valides = VALUES(credits_valides)
      `, [
        deliberationId,
        student.matricule,
        decisionVal,
        student.current_summary.mgp,
        student.current_summary.credits_valides
      ]);
    }

    // 5. Clôturer la session
    await connection.query(`
      UPDATE deliberation_sessions SET
        statut = 'CLOTURE',
        date_cloture = NOW(),
        updated_at = NOW()
      WHERE id = ?
    `, [sessionId]);

    await connection.commit();

    await audit({
      user,
      action: 'CLOSE',
      module: 'JURY',
      resourceType: 'deliberation_sessions',
      resourceId: sessionId,
      description: `Clôture de la session #${sessionId} et application définitive des notes (${tempNotes.length} notes modifiées)`,
      newValues: { deliberationId, notesAppliquees: tempNotes.length },
      request: req
    });

    return getSessionWithDetails(sessionId);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Annulation d'une session
// ----------------------------------------------------------------------
async function cancelSession(sessionId, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });
  if (session.statut === 'CLOTURE') {
    throw Object.assign(new Error('Une session clôturée ne peut pas être annulée directement.'), { status: 409 });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query('DELETE FROM deliberation_temp_notes WHERE session_id = ?', [sessionId]);
    await connection.query('UPDATE deliberation_sessions SET statut = "ANNULEE", updated_at = NOW() WHERE id = ?', [sessionId]);

    await connection.commit();

    await audit({
      user,
      action: 'CANCEL',
      module: 'JURY',
      resourceType: 'deliberation_sessions',
      resourceId: sessionId,
      description: `Annulation de la session #${sessionId} et rejet des modifications temporaires`,
      request: req
    });

    return getSessionWithDetails(sessionId);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Verrouillage / Déverrouillage Super Admin
// ----------------------------------------------------------------------
async function lockSession(sessionId, user, motif, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });

  await query(`
    UPDATE deliberation_sessions SET
      verrouille_par = ?,
      date_verrouillage = NOW(),
      updated_at = NOW()
    WHERE id = ?
  `, [user.id, sessionId]);

  await audit({
    user,
    action: 'LOCK',
    module: 'JURY',
    resourceType: 'deliberation_sessions',
    resourceId: sessionId,
    description: `Verrouillage de la session #${sessionId} (Motif: ${motif || 'Non spécifié'})`,
    request: req
  });

  return getSessionWithDetails(sessionId);
}

async function unlockSession(sessionId, user, req = null) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });

  await query(`
    UPDATE deliberation_sessions SET
      verrouille_par = NULL,
      date_verrouillage = NULL,
      updated_at = NOW()
    WHERE id = ?
  `, [sessionId]);

  await audit({
    user,
    action: 'UNLOCK',
    module: 'JURY',
    resourceType: 'deliberation_sessions',
    resourceId: sessionId,
    description: `Déverrouillage de la session #${sessionId}`,
    request: req
  });

  return getSessionWithDetails(sessionId);
}

// ----------------------------------------------------------------------
// Confirmation & Annulation d'actions
// ----------------------------------------------------------------------
async function confirmAction(actionId, user, req = null) {
  const actions = await query('SELECT * FROM deliberation_actions WHERE id = ?', [actionId]);
  if (!actions[0]) throw Object.assign(new Error('Action introuvable.'), { status: 404 });
  const action = actions[0];

  await query(`
    UPDATE deliberation_actions SET
      valide = 1,
      valide_par = ?,
      date_validation = NOW(),
      updated_at = NOW()
    WHERE id = ?
  `, [user.id, actionId]);

  await audit({
    user,
    action: 'VALIDATE',
    module: 'JURY',
    resourceType: 'deliberation_actions',
    resourceId: actionId,
    description: `Validation de l'action #${actionId}`,
    request: req
  });

  return (await query('SELECT * FROM deliberation_actions WHERE id = ?', [actionId]))[0];
}

async function cancelAction(actionId, user, req = null) {
  const actions = await query('SELECT * FROM deliberation_actions WHERE id = ?', [actionId]);
  if (!actions[0]) throw Object.assign(new Error('Action introuvable.'), { status: 404 });
  const action = actions[0];

  const matricules = Array.isArray(action.etudiants_concernes)
    ? action.etudiants_concernes
    : (typeof action.etudiants_concernes === 'string' ? JSON.parse(action.etudiants_concernes) : []);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (matricules.length > 0) {
      if (action.IDUE) {
        await connection.query(`
          DELETE FROM deliberation_temp_notes
          WHERE session_id = ? AND IDUE = ? AND MATRICULE IN (?)
        `, [action.session_id, action.IDUE, matricules]);
      } else {
        await connection.query(`
          DELETE FROM deliberation_temp_notes
          WHERE session_id = ? AND MATRICULE IN (?)
        `, [action.session_id, matricules]);
      }
    }

    await connection.query('DELETE FROM deliberation_actions WHERE id = ?', [actionId]);
    await connection.commit();

    await audit({
      user,
      action: 'DELETE',
      module: 'JURY',
      resourceType: 'deliberation_actions',
      resourceId: actionId,
      description: `Annulation de l'action #${actionId} et rollback des notes temporaires`,
      request: req
    });

    return { success: true, message: 'Action annulée avec succès.' };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ----------------------------------------------------------------------
// Dessin Header PDF
// ----------------------------------------------------------------------
const drawPdfHeader = (doc, pageWidth, y = 35) => {
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('REPUBLIQUE DU CAMEROUN', 40, y);
  doc.fontSize(7).font('Helvetica');
  doc.text('Paix - Travail - Patrie', 60, y + 12);
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('UNIVERSITE DE YAOUNDE I', 45, y + 26);
  doc.fontSize(8).font('Helvetica');
  doc.text('FACULTE DES SCIENCES', 50, y + 38);

  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('REPUBLIC OF CAMEROON', pageWidth - 180, y);
  doc.fontSize(7).font('Helvetica');
  doc.text('Peace - Work - Fatherland', pageWidth - 165, y + 12);
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('UNIVERSITY OF YAOUNDE I', pageWidth - 185, y + 26);
  doc.fontSize(8).font('Helvetica');
  doc.text('FACULTY OF SCIENCE', pageWidth - 165, y + 38);

  const logoPath = getLogoPath();
  if (logoPath) {
    try {
      doc.image(logoPath, pageWidth / 2 - 22, y, { width: 44, height: 50 });
    } catch (e) { }
  }
};

// ----------------------------------------------------------------------
// Dessin Table PDF
// ----------------------------------------------------------------------
const drawPdfTable = (doc, startY, headers, rows, colWidths, startX = 35) => {
  const headerRowHeight = 18;
  let currentY = startY;

  doc.rect(startX, currentY, colWidths.reduce((a, b) => a + b, 0), headerRowHeight).fillAndStroke('#1e293b', '#1e293b');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
  let currentX = startX;
  headers.forEach((h, i) => {
    doc.text(h, currentX, currentY + 5, { width: colWidths[i], align: 'center' });
    currentX += colWidths[i];
  });

  currentY += headerRowHeight;
  doc.fillColor('#000000').font('Helvetica').fontSize(7.5);

  rows.forEach((row, rowIndex) => {
    const cellHeights = row.map((cell, i) => {
      const text = cell !== null && cell !== undefined ? String(cell) : '-';
      return doc.heightOfString(text, { width: colWidths[i] - 4 });
    });
    const rowHeight = Math.max(16, Math.max(...cellHeights) + 6);

    if (currentY + rowHeight > doc.page.height - 45) {
      doc.addPage();
      currentY = 40;
    }

    if (rowIndex % 2 === 1) {
      doc.rect(startX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill('#f8fafc');
    }

    doc.rect(startX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight).stroke('#cbd5e1');
    doc.fillColor('#000000');

    currentX = startX;
    row.forEach((cell, i) => {
      if (i > 0) {
        doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke('#cbd5e1');
      }
      doc.text(cell !== null && cell !== undefined ? String(cell) : '-', currentX + 2, currentY + 4, {
        width: colWidths[i] - 4,
        align: i === 1 ? 'left' : 'center'
      });
      currentX += colWidths[i];
    });
    currentY += rowHeight;
  });

  return currentY;
};

// ----------------------------------------------------------------------
// Génération PDF : PV de Synthèse de Session
// ----------------------------------------------------------------------
async function generateSessionPvPdf(sessionId, stream) {
  const session = await getSessionWithDetails(sessionId);
  if (!session) throw Object.assign(new Error('Session introuvable.'), { status: 404 });

  const rosterData = await getSessionRosterAndGrades(session);
  const gradebook = buildCombinedGradebook(rosterData);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 30, bottom: 30, left: 35, right: 35 }
  });

  doc.pipe(stream);
  const pageWidth = doc.page.width;

  // Header
  drawPdfHeader(doc, pageWidth, 25);

  // Titre & Sous-titre
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('PROCES-VERBAL DE SYNTHESE DE DELIBERATION', 0, 85, { align: 'center' });

  doc.fontSize(9).font('Helvetica').fillColor('#475569');
  doc.text(`Session : ${session.nom_session.toUpperCase()}   |   Statut : ${session.statut}`, 0, 102, { align: 'center' });
  doc.text(`Filière : ${session.filiere_nom || '-'}   |   Spécialité : ${session.specialite_nom || '-'}   |   Niveau : ${session.NIVEAU || '-'}   |   Année : ${session.annee}`, 0, 115, { align: 'center' });

  // Jury membres summary
  let juryText = `Président : ${session.president_nom || 'Non défini'}`;
  if (session.membres?.length > 0) {
    const membersNames = session.membres.map(m => `${m.name} (${m.role})`).join(', ');
    juryText += `   |   Membres : ${membersNames}`;
  }
  doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#64748b');
  doc.text(juryText, 35, 128, { width: pageWidth - 70, align: 'center' });

  // Tableau des résultats
  const tableTop = 142;
  const headers = ['N°', 'Matricule', 'Nom & Prénom', 'Moy. Init.', 'Créd. Init.', 'Moy. Délib.', 'Créd. Délib.', 'MGP', 'Mention', 'Décision'];
  const colWidths = [25, 75, 230, 60, 60, 60, 60, 45, 55, 65];

  const tableRows = gradebook.map((s, idx) => [
    (idx + 1).toString(),
    s.matricule,
    s.nom,
    s.original_summary.moyenne_annuelle ? s.original_summary.moyenne_annuelle.toFixed(2) : '-',
    s.original_summary.credits_valides.toString(),
    s.current_summary.moyenne_annuelle ? s.current_summary.moyenne_annuelle.toFixed(2) : '-',
    s.current_summary.credits_valides.toString(),
    s.current_summary.mgp ? s.current_summary.mgp.toFixed(2) : '-',
    s.current_summary.mention || getMentionLocal(s.current_summary.moyenne_annuelle),
    s.current_summary.decision
  ]);

  let finalY = drawPdfTable(doc, tableTop, headers, tableRows, colWidths, 35);

  // Statistiques et signatures
  if (finalY + 90 > doc.page.height - 30) {
    doc.addPage();
    finalY = 35;
  }

  finalY += 15;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('Statistiques de la délibération :', 35, finalY);

  const totalStudents = gradebook.length;
  const admisCount = gradebook.filter(s => s.current_summary.decision === 'ADMIS').length;
  const ajourneCount = totalStudents - admisCount;
  const tauxReussite = totalStudents > 0 ? ((admisCount / totalStudents) * 100).toFixed(2) : '0.00';

  const statsHeaders = ['Effectif Total', 'Admis', 'Ajournés', 'Taux de Réussite'];
  const statsCols = [90, 80, 80, 100];
  const statsRow = [totalStudents.toString(), admisCount.toString(), ajourneCount.toString(), `${tauxReussite}%`];

  finalY = drawPdfTable(doc, finalY + 12, statsHeaders, [statsRow], statsCols, 35);

  // Signatures
  if (finalY + 60 > doc.page.height - 30) {
    doc.addPage();
    finalY = 35;
  }

  finalY += 20;
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('Les Membres du Jury :', 45, finalY);
  doc.text('Le Président du Jury :', pageWidth - 200, finalY);

  doc.fontSize(8).font('Helvetica').fillColor('#64748b');
  doc.text('(Signatures)', 45, finalY + 15);
  doc.text(`${session.president_nom || ''}\n(Signature et date)`, pageWidth - 200, finalY + 15);

  doc.end();
}

// ----------------------------------------------------------------------
// Génération PDF : PV de Synthèse pour un Jury (Toutes Sessions)
// ----------------------------------------------------------------------
async function generateJuryPvPdf(juryId, stream) {
  const jury = await getJuryWithDetails(juryId);
  if (!jury) throw Object.assign(new Error('Jury introuvable.'), { status: 404 });

  const sessions = await query(`
    SELECT s.*,
           (SELECT COUNT(*) FROM deliberation_temp_notes WHERE session_id = s.id) AS total_modifications
    FROM deliberation_sessions s
    WHERE s.jury_id = ?
    ORDER BY s.created_at DESC
  `, [juryId]);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 35, bottom: 35, left: 40, right: 40 }
  });

  doc.pipe(stream);
  const pageWidth = doc.page.width;

  drawPdfHeader(doc, pageWidth, 30);

  doc.fontSize(14).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('RECAPITULATIF DES SESSIONS DU JURY', 0, 95, { align: 'center' });

  doc.fontSize(10).font('Helvetica').fillColor('#475569');
  doc.text(`Jury : ${jury.nom.toUpperCase()}   |   Année : ${jury.annee}`, 0, 115, { align: 'center' });
  doc.text(`Filière : ${jury.filiere_nom || '-'}   |   Spécialité : ${jury.specialite_nom || '-'}   |   Niveau : ${jury.NIVEAU || '-'}`, 0, 130, { align: 'center' });

  let curY = 155;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('Composition du Jury :', 40, curY);

  const memberHeaders = ['Rôle', 'Nom & Prénom', 'Email'];
  const memberCols = [100, 220, 195];
  const memberRows = (jury.membres || []).map(m => [m.role, m.name, m.email || '-']);
  curY = drawPdfTable(doc, curY + 12, memberHeaders, memberRows, memberCols, 40);

  curY += 20;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('Sessions de Délibération :', 40, curY);

  const sessionHeaders = ['Nom Session', 'Statut', 'Date Début', 'Date Clôture', 'Notes Modifiées'];
  const sessionCols = [145, 90, 95, 95, 90];
  const sessionRows = sessions.map(s => [
    s.nom_session,
    s.statut,
    s.date_debut ? new Date(s.date_debut).toLocaleDateString('fr-FR') : '-',
    s.date_cloture ? new Date(s.date_cloture).toLocaleDateString('fr-FR') : '-',
    s.total_modifications.toString()
  ]);

  curY = drawPdfTable(doc, curY + 12, sessionHeaders, sessionRows, sessionCols, 40);

  doc.end();
}

module.exports = {
  round2,
  getGradeLocal,
  getQdpLocal,
  getMentionLocal,
  getDecisionLocal,
  evaluateCondition,
  getJuryWithDetails,
  getSessionWithDetails,
  getSessionRosterAndGrades,
  buildCombinedGradebook,
  previewDeliberationAction,
  executeAjoutPoints,
  executeMoyenneCible,
  confirmAction,
  cancelAction,
  openSession,
  startSession,
  requestValidation,
  submitValidation,
  closeSession,
  cancelSession,
  lockSession,
  unlockSession,
  generateSessionPvPdf,
  generateJuryPvPdf
};
