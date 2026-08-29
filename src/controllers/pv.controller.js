const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/mysql');

// ============================================================================
// Constantes / helpers partages
// ============================================================================

// Nombre de blocs UE "a plat" dans ulmdpvrecap (IDUE1..IDUE35, CODUE1..CODUE35, etc.)
const UE_SLOT_COUNT = 35;

// Seuil d'admission sur l'echelle /4.0 (a confirmer avec le jury si different)
const MGP_SEUIL = 2.0;

// FIX: resolution robuste du chemin du logo (voir version precedente du controller)
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
  console.warn('Logo UY1 introuvable. Chemins testes:', candidates);
  return null;
};

// Grade local a partir d'une moyenne /100. Utilise seulement en repli si
// Moyennes.CODMENTION est absent -- la source de verite reste la colonne.
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

// Section 10 du schema : "la comparaison normalise avant de comparer, la
// valeur venant d'une saisie manuelle dans une base tierce : espaces retires,
// casse ignoree."
const normalizeDecision = (d) => (d || '').toString().trim().toUpperCase();

// Depivote les colonnes IDUE1..IDUE35 / CODUE1..CODUE35 / ... d'une ligne
// ulmdpvrecap en tableau de blocs UE exploitables. Ignore les slots vides.
const unpivotUEs = (row) => {
  const ues = [];
  for (let i = 1; i <= UE_SLOT_COUNT; i++) {
    const idue = row[`IDUE${i}`];
    if (idue === null || idue === undefined) continue;
    ues.push({
      idue,
      code: row[`CODUE${i}`],
      note: row[`NOTEUE${i}`] !== null && row[`NOTEUE${i}`] !== undefined ? Number(row[`NOTEUE${i}`]) : null,
      credit: Number(row[`CREDIT_UE${i}`] ?? 0),
      creditCap: Number(row[`CREDIT_CAP_UE${i}`] ?? 0),
      qdp: row[`QDP${i}`] !== null && row[`QDP${i}`] !== undefined ? Number(row[`QDP${i}`]) : null,
    });
  }
  return ues;
};

// ----------------------------------------------------------------------
// NOUVEAU SCHEMA UNIFIE EC/UE (migration "EC-miroir")
// ----------------------------------------------------------------------
// Depuis la migration, TOUTE UE passe par au moins un EC :
//   - un vrai EC saisi manuellement (origine = 'SAISIE'), potentiellement
//     plusieurs par UE (nouveau systeme) ;
//   - ou un EC-miroir genere automatiquement (origine = 'AUTO_UE_SEULE')
//     quand l'UE n'a pas d'EC declare (ancien systeme). L'UE est alors
//     litteralement traitee comme sa propre EC.
// La table de notes est donc unique (`notes`, ex-`ec_notes`), indexee sur
// IDEC dans tous les cas -- ce controleur n'a plus besoin de distinguer
// les deux systemes, il lit toujours par IDEC.
//
// Sur le PV d'UE : meme si l'UE a plusieurs EC portant chacun CC/TP/SN, on
// n'affiche PAS une colonne par EC. On affiche UNE seule colonne par type
// d'evaluation (CC, TP, SN), en sommant les notes de cette meme colonne sur
// tous les EC de l'UE -- suivie de la moyenne finale /100 (qui reste issue
// de `Moyennes`, deja calculee en amont).
// ----------------------------------------------------------------------

// Construit les colonnes agregees CC/TP/SN pour une UE, a partir des types
// d'evaluation declares sur l'ensemble de ses EC (un seul EC si UE "seule",
// plusieurs sinon). Un type n'apparait qu'une fois, avec son echelle totale
// (somme des echelles des EC qui portent ce type).
const buildEvalSummaryColumns = (evaluationRows) => {
  const echelleTotals = { CC: 0, TP: 0, SN: 0 };
  const present = { CC: false, TP: false, SN: false };

  evaluationRows.forEach((row) => {
    echelleTotals[row.type] += Number(row.echelle);
    present[row.type] = true;
  });

  const columns = [];
  if (present.CC) columns.push({ type: 'CC', label: `CC\n/${echelleTotals.CC}` });
  if (present.TP) columns.push({ type: 'TP', label: `TP\n/${echelleTotals.TP}` });
  if (present.SN) columns.push({ type: 'SN', label: `SN\n/${echelleTotals.SN}` });

  return columns;
};

// Pour un etudiant donne, somme les notes de chaque type (CC/TP/SN) sur
// l'ensemble des EC de l'UE. hasValue[type] distingue "0 obtenu" de
// "pas encore saisi / non concerne" (affiche '-').
const sumStudentEvalByType = (ecIdsOfUE, studentNotesByIdec) => {
  const sums = { CC: 0, TP: 0, SN: 0 };
  const hasValue = { CC: false, TP: false, SN: false };

  ecIdsOfUE.forEach((idec) => {
    const note = studentNotesByIdec[idec];
    if (!note) return;
    if (note.note_cc !== null && note.note_cc !== undefined) {
      sums.CC += Number(note.note_cc);
      hasValue.CC = true;
    }
    if (note.note_tp !== null && note.note_tp !== undefined) {
      sums.TP += Number(note.note_tp);
      hasValue.TP = true;
    }
    if (note.note_sn !== null && note.note_sn !== undefined) {
      sums.SN += Number(note.note_sn);
      hasValue.SN = true;
    }
  });

  return { sums, hasValue };
};

// Legende optionnelle listant les EC qui composent l'UE (utile seulement
// quand l'UE a plusieurs vrais EC ; une UE-miroir n'a qu'un seul EC, donc
// rien a lister).
const buildComposanteCaption = (evaluationRows) => {
  const distinct = [...new Map(evaluationRows.map((r) => [Number(r.IDEC), r])).values()];
  if (distinct.length <= 1) return null;
  return distinct
    .map((r, idx) => `EC${idx + 1}: ${r.INTITULE || `Element ${r.IDEC}`}`)
    .join('   |   ');
};

// FIX (repris de la version precedente) : trace un tableau avec hauteur de
// ligne dynamique (gere le texte qui wrap) + saut de page calcule AVANT de
// dessiner la ligne.
const drawTable = (doc, startY, headers, rows, colWidths, startX = 30) => {
  const headerRowHeight = 15;
  let currentY = startY;
  const totalTableWidth = colWidths.reduce((a, b) => a + b, 0);

  // En-tête du tableau (à plat, même trait que le corps du tableau)
  const gridColor = '#000000';
  const gridLineWidth = 0.75;

  doc.lineWidth(gridLineWidth).rect(startX, currentY, totalTableWidth, headerRowHeight).stroke(gridColor);
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(7);
  let currentX = startX;
  headers.forEach((h, i) => {
    if (i > 0) {
      doc.lineWidth(gridLineWidth).moveTo(currentX, currentY).lineTo(currentX, currentY + headerRowHeight).stroke(gridColor);
    }
    doc.text(h, currentX + 2, currentY + 4, { width: colWidths[i] - 4, align: 'left' });
    currentX += colWidths[i];
  });

  currentY += headerRowHeight;
  doc.fillColor('#000000').font('Helvetica').fontSize(6.8);

  rows.forEach((row, rowIndex) => {
    const cellHeights = row.map((cell, i) => {
      const text = cell !== null && cell !== undefined ? String(cell) : '-';
      return doc.heightOfString(text, { width: colWidths[i] - 6 });
    });
    // Hauteur de ligne compacte pour économie maximale de papier
    const rowHeight = Math.max(12.5, Math.max(...cellHeights) + 2.5);

    if (currentY + rowHeight > doc.page.height - 32) {
      doc.addPage();
      currentY = 25;

      // Redessiner l'en-tête sur la nouvelle page (même trait que le corps du tableau)
      doc.lineWidth(gridLineWidth).rect(startX, currentY, totalTableWidth, headerRowHeight).stroke(gridColor);
      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(7);
      let hX = startX;
      headers.forEach((h, i) => {
        if (i > 0) {
          doc.lineWidth(gridLineWidth).moveTo(hX, currentY).lineTo(hX, currentY + headerRowHeight).stroke(gridColor);
        }
        doc.text(h, hX + 2, currentY + 4, { width: colWidths[i] - 4, align: 'left' });
        hX += colWidths[i];
      });
      currentY += headerRowHeight;
      doc.fillColor('#000000').font('Helvetica').fontSize(6.8);
    }

    // Alternance de couleur de fond très légère pour lisibilité
    if (rowIndex % 2 === 1) {
      doc.rect(startX, currentY, totalTableWidth, rowHeight).fill('#f8fafc');
    }

    doc.lineWidth(gridLineWidth).rect(startX, currentY, totalTableWidth, rowHeight).stroke(gridColor);
    doc.fillColor('#000000');

    currentX = startX;
    row.forEach((cell, i) => {
      if (i > 0) {
        doc.lineWidth(gridLineWidth).moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke(gridColor);
      }
      doc.text(cell !== null && cell !== undefined ? String(cell) : '-', currentX + 3, currentY + 2.5, {
        width: colWidths[i] - 5,
        align: 'left'
      });
      currentX += colWidths[i];
    });
    currentY += rowHeight;
  });

  return currentY;
};

// Titre de section centré, encadré de lignes de dièses (style "STATISTIQUES DE VALIDATION")
// Retourne le Y juste après le bloc, pour enchaîner la suite du document.
const drawHashTitle = (doc, pageWidth, startY, title, startX = 30) => {
  const usableWidth = pageWidth - startX * 2;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#0f172a');

  const upperTitle = title.toUpperCase();
  const hashLineWidth = doc.widthOfString('#');
  const titleWidth = doc.widthOfString(upperTitle);
  // Ligne de dièses limitée à la largeur du titre (+ petite marge), pas toute la page
  const hashCount = Math.max(10, Math.round((titleWidth + 20) / hashLineWidth));
  const hashLine = '#'.repeat(hashCount);

  let y = startY;
  doc.text(hashLine, startX, y, { width: usableWidth, align: 'center' });
  y += doc.heightOfString(hashLine, { width: usableWidth }) + 2;

  doc.text(upperTitle, startX, y, { width: usableWidth, align: 'center' });
  y += doc.heightOfString(upperTitle, { width: usableWidth }) + 2;

  doc.text(hashLine, startX, y, { width: usableWidth, align: 'center' });
  y += doc.heightOfString(hashLine, { width: usableWidth }) + 6;

  return y;
};

// En-tete bilingue UY1 commun aux deux documents
const drawHeader = (doc, pageWidth, y = 20) => {
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#000000');
  doc.text('REPUBLIQUE DU CAMEROUN', 30, y);
  doc.fontSize(6.5).font('Helvetica').fillColor('#444444');
  doc.text('Paix - Travail - Patrie', 45, y + 10);
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#000000');
  doc.text('UNIVERSITE DE YAOUNDE I', 35, y + 22);
  doc.fontSize(7.5).font('Helvetica').fillColor('#444444');
  doc.text('FACULTE DES SCIENCES', 40, y + 33);

  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#000000');
  doc.text('REPUBLIC OF CAMEROON', pageWidth - 165, y);
  doc.fontSize(6.5).font('Helvetica').fillColor('#444444');
  doc.text('Peace - Work - Fatherland', pageWidth - 150, y + 10);
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#000000');
  doc.text('UNIVERSITY OF YAOUNDE I', pageWidth - 160, y + 22);
  doc.fontSize(7.5).font('Helvetica').fillColor('#444444');
  doc.text('FACULTY OF SCIENCE', pageWidth - 145, y + 33);

  try {
    const logoPath = getLogoPath();
    if (logoPath) {
      doc.image(logoPath, pageWidth / 2 - 18, y, { width: 36, height: 44 });
    }
  } catch (err) {
    console.error("Erreur logo:", err.message);
  }
};

// Helpers spécifiques au PV d'UE
const buildNiveauCode = (classe) => {
  const codFiliere = (classe.CODFILIERE || classe.FILIERE_NOM || 'UE').toUpperCase().replace(/\s+/g, '');
  const grade = (classe.CODGRADE || 'L').toUpperCase().trim();
  let niveau = (classe.NIVEAU || '1').toString().trim().toUpperCase();
  if (niveau.startsWith(grade)) {
    return `${codFiliere}-${niveau}`;
  }
  return `${codFiliere}-${grade}${niveau}`;
};

const getDecisionUePV = (score100) => {
  if (score100 === null || score100 === undefined || Number.isNaN(Number(score100))) {
    return 'EL';
  }
  const s = Number(score100);
  if (s >= 50) return 'CA';
  if (s >= 35) return 'CANT';
  return 'NC';
};

const getMentionUePV = (score100) => {
  if (score100 === null || score100 === undefined || Number.isNaN(Number(score100))) {
    return '-';
  }
  const s = Number(score100);
  if (s >= 80) return 'A';
  if (s >= 75) return 'A-';
  if (s >= 70) return 'B+';
  if (s >= 65) return 'B';
  if (s >= 60) return 'B-';
  if (s >= 55) return 'C+';
  if (s >= 50) return 'C';
  if (s >= 45) return 'C-';
  if (s >= 40) return 'D+';
  if (s >= 35) return 'D';
  if (s >= 30) return 'E';
  return 'F';
};

// ============================================================================
// PV PAR UE
// POST /api/pv/generate-ue
// Body: { idue, annee, idsemestre, idclasse }
// ============================================================================
exports.generatePvUe = async (req, res) => {
  const { idue, annee, idsemestre, idclasse } = req.body;

  if (!idue || !annee || !idsemestre || !idclasse) {
    return res.status(400).json({ message: 'idue, annee, idsemestre et idclasse sont requis.' });
  }

  try {
    const ueRows = await query('SELECT * FROM UE WHERE IDUE = ?', [idue]);
    if (!ueRows.length) throw new Error('UE introuvable');
    const ue = ueRows[0];

    const classeRows = await query(
      `SELECT c.*, f.NOM AS FILIERE_NOM, f.CODFILIERE,
              s.INTITULE AS SPECIALITE_INTITULE, g.INTITULE AS GRADE_INTITULE
       FROM Classe c
       LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
       LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
       LEFT JOIN Grade g ON g.CODGRADE = c.CODGRADE
       WHERE c.IDCLASSE = ?`,
      [idclasse]
    );
    if (!classeRows.length) throw new Error('Classe introuvable');
    const classe = classeRows[0];

    const semInput = Number(idsemestre);
    const semBase = (semInput === 1 || semInput === 3) ? 1 : 2;
    const semRattrapage = (semInput === 1 || semInput === 3) ? 3 : 4;

    const rows = await query(
      `SELECT e.MATRICULE, e.NOM,
              COALESCE(m2.MOYENNE, m1.MOYENNE) AS MOYENNE,
              COALESCE(m2.CODMENTION, m1.CODMENTION) AS CODMENTION,
              COALESCE(m2.CREDIT, m1.CREDIT) AS CREDIT,
              COALESCE(m2.QdP, m1.QdP) AS QdP,
              COALESCE(m2.Decision, m1.Decision) AS Decision
       FROM Inscript i
       JOIN Etudiant e ON e.MATRICULE = i.MATRICULE
       LEFT JOIN Moyennes m1
              ON m1.MATRICULE = i.MATRICULE
             AND m1.IDUE = ? AND m1.ANNEE = ? AND m1.IDSEMESTRE = ?
       LEFT JOIN Moyennes m2
              ON m2.MATRICULE = i.MATRICULE
             AND m2.IDUE = ? AND m2.ANNEE = ? AND m2.IDSEMESTRE = ?
       WHERE i.IDCLASSE = ? AND i.ANNEE = ?
       ORDER BY e.NOM`,
      [idue, annee, semBase, idue, annee, semRattrapage, idclasse, annee]
    );

    const [evaluationRows, ecNoteRows] = await Promise.all([
      query(`SELECT e.IDEC, e.INTITULE, t.type, t.echelle
             FROM ec e JOIN ec_evaluation_types t ON t.IDEC = e.IDEC
             WHERE e.IDUE = ? ORDER BY e.IDEC, FIELD(t.type,'CC','TP','SN')`, [idue]),
      query(`SELECT n.MATRICULE, n.IDEC, n.note_cc, n.note_tp, n.note_sn
             FROM notes n JOIN ec e ON e.IDEC = n.IDEC
             WHERE e.IDUE = ? AND n.IDCLASSE = ? AND n.ANNEE = ?`, [idue, idclasse, annee]),
    ]);

    const ecIdsOfUE = [...new Set(evaluationRows.map((r) => Number(r.IDEC)))];
    const composanteCaption = buildComposanteCaption(evaluationRows);

    let echelleCC = 0;
    let echelleSN = 0;
    let echelleTP = 0;
    let hasTP = false;

    evaluationRows.forEach((row) => {
      if (row.type === 'CC') echelleCC += Number(row.echelle || 0);
      if (row.type === 'SN') echelleSN += Number(row.echelle || 0);
      if (row.type === 'TP') {
        echelleTP += Number(row.echelle || 0);
        hasTP = true;
      }
    });

    if (echelleCC === 0) echelleCC = 30;
    if (echelleSN === 0) echelleSN = 70;

    const notesByStudent = new Map();
    ecNoteRows.forEach((note) => {
      if (!notesByStudent.has(note.MATRICULE)) notesByStudent.set(note.MATRICULE, {});
      notesByStudent.get(note.MATRICULE)[Number(note.IDEC)] = note;
    });

        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PV_UE_${idue}_${Date.now()}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    drawHeader(doc, pageWidth, 18);

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000');
    doc.text("PROCES VERBAL DE L'UNITE D'ENSEIGNEMENT", 0, 70, { align: 'center' });

    const ueTitle = `${ue.CODUE || ''} - ${ue.INTITULE || ''}`.toUpperCase();
    doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#000000');
    doc.text(ueTitle, 0, 84, { align: 'center' });

    doc.fontSize(8).font('Helvetica').fillColor('#000000');
    doc.text(`Filiere : ${classe.FILIERE_NOM || '-'}   |   Specialite : ${classe.SPECIALITE_INTITULE || '-'}   |   Grade : ${classe.GRADE_INTITULE || classe.CODGRADE || '-'}   |   Niveau : ${classe.NIVEAU || '-'}   |   Annee : ${annee}   |   Semestre : ${idsemestre}`, 0, 98, { align: 'center' });

    if (composanteCaption) {
      doc.fontSize(6.5).font('Helvetica-Oblique').fillColor('#000000').text(`Composantes de l'UE : ${composanteCaption}`, 30, 110, { width: pageWidth - 60, align: 'center' });
    }

    const tableTop = composanteCaption ? 122 : 114;
    const headers = [
      'Num',
      'Matricule',
      'Nom et prenom',
      'Niveau',
      'ANO_CC',
      `CC/${echelleCC}`,
      'ANO_EE',
      `EE/${echelleSN}`
    ];

    // Largeurs calculées pour occuper exactement les 781.89 pt de largeur utile (30pt marge gauche et droite)
    let colWidths = [];
    if (hasTP) {
      headers.push(`EP/${echelleTP || 20}`);
      headers.push('TOTAL/100', 'DEC', 'MENTION');
      // Total: 26 + 72 + 195 + 66 + 48 + 52 + 48 + 52 + 52 + 60 + 55 + 55 = 781 pt
      colWidths = [26, 72, 195, 66, 48, 52, 48, 52, 52, 60, 55, 55];
    } else {
      headers.push('TOTAL/100', 'DEC', 'MENTION');
      // Total: 26 + 75 + 230 + 70 + 52 + 56 + 52 + 56 + 60 + 52 + 52 = 781 pt
      colWidths = [26, 75, 230, 70, 52, 56, 52, 56, 60, 52, 52];
    }

    const tableRows = [];
    const decisionCounts = { CA: 0, CANT: 0, NC: 0, EL: 0 };
    const niveauCode = buildNiveauCode(classe);

    rows.forEach((r, i) => {
      const totalScore = r.MOYENNE !== null && r.MOYENNE !== undefined ? Number(r.MOYENNE) : null;
      const dec = getDecisionUePV(totalScore);
      const mention = getMentionUePV(totalScore);
      decisionCounts[dec] = (decisionCounts[dec] || 0) + 1;

      const studentNotes = notesByStudent.get(r.MATRICULE) || {};
      const { sums, hasValue } = sumStudentEvalByType(ecIdsOfUE, studentNotes);

      const rowData = [
        (i + 1).toString(),
        r.MATRICULE,
        r.NOM,
        niveauCode,
        '-',
        hasValue.CC ? sums.CC.toFixed(2) : '-',
        '-',
        hasValue.SN ? sums.SN.toFixed(2) : '-'
      ];

      if (hasTP) {
        rowData.push(hasValue.TP ? sums.TP.toFixed(2) : '-');
      }

      rowData.push(
        totalScore !== null ? totalScore.toFixed(2) : '-',
        dec,
        mention
      );

      tableRows.push(rowData);
    });

    const startX = 30;
    let finalY = drawTable(doc, tableTop, headers, tableRows, colWidths, startX);

    finalY += 12;
    if (finalY + 60 > doc.page.height - 25) {
      doc.addPage();
      finalY = 25;
    }

    finalY = drawHashTitle(doc, pageWidth, finalY, 'Statistiques de Validation', startX);

    const totalEtudiants = rows.length;
    const statLabels = ['CA', 'CANT', 'NC', 'EL'];
    const statHeaders = ['Effectif Total', ...statLabels, ...statLabels.map((l) => `%${l}`)];
    const statColWidths = [70, ...statLabels.map(() => 45), ...statLabels.map(() => 45)];
    const statRow = [
      totalEtudiants.toString(),
      ...statLabels.map((l) => (decisionCounts[l] || 0).toString()),
      ...statLabels.map((l) => totalEtudiants ? (((decisionCounts[l] || 0) / totalEtudiants) * 100).toFixed(2) + '%' : '0.00%')
    ];

    finalY = drawTable(doc, finalY + 6, statHeaders, [statRow], statColWidths, startX);

    finalY += 8;
    doc.fontSize(6.5).font('Helvetica-Oblique').fillColor('#64748b');
    doc.text("Decisions : CA (Credit Acquis, >=50)   |   CANT (Credit Acquis Non Compensable, 35-49)   |   NC (Non Compensable, 0-34)   |   EL (Elimine / Non Evalue)", startX, finalY);

    doc.end();
  } catch (err) {
    console.error('Erreur lors de la generation du PV UE:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la generation du PV UE', error: err.message });
    }
  }
};

// ============================================================================
// PV DE RATTRAPAGE PAR UE
// ============================================================================
exports.generatePvUeRattrapage = async (req, res) => {
  const { idue, annee, idsemestre, idclasse } = req.body;

  if (!idue || !annee || !idsemestre || !idclasse) {
    return res.status(400).json({ message: 'idue, annee, idsemestre et idclasse sont requis.' });
  }

  const semInput = Number(idsemestre);
  if (semInput !== 1 && semInput !== 2 && semInput !== 3 && semInput !== 4) {
    return res.status(400).json({ message: "idsemestre doit etre 1, 2, 3 ou 4." });
  }

  const semBase = (semInput === 1 || semInput === 3) ? 1 : 2;
  const semRattrapage = (semInput === 1 || semInput === 3) ? 3 : 4;

  try {
    const ueRows = await query('SELECT * FROM UE WHERE IDUE = ?', [idue]);
    if (!ueRows.length) throw new Error('UE introuvable');
    const ue = ueRows[0];

    const classeRows = await query(
      `SELECT c.*, f.NOM AS FILIERE_NOM, f.CODFILIERE,
              s.INTITULE AS SPECIALITE_INTITULE, g.INTITULE AS GRADE_INTITULE
       FROM Classe c
       LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
       LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
       LEFT JOIN Grade g ON g.CODGRADE = c.CODGRADE
       WHERE c.IDCLASSE = ?`,
      [idclasse]
    );
    if (!classeRows.length) throw new Error('Classe introuvable');
    const classe = classeRows[0];

    const rows = await query(
      `SELECT e.MATRICULE, e.NOM,
              m2.MOYENNE, m2.CODMENTION, m2.CREDIT, m2.QdP, m2.Decision
       FROM Inscript i
       JOIN Etudiant e ON e.MATRICULE = i.MATRICULE
       JOIN Moyennes m2
         ON m2.MATRICULE = i.MATRICULE
        AND m2.IDUE = ? AND m2.ANNEE = ? AND m2.IDSEMESTRE = ?
       WHERE i.IDCLASSE = ? AND i.ANNEE = ?
       ORDER BY e.NOM`,
      [idue, annee, semRattrapage, idclasse, annee]
    );
// DEBUT DEBUG

console.log('🚀 DEBUG: avant Promise.all');
console.log('idue =', idue);
console.log('idclasse =', idclasse);
console.log('annee =', annee);

let evaluationRows;
let ecNoteRows;

try {
  console.log('🔎 DEBUG: lancement requête evaluationRows...');

  evaluationRows = await query(
    `SELECT e.IDEC, e.INTITULE, t.type, t.echelle
     FROM ec e
     JOIN ec_evaluation_types t ON t.IDEC = e.IDEC
     WHERE e.IDUE = ?
     ORDER BY e.IDEC, FIELD(t.type,'CC','TP','SN')`,
    [idue]
  );

  console.log('✅ evaluationRows récupérées:', evaluationRows);
  console.log('📊 nombre evaluationRows:', evaluationRows.length);

  console.log('🔎 DEBUG: lancement requête ecNoteRows...');

  ecNoteRows = await query(
    `SELECT n.MATRICULE, n.IDEC, n.note_cc, n.note_tp, n.note_sn
     FROM notes n
     JOIN ec e ON e.IDEC = n.IDEC
     WHERE e.IDUE = ? AND n.IDCLASSE = ? AND n.ANNEE = ?`,
    [idue, idclasse, annee]
  );

  console.log('✅ ecNoteRows récupérées:', ecNoteRows);
  console.log('📊 nombre ecNoteRows:', ecNoteRows.length);

} catch (error) {
  console.error('❌ ERREUR pendant les requêtes SQL:', error);
  console.error('❌ message:', error.message);
  console.error('❌ stack:', error.stack);

  throw error;
}

console.log('➡️ DEBUG: après les deux requêtes');

const ecIdsOfUE = [...new Set(
  evaluationRows.map((r) => Number(r.IDEC))
)];

console.log('📌 ecIdsOfUE =', ecIdsOfUE);

const composanteCaption = buildComposanteCaption(evaluationRows);

console.log('📌 composanteCaption =', composanteCaption);

let echelleCC = 0;
let echelleSN = 0;
let echelleTP = 0;
let hasTP = false;

console.log('📌 AVANT calcul des échelles');
console.log('echelle CC =', echelleCC);
console.log('echelle SN =', echelleSN);
console.log('echelle TP =', echelleTP);

evaluationRows.forEach((row) => {
  console.log('🔍 row =', row);

  if (row.type === 'CC') {
    echelleCC += Number(row.echelle || 0);
    console.log('➡️ CC:', row.echelle, '=> total =', echelleCC);
  }

  if (row.type === 'SN') {
    echelleSN += Number(row.echelle || 0);
    console.log('➡️ SN:', row.echelle, '=> total =', echelleSN);
  }

  if (row.type === 'TP') {
    echelleTP += Number(row.echelle || 0);
    hasTP = true;
    console.log('➡️ TP:', row.echelle, '=> total =', echelleTP);
  }
});

console.log('✅ APRÈS calcul des échelles');
console.log('echelle CC =', echelleCC);
console.log('echelle SN =', echelleSN);
console.log('echelle TP =', echelleTP);
console.log('hasTP =', hasTP);


    // FIN DEBUG

    if (echelleCC === 0) echelleCC = 30;
    if (echelleSN === 0) echelleSN = 70;

    const notesByStudent = new Map();
    ecNoteRows.forEach((note) => {
      if (!notesByStudent.has(note.MATRICULE)) notesByStudent.set(note.MATRICULE, {});
      notesByStudent.get(note.MATRICULE)[Number(note.IDEC)] = note;
    });

        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PV_Rattrapage_UE_${idue}_${Date.now()}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    drawHeader(doc, pageWidth, 18);

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000');
    doc.text("PROCES VERBAL DE RATTRAPAGE - UNITE D'ENSEIGNEMENT", 0, 70, { align: 'center' });

    const ueTitle = `${ue.CODUE || ''} - ${ue.INTITULE || ''}`.toUpperCase();
    doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#000000');
    doc.text(ueTitle, 0, 84, { align: 'center' });

    doc.fontSize(8).font('Helvetica').fillColor('#000000');
    doc.text(`Filiere : ${classe.FILIERE_NOM || '-'}   |   Specialite : ${classe.SPECIALITE_INTITULE || '-'}   |   Grade : ${classe.GRADE_INTITULE || classe.CODGRADE || '-'}   |   Niveau : ${classe.NIVEAU || '-'}   |   Annee : ${annee}   |   Session : Rattrapage S${semBase} (Semestre ${semRattrapage})`, 0, 98, { align: 'center' });

    if (composanteCaption) {
      doc.fontSize(6.5).font('Helvetica-Oblique').fillColor('#000000').text(`Composantes de l'UE : ${composanteCaption}`, 30, 110, { width: pageWidth - 60, align: 'center' });
    }

    const tableTop = composanteCaption ? 122 : 114;
    const headers = [
      'Num',
      'Matricule',
      'Nom et prenom',
      'Niveau',
      'ANO_CC',
      `CC/${echelleCC}`,
      'ANO_EE',
      `EE/${echelleSN}`
    ];

    let colWidths = [];
    if (hasTP) {
      headers.push(`EP/${echelleTP || 20}`);
      headers.push('TOTAL/100', 'DEC', 'MENTION');
      colWidths = [26, 72, 195, 66, 48, 52, 48, 52, 52, 60, 55, 55];
    } else {
      headers.push('TOTAL/100', 'DEC', 'MENTION');
      colWidths = [26, 75, 230, 70, 52, 56, 52, 56, 60, 52, 52];
    }

    const startX = 30;

    if (!rows.length) {
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      doc.text(
        'Aucun etudiant ne figure en session de rattrapage pour cette UE.',
        30, tableTop + 20,
        { align: 'center', width: pageWidth - 60 }
      );
    } else {
      const tableRows = [];
      const decisionCounts = { CA: 0, CANT: 0, NC: 0, EL: 0 };
      const niveauCode = buildNiveauCode(classe);

      rows.forEach((r, i) => {
        const totalScore = r.MOYENNE !== null && r.MOYENNE !== undefined ? Number(r.MOYENNE) : null;
        const dec = getDecisionUePV(totalScore);
        const mention = getMentionUePV(totalScore);
        decisionCounts[dec] = (decisionCounts[dec] || 0) + 1;

        const studentNotes = notesByStudent.get(r.MATRICULE) || {};
        const { sums, hasValue } = sumStudentEvalByType(ecIdsOfUE, studentNotes);

        const rowData = [
          (i + 1).toString(),
          r.MATRICULE,
          r.NOM,
          niveauCode,
          '-',
          hasValue.CC ? sums.CC.toFixed(2) : '-',
          '-',
          hasValue.SN ? sums.SN.toFixed(2) : '-'
        ];

        if (hasTP) {
          rowData.push(hasValue.TP ? sums.TP.toFixed(2) : '-');
        }

        rowData.push(
          totalScore !== null ? totalScore.toFixed(2) : '-',
          dec,
          mention
        );

        tableRows.push(rowData);
      });

      let finalY = drawTable(doc, tableTop, headers, tableRows, colWidths, startX);

      finalY += 12;
      if (finalY + 60 > doc.page.height - 25) {
        doc.addPage();
        finalY = 25;
      }

      finalY = drawHashTitle(doc, pageWidth, finalY, 'Statistiques de Validation - Rattrapage', startX);

      const totalRattrapage = rows.length;
      const statLabels = ['CA', 'CANT', 'NC', 'EL'];
      const statHeaders = ['Effectif Total', ...statLabels, ...statLabels.map((l) => `%${l}`)];
      const statColWidths = [70, ...statLabels.map(() => 45), ...statLabels.map(() => 45)];
      const statRow = [
        totalRattrapage.toString(),
        ...statLabels.map((l) => (decisionCounts[l] || 0).toString()),
        ...statLabels.map((l) => totalRattrapage ? (((decisionCounts[l] || 0) / totalRattrapage) * 100).toFixed(2) + '%' : '0.00%')
      ];

      finalY = drawTable(doc, finalY + 6, statHeaders, [statRow], statColWidths, startX);

      finalY += 8;
      doc.fontSize(6.5).font('Helvetica-Oblique').fillColor('#000000');
      doc.text("Decisions : CA (Credit Acquis, >=50)   |   CANT (Credit Acquis Non Compensable, 35-49)   |   NC (Non Compensable, 0-34)   |   EL (Elimine / Non Evalue)", startX, finalY);
    }

    doc.end();
  } catch (err) {
    console.error('Erreur lors de la generation du PV de rattrapage UE:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la generation du PV de rattrapage UE', error: err.message });
    }
  }
};

// ============================================================================
// PV RECAPITULATIF DE CYCLE
// ============================================================================
exports.generateRecap = async (req, res) => {
  try {
    const { matricule, grade } = req.body;
    if (!matricule || !grade) {
      return res.status(400).json({ message: 'matricule et grade sont requis.' });
    }

    const etudiantRows = await query('SELECT * FROM Etudiant WHERE MATRICULE = ?', [matricule.trim()]);
    if (!etudiantRows.length) return res.status(404).json({ message: 'Etudiant non trouve.' });
    const etudiant = etudiantRows[0];

    const pvRows = await query(
      'SELECT * FROM ulmdpvrecap WHERE MATRICULE = ? AND GRADE = ? ORDER BY NIV ASC, IDSEMESTRE ASC',
      [matricule.trim(), grade]
    );

    if (!pvRows.length) {
      // Section 10 : "l'absence de proces-verbal vaut refus". On ne genere
      // pas un document qui affirmerait une admission non prononcee.
      throw new Error(`Aucun proces-verbal de deliberation (ulmdpvrecap) trouve pour ${matricule} en grade ${grade}. L'absence de PV vaut refus : aucun document ne peut etre emis.`);
    }

    // Regroupement par niveau (NIV). Un niveau peut porter plusieurs lignes
    // (une par semestre : S5/S6 pour une Licence 3 par exemple).
    const niveauxMap = new Map();
    pvRows.forEach((row) => {
      const key = row.NIV;
      if (!niveauxMap.has(key)) niveauxMap.set(key, []);
      niveauxMap.get(key).push(row);
    });

    const niveaux = [...niveauxMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([niv, semestreRows]) => {
        const ues = semestreRows.flatMap((r) => unpivotUEs(r).map(ue => ({ ...ue, semestre: r.IDSEMESTRE })));

        const creditChoi = semestreRows.reduce((s, r) => s + Number(r.CREDIT_CHOI || 0), 0);
        const creditCap = semestreRows.reduce((s, r) => s + Number(r.CREDIT_CAP || 0), 0);

        // MGP du niveau : moyenne des MGP de semestre ponderee par leur
        // CREDIT_CHOI respectif (ASSOMPTION A CONFIRMER si le jury calcule autrement).
        const mgp = creditChoi > 0
          ? semestreRows.reduce((s, r) => s + Number(r.MGP || 0) * Number(r.CREDIT_CHOI || 0), 0) / creditChoi
          : 0;

        // Regle section 10 : ADMIS seulement si TOUTES les lignes du niveau le sont.
        const decisions = semestreRows.map(r => normalizeDecision(r.DECISION));
        const niveauAdmis = decisions.length > 0 && decisions.every(d => d === 'ADMIS');

        const first = semestreRows[0];
        return {
          niv,
          niveauLabel: first.NIVEAU || `Niveau ${niv}`,
          idclasse: first.IDCLASSE,
          annee: first.ANNEE,
          codfiliere: first.CODFILIERE,
          codspecialite: first.CODSPECIALITE,
          intituleFiliere: first.INTITULE_FILIERE,
          intituleSpecialite: first.INTITULE_SPECIALITE,
          semestres: semestreRows.map(r => ({
            idsemestre: r.IDSEMESTRE,
            mgp: Number(r.MGP || 0),
            creditChoi: Number(r.CREDIT_CHOI || 0),
            creditCap: Number(r.CREDIT_CAP || 0),
            pourcentCap: Number(r.POURCENT_CAP || 0),
            decision: r.DECISION
          })),
          ues,
          creditChoi,
          creditCap,
          mgp,
          admis: niveauAdmis
        };
      });

    const cycleAdmis = niveaux.every(n => n.admis);
    const creditsCycleChoi = niveaux.reduce((s, n) => s + n.creditChoi, 0);
    const creditsCycleCap = niveaux.reduce((s, n) => s + n.creditCap, 0);
    const mgpCycle = creditsCycleChoi > 0
      ? niveaux.reduce((s, n) => s + n.mgp * n.creditChoi, 0) / creditsCycleChoi
      : 0;

    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=PV_Recap_${grade}_${etudiant.MATRICULE}.pdf`);
    doc.pipe(res);

    const W = 595.28;
    const ML = 32;
    const MR = 32;

    doc.font('Helvetica-Bold').fontSize(10).fillColor('black')
      .text('UNIVERSITE DE YAOUNDE I', ML, 30)
      .text('UNIVERSITE DE YAOUNDE I', ML, 30, { align: 'right', width: W - ML - MR });
    doc.fontSize(9)
      .text('FACULTE DES SCIENCES', ML, 44)
      .text('FACULTY OF SCIENCE', ML, 44, { align: 'right', width: W - ML - MR });

    try {
      const logoPath = getLogoPath();
      if (logoPath) doc.image(logoPath, W / 2 - 22, 28, { width: 44, height: 52 });
    } catch (err) {
      console.error("Erreur lors de l'insertion du logo:", err.message);
    }

    const premierNiveau = niveaux[0];
    doc.font('Helvetica-Bold').fontSize(11)
      .text(`${grade === 'M' ? 'MASTER' : 'LICENCE'} DE : ${(premierNiveau.intituleFiliere || '-').toUpperCase()}`,
            ML, 88, { align: 'center', width: W - ML - MR });
    doc.fontSize(9)
      .text(`SPECIALITE : ${(premierNiveau.intituleSpecialite || '-').toUpperCase()}`,
            ML, 102, { align: 'center', width: W - ML - MR });
    doc.fontSize(14)
      .text('PROCES VERBAL RECAPITULATIF', ML, 120, { align: 'center', width: W - ML - MR });

    doc.moveTo(ML, 140).lineTo(W - MR, 140).lineWidth(0.5).stroke();

    doc.font('Helvetica').fontSize(9).fillColor('black');
    doc.text(`Matricule : ${etudiant.MATRICULE}`, ML, 148);
    doc.text(`Nom & Prenom : ${etudiant.NOM || ''}`, ML + 160, 148);
    doc.text(`Ne(e) le : ${etudiant.DATENAISSANCE || '-'}  a  ${etudiant.VILLENAISSANCE || '-'}`, ML, 160);

    doc.moveTo(ML, 173).lineTo(W - MR, 173).lineWidth(0.3).stroke();

    let y = 183;

    const measureRowHeight = (cols, widths, fontSize = 7) => {
      doc.fontSize(fontSize);
      const heights = cols.map((col, i) => doc.heightOfString(String(col), { width: widths[i] }));
      return Math.max(11, Math.max(...heights) + 3);
    };

    const drawTableRow = (cols, xOffsets, widths, yPos, bold, fillGray) => {
      const font = bold ? 'Helvetica-Bold' : 'Helvetica';
      const rowHeight = measureRowHeight(cols, widths);
      if (fillGray) {
        doc.rect(ML, yPos - 2, W - ML - MR, rowHeight).fillColor('#eeeeee').fill();
        doc.fillColor('black');
      }
      doc.font(font).fontSize(7);
      cols.forEach((col, i) => {
        doc.text(String(col), ML + xOffsets[i], yPos, { width: widths[i] });
      });
      return rowHeight;
    };

    const COL_X = [0, 90, 170, 215, 255, 290, 330];
    const COL_W = [88, 78, 43, 38, 33, 38, 100];
    const HDRS = ['UE', 'Intitule', 'Credits', 'Note/100', 'QdP', 'Sem.', 'Cap.'];

    const headerHeight = drawTableRow(HDRS, COL_X, COL_W, y, true, true);
    y += headerHeight + 4;
    doc.moveTo(ML, y).lineTo(W - MR, y).lineWidth(0.3).stroke();
    y += 3;

    for (const niveau of niveaux) {
      const decisionColor = niveau.admis ? '#1a237e' : '#b71c1c';
      doc.font('Helvetica-Bold').fontSize(8).fillColor(decisionColor)
        .text(`Niveau : ${niveau.niveauLabel}  -  MGP: ${niveau.mgp.toFixed(2)}/4.0  -  Credits: ${niveau.creditCap}/${niveau.creditChoi}  -  ${niveau.admis ? 'ADMIS' : 'AJOURNE'}`,
              ML, y, { width: W - ML - MR });
      y += 13;
      doc.fillColor('black');

      for (const ue of niveau.ues) {
        const ueCols = [
          ue.code || '-',
          '', // pas d'intitule UE dans ulmdpvrecap, seulement le code
          ue.credit.toString(),
          ue.note !== null ? ue.note.toFixed(2) : '-',
          ue.qdp !== null ? ue.qdp.toFixed(2) : '-',
          ue.semestre,
          ue.creditCap.toString()
        ];

        const hPreview = measureRowHeight(ueCols, COL_W);
        if (y + hPreview > 760) {
          doc.addPage();
          y = 40;
        }

        const h = drawTableRow(ueCols, COL_X, COL_W, y, false, false);
        y += h;
      }
      doc.moveTo(ML, y).lineTo(W - MR, y).lineWidth(0.2).strokeColor('#cccccc').stroke();
      doc.strokeColor('black');
      y += 8;
    }

    y += 10;
    const decisionColor = cycleAdmis ? '#1b5e20' : '#b71c1c';
    doc.rect(ML, y, W - ML - MR, 22).lineWidth(1).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(decisionColor)
      .text(`DECISION : ${cycleAdmis ? 'ADMIS(E)' : 'AJOURN(E)'}  -  MGP Cycle : ${mgpCycle.toFixed(2)}/4.0  -  Credits : ${creditsCycleCap}/${creditsCycleChoi}`,
            ML + 5, y + 5, { width: W - ML - MR - 10, align: 'center' });
    doc.fillColor('black');

    const pageRange = doc.bufferedPageRange();
    const totalPages = pageRange.count;
    for (let pg = 0; pg < totalPages; pg++) {
      doc.switchToPage(pageRange.start + pg);
      const H = 841.89;
      doc.moveTo(ML, H - 26).lineTo(W - MR, H - 26).lineWidth(0.4).stroke();
      doc.font('Helvetica').fontSize(7)
        .text(`PV recap ${grade} - ${etudiant.MATRICULE}`, ML, H - 14)
        .text(`Page ${pg + 1} / ${totalPages}`, ML, H - 14, { align: 'right', width: W - ML - MR });
    }

    doc.end();
  } catch (err) {
    console.error('Erreur generateRecap:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la generation du PV recap', error: err.message });
    }
  }
};

// ============================================================================
// PV RECAPITULATIF DE CLASSE (tous les etudiants d'une classe, semestres agreges)
// POST /api/pv/generate-recap-classe
// Body: { idclasse, annee }
//
// Hypotheses validees avec Yann (15/08/2026) :
//  - 1 ligne par etudiant : N (numero de ligne, pas le matricule), NOM
//    PRENOM, MATRICULE, NIVEAU, une colonne par CODUE reellement rencontre
//    dans la classe, CAP, CHOI, %CAP, MGP, DECISION.
//  - Semestres agreges (comme generateRecap), pas de PV par semestre.
//  - Tri alphabetique par NOM (fait en SQL sur Inscript+Etudiant).
//  - Colonnes UE construites a partir des CODUE reels rencontres dans la
//    classe, triees alphabetiquement -- pas de la position brute du slot
//    IDUE1..35, qui n'a pas de signification stable d'une annee sur l'autre
//    (cf. schema, table UE : "le meme CODUE est reattribue d'une version de
//    maquette a l'autre").
//  - Statistiques de classe en bas (comme generatePvUe) : comptage
//    dynamique par valeur de decisionLabel reellement rencontree.
//  - Etudiant inscrit (Inscript) sans ligne ulmdpvrecap pour l'annee :
//    apparait quand meme, avec la mention explicite "PV NON DISPONIBLE"
//    dans la colonne Decision et '-' partout ailleurs -- jamais omis,
//    jamais affiche comme admis (schema section 10 : l'absence de PV vaut
//    refus).
//
// NB : comme generateRecap, cette fonction lit ulmdpvrecap (deja pivote au
// niveau UE, pas au niveau EC) -- non impactee par la migration EC-miroir.
// ============================================================================
exports.generatePvRecapClasse = async (req, res) => {
  try {
    const { idclasse, annee } = req.body;
    if (!idclasse || !annee) {
      return res.status(400).json({ message: 'idclasse et annee sont requis.' });
    }

    const classeRows = await query(
      `SELECT c.*, f.NOM AS FILIERE_NOM, f.CODFILIERE,
              s.INTITULE AS SPECIALITE_INTITULE, g.INTITULE AS GRADE_INTITULE
       FROM Classe c
       LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
       LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
       LEFT JOIN Grade g ON g.CODGRADE = c.CODGRADE
       WHERE c.IDCLASSE = ?`,
      [idclasse]
    );
    if (!classeRows.length) throw new Error('Classe introuvable');
    const classe = classeRows[0];

    // Roster de la classe pour l'annee. Source de la liste : Inscript, pas
    // ulmdpvrecap (qui pourrait omettre des etudiants sans deliberation).
    const roster = await query(
      `SELECT e.MATRICULE, e.NOM
       FROM Inscript i
       JOIN Etudiant e ON e.MATRICULE = i.MATRICULE
       WHERE i.IDCLASSE = ? AND i.ANNEE = ?
       ORDER BY e.NOM ASC`,
      [idclasse, annee]
    );

    if (!roster.length) {
      throw new Error(`Aucun etudiant inscrit (Inscript) pour la classe ${idclasse} en ${annee}.`);
    }

    // Toutes les lignes ulmdpvrecap de la classe/annee, tous semestres et
    // etudiants confondus -- regroupees ensuite par matricule en JS.
    // La comparaison JS force .toUpperCase() des deux cotes : MySQL est
    // insensible a la casse (collation utf8mb4_unicode_520_ci) mais JS non.
    const pvRows = await query(
      'SELECT * FROM ulmdpvrecap WHERE IDCLASSE = ? AND ANNEE = ? ORDER BY MATRICULE ASC, IDSEMESTRE ASC',
      [idclasse, annee]
    );

    const pvByMatricule = new Map();
    pvRows.forEach((row) => {
      const key = (row.MATRICULE || '').toUpperCase();
      if (!pvByMatricule.has(key)) pvByMatricule.set(key, []);
      pvByMatricule.get(key).push(row);
    });

    const codesUEVus = new Set();
    const etudiantsData = roster.map((etu, idx) => {
      const semestreRows = pvByMatricule.get((etu.MATRICULE || '').toUpperCase());

      if (!semestreRows || !semestreRows.length) {
        return {
          num: idx + 1,
          matricule: etu.MATRICULE,
          nom: etu.NOM,
          niveau: classe.NIVEAU || '-',
          uesByCode: new Map(),
          creditChoi: null,
          creditCap: null,
          pourcentCap: null,
          mgp: null,
          decisionLabel: 'PV NON DISPONIBLE',
          hasPv: false
        };
      }

      // Une seule valeur par CODUE pour l'etudiant : si le meme code
      // apparait sur plusieurs semestres (cas rare), on garde celle du
      // semestre le plus recent (semestreRows deja trie IDSEMESTRE ASC).
      const uesByCode = new Map();
      semestreRows.forEach((row) => {
        unpivotUEs(row).forEach((ue) => {
          if (!ue.code) return;
          uesByCode.set(ue.code, ue);
          codesUEVus.add(ue.code);
        });
      });

      const creditChoi = semestreRows.reduce((s, r) => s + Number(r.CREDIT_CHOI || 0), 0);
      const creditCap = semestreRows.reduce((s, r) => s + Number(r.CREDIT_CAP || 0), 0);
      const pourcentCap = creditChoi > 0 ? (creditCap / creditChoi) * 100 : 0;

      // MGP pondere par CREDIT_CHOI de chaque semestre -- ASSOMPTION A
      // CONFIRMER, reprise telle quelle de generateRecap (non validee par
      // le jury, cf. directive section 3).
      const mgp = creditChoi > 0
        ? semestreRows.reduce((s, r) => s + Number(r.MGP || 0) * Number(r.CREDIT_CHOI || 0), 0) / creditChoi
        : 0;

      // Regle section 10 du schema : ADMIS ssi TOUTES les lignes (tous
      // semestres) portent DECISION = ADMIS, jamais "au moins un semestre".
      const decisions = semestreRows.map(r => normalizeDecision(r.DECISION));
      const admis = decisions.length > 0 && decisions.every(d => d === 'ADMIS');

      return {
        num: idx + 1,
        matricule: etu.MATRICULE,
        nom: etu.NOM,
        niveau: semestreRows[0].NIVEAU || classe.NIVEAU || '-',
        uesByCode,
        creditChoi,
        creditCap,
        pourcentCap,
        mgp,
        decisionLabel: admis ? 'ADMIS' : 'AJOURNE',
        hasPv: true
      };
    });

    // Colonnes UE dynamiques, triees par CODUE reel (valide avec Yann).
    const codesUE = [...codesUEVus].sort((a, b) => String(a).localeCompare(String(b)));

    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PV_Recap_Classe_${idclasse}_${annee}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    drawHeader(doc, pageWidth);

    doc.fontSize(13).font('Helvetica-Bold');
    doc.text('PROCES VERBAL RECAPITULATIF DE CLASSE', 0, 100, { align: 'center' });

    doc.fontSize(10).font('Helvetica');
    doc.text(
      `Filiere : ${classe.FILIERE_NOM || '-'}   -   Specialite : ${classe.SPECIALITE_INTITULE || '-'}   -   Grade : ${classe.GRADE_INTITULE || classe.CODGRADE || '-'}`,
      0, 118, { align: 'center' }
    );
    doc.text(
      `Niveau : ${classe.NIVEAU || '-'}   -   Annee : ${annee}   -   Effectif : ${roster.length}`,
      0, 132, { align: 'center' }
    );

    const fixedHeaders = ['N', 'Matricule', 'Nom & Prenom', 'Niveau'];
    const fixedWidths = [25, 55, 130, 35];
    const tailHeaders = ['CAP', 'CHOI', '%CAP', 'MGP', 'Decision'];
    const tailWidths = [25, 25, 30, 25, 35];

    const usableWidth = pageWidth - 60;
    const fixedTotal = fixedWidths.reduce((a, b) => a + b, 0) + tailWidths.reduce((a, b) => a + b, 0);
    const availableForUE = Math.max(0, usableWidth - fixedTotal);
    const ueColWidth = codesUE.length > 0 ? Math.max(22, availableForUE / codesUE.length) : 0;
    const ueWidths = codesUE.map(() => ueColWidth);

    const headers = [...fixedHeaders, ...codesUE, ...tailHeaders];
    const colWidths = [...fixedWidths, ...ueWidths, ...tailWidths];

    const decisionCounts = {};
    const tableRows = etudiantsData.map((etu) => {
      decisionCounts[etu.decisionLabel] = (decisionCounts[etu.decisionLabel] || 0) + 1;
      const ueCells = codesUE.map((code) => {
        const ue = etu.uesByCode.get(code);
        if (!ue || ue.note === null || ue.note === undefined || Number.isNaN(ue.note)) return '-';
        return ue.note;
      });
      return [
        etu.num.toString(),
        etu.matricule,
        etu.nom,
        etu.niveau,
        ...ueCells,
        etu.hasPv ? etu.creditCap : '-',
        etu.hasPv ? etu.creditChoi : '-',
        etu.hasPv ? etu.pourcentCap.toFixed(1) : '-',
        etu.hasPv ? etu.mgp.toFixed(2) : '-',
        etu.decisionLabel
      ];
    });

    let finalY = drawTable(doc, 150, headers, tableRows, colWidths, 30);

    if (finalY + 60 > doc.page.height - 50) {
      doc.addPage();
      finalY = 40;
    } else {
      finalY += 25;
    }

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000');
    doc.text('Statistiques de la classe', 30, finalY);

    const totalEtudiants = etudiantsData.length;
    const statLabels = Object.keys(decisionCounts);
    const statHeaders = ['Effectif', ...statLabels, ...statLabels.map(l => `%${l}`)];
    const statColWidths = [60, ...statLabels.map(() => 90), ...statLabels.map(() => 55)];
    const statRow = [
      totalEtudiants.toString(),
      ...statLabels.map(l => decisionCounts[l].toString()),
      ...statLabels.map(l => totalEtudiants ? ((decisionCounts[l] / totalEtudiants) * 100).toFixed(2) : '0.00')
    ];

    drawTable(doc, finalY + 15, statHeaders, [statRow], statColWidths, 30);

    doc.end();
  } catch (err) {
    console.error('Erreur lors de la generation du PV recap classe:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la generation du PV recap classe', error: err.message });
    }
  }
};

// ============================================================================
// OPTIONS DE TIRAGE PV SELON PROFIL ET PERMISSIONS
// GET /api/pv/options
// ============================================================================
exports.getPvOptions = async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = ['SUPER_ADMIN', 'ADMIN_ACADEMIQUE'].includes(user.role);
    const isTeacher = user.role === 'ENSEIGNANT';
    const isJury = user.role === 'JURY';

    // 1. Années académiques
    const years = await query('SELECT annee, est_active FROM academic_years ORDER BY annee DESC');
    const activeYear = years.find(y => y.est_active)?.annee || years[0]?.annee;

    // 2. Grades
    const grades = await query('SELECT CODGRADE, INTITULE FROM Grade ORDER BY CODGRADE ASC');

    // 3. Classes
    let classesSql = `
      SELECT c.IDCLASSE, c.NIVEAU, c.CODGRADE,
             f.NOM AS FILIERE_NOM, f.CODFILIERE,
             s.INTITULE AS SPECIALITE_INTITULE, g.INTITULE AS GRADE_INTITULE
      FROM Classe c
      LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
      LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
      LEFT JOIN Grade g ON g.CODGRADE = c.CODGRADE
      WHERE 1=1
    `;
    const classesParams = [];

    if (isTeacher) {
      classesSql += ` AND (
        c.IDCLASSE IN (SELECT IDCLASSE FROM teacher_ue_assignments WHERE user_id = ?)
        OR c.IDCLASSE IN (SELECT IDCLASSE FROM jury WHERE president_id = ? OR id IN (SELECT jury_id FROM jury_membres WHERE user_id = ?))
      )`;
      classesParams.push(user.id, user.id, user.id);
    } else if (isJury) {
      classesSql += ` AND c.IDCLASSE IN (
        SELECT IDCLASSE FROM jury WHERE president_id = ? OR id IN (SELECT jury_id FROM jury_membres WHERE user_id = ?)
      )`;
      classesParams.push(user.id, user.id);
    }

    classesSql += ' ORDER BY f.NOM, c.NIVEAU, c.IDCLASSE';
    const classes = await query(classesSql, classesParams);

    // 4. UEs affectées (pour les enseignants) ou toutes les UEs programmées
    let assignedUes = [];
    if (isTeacher) {
      assignedUes = await query(`
        SELECT a.id, a.user_id, a.IDCLASSE, a.IDUE, a.ANNEE,
               u.CODUE, u.INTITULE, p.CREDIT, ps.IDSEMESTRE,
               c.NIVEAU, c.CODGRADE, f.NOM AS FILIERE_NOM, s.INTITULE AS SPECIALITE_INTITULE
        FROM teacher_ue_assignments a
        JOIN UE u ON u.IDUE = a.IDUE
        JOIN Classe c ON c.IDCLASSE = a.IDCLASSE
        LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
        LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
        LEFT JOIN Programme p ON p.IDCLASSE = a.IDCLASSE AND p.IDUE = a.IDUE AND p.ANNEE = a.ANNEE
        LEFT JOIN programme_semestres ps ON ps.IDCLASSE = a.IDCLASSE AND ps.IDUE = a.IDUE AND ps.ANNEE = a.ANNEE
        WHERE a.user_id = ?
        ORDER BY a.ANNEE DESC, f.NOM, c.NIVEAU, u.CODUE
      `, [user.id]);
    } else {
      assignedUes = await query(`
        SELECT DISTINCT p.IDCLASSE, p.IDUE, p.ANNEE,
               u.CODUE, u.INTITULE, p.CREDIT, ps.IDSEMESTRE,
               c.NIVEAU, c.CODGRADE, f.NOM AS FILIERE_NOM, s.INTITULE AS SPECIALITE_INTITULE
        FROM Programme p
        JOIN UE u ON u.IDUE = p.IDUE
        JOIN Classe c ON c.IDCLASSE = p.IDCLASSE
        LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
        LEFT JOIN Specialite s ON s.IDSPECIALITE = c.IDSPECIALITE
        LEFT JOIN programme_semestres ps ON ps.IDCLASSE = p.IDCLASSE AND ps.IDUE = p.IDUE AND ps.ANNEE = p.ANNEE
        ORDER BY p.ANNEE DESC, f.NOM, c.NIVEAU, u.CODUE
      `);
    }

    // 5. Jurys accessibles
    let jurysSql = `
      SELECT j.id, j.nom, j.IDCLASSE, j.annee, j.president_id, j.statut,
             c.NIVEAU, c.CODGRADE, f.NOM AS FILIERE_NOM
      FROM jury j
      LEFT JOIN Classe c ON c.IDCLASSE = j.IDCLASSE
      LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
      WHERE 1=1
    `;
    const jurysParams = [];
    if (!isAdmin) {
      jurysSql += ` AND (j.president_id = ? OR j.id IN (SELECT jury_id FROM jury_membres WHERE user_id = ?))`;
      jurysParams.push(user.id, user.id);
    }
    jurysSql += ' ORDER BY j.annee DESC, j.nom ASC';
    const jurys = await query(jurysSql, jurysParams);

    // 6. Sessions de délibération accessibles
    let sessionsSql = `
      SELECT s.id, s.jury_id, s.nom_session, s.statut, s.date_debut, s.date_cloture,
             j.nom AS jury_nom, j.IDCLASSE, j.annee,
             c.NIVEAU, c.CODGRADE, f.NOM AS FILIERE_NOM
      FROM deliberation_sessions s
      JOIN jury j ON j.id = s.jury_id
      LEFT JOIN Classe c ON c.IDCLASSE = j.IDCLASSE
      LEFT JOIN Filiere f ON f.IDFILIERE = c.IDFILIERE
      WHERE 1=1
    `;
    const sessionsParams = [];
    if (!isAdmin) {
      sessionsSql += ` AND (j.president_id = ? OR j.id IN (SELECT jury_id FROM jury_membres WHERE user_id = ?))`;
      sessionsParams.push(user.id, user.id);
    }
    sessionsSql += ' ORDER BY s.created_at DESC, s.id DESC';
    const sessions = await query(sessionsSql, sessionsParams);

    res.json({
      userRole: user.role,
      activeYear,
      years,
      grades,
      classes,
      assignedUes,
      jurys,
      sessions,
      canGenerateAll: isAdmin,
      canGenerateRecapClasse: isAdmin || isJury,
      canGenerateRecapCycle: isAdmin || isJury,
      canGenerateUe: true
    });
  } catch (error) {
    console.error('Erreur getPvOptions:', error);
    res.status(500).json({ message: 'Erreur lors du chargement des options de PV', error: error.message });
  }
};