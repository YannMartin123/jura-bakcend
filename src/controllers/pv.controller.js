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

// FIX (repris de la version precedente) : trace un tableau avec hauteur de
// ligne dynamique (gere le texte qui wrap) + saut de page calcule AVANT de
// dessiner la ligne.
const drawTable = (doc, startY, headers, rows, colWidths, startX = 40) => {
  const headerRowHeight = 20;
  let currentY = startY;

  doc.rect(startX, currentY, colWidths.reduce((a, b) => a + b, 0), headerRowHeight).fillAndStroke('#2d3e50', '#2d3e50');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
  let currentX = startX;
  headers.forEach((h, i) => {
    doc.text(h, currentX, currentY + 6, { width: colWidths[i], align: 'center' });
    currentX += colWidths[i];
  });

  currentY += headerRowHeight;
  doc.fillColor('#000000').font('Helvetica').fontSize(8);

  rows.forEach((row) => {
    const cellHeights = row.map((cell, i) => {
      const text = cell !== null && cell !== undefined ? String(cell) : '-';
      return doc.heightOfString(text, { width: colWidths[i] - 4 });
    });
    const rowHeight = Math.max(20, Math.max(...cellHeights) + 8);

    if (currentY + rowHeight > doc.page.height - 50) {
      doc.addPage();
      currentY = 40;
    }

    currentX = startX;
    doc.rect(startX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight).stroke();
    row.forEach((cell, i) => {
      if (i > 0) {
        doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
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

// En-tete bilingue UY1 commun aux deux documents
const drawHeader = (doc, pageWidth, y = 40) => {
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('REPUBLIQUE DU CAMEROUN', 40, y);
  doc.fontSize(8).font('Helvetica');
  doc.text('Paix - Travail - Patrie', 60, y + 15);
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('UNIVERSITE DE YAOUNDE I', 45, y + 35);
  doc.fontSize(9).font('Helvetica');
  doc.text('FACULTE DES SCIENCES', 50, y + 50);

  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('REPUBLIC OF CAMEROON', pageWidth - 190, y);
  doc.fontSize(8).font('Helvetica');
  doc.text('Peace - Work - Fatherland', pageWidth - 175, y + 15);
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('UNIVERSITY OF YAOUNDE I', pageWidth - 195, y + 35);
  doc.fontSize(9).font('Helvetica');
  doc.text('FACULTY OF SCIENCE', pageWidth - 175, y + 50);

  try {
    const logoPath = getLogoPath();
    if (logoPath) {
      doc.image(logoPath, pageWidth / 2 - 25, y, { width: 50, height: 60 });
    }
  } catch (err) {
    console.error("Erreur lors de l'insertion du logo:", err.message);
  }
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

    // Roster de la classe pour l'annee + moyenne sur cette UE/semestre.
    // On fusionne la note de la session normale (m1) et celle de la session de rattrapage (m2)
    // si elle existe, afin d'afficher la note finale mise a jour.
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

    // Détail des évaluations EC : les notes sont conservées sur leur barème
    // propre (CC /20, TP /30, SN /50…), la moyenne UE reste, elle, sur 100.
    const [evaluationRows, ecNoteRows] = await Promise.all([
      query(`SELECT e.IDEC,e.INTITULE,t.type,t.echelle
             FROM ec e JOIN ec_evaluation_types t ON t.IDEC=e.IDEC
             WHERE e.IDUE=? ORDER BY e.IDEC, FIELD(t.type,'CC','TP','SN')`, [idue]),
      query(`SELECT n.MATRICULE,n.IDEC,n.note_cc,n.note_tp,n.note_sn
             FROM ec_notes n JOIN ec e ON e.IDEC=n.IDEC
             WHERE e.IDUE=? AND n.IDCLASSE=? AND n.ANNEE=?`, [idue, idclasse, annee]),
    ]);
    const evaluationColumns = evaluationRows.map((item, index) => ({
      key: `${item.IDEC}-${item.type}`,
      idec: Number(item.IDEC),
      type: item.type,
      echelle: Number(item.echelle),
      label: evaluationRows.length === 1 ? `${item.type} /${item.echelle}` : `EC${evaluationRows.findIndex((row) => Number(row.IDEC) === Number(item.IDEC)) + 1} ${item.type}\n/${item.echelle}`,
    }));
    const notesByStudent = new Map();
    ecNoteRows.forEach((note) => {
      if (!notesByStudent.has(note.MATRICULE)) notesByStudent.set(note.MATRICULE, {});
      notesByStudent.get(note.MATRICULE)[note.IDEC] = note;
    });

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PV_UE_${idue}_${Date.now()}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    drawHeader(doc, pageWidth);

    doc.fontSize(14).font('Helvetica-Bold');
    doc.text("PROCES VERBAL DE L'UNITE D'ENSEIGNEMENT", 0, 130, { align: 'center' });

    const ueTitle = `${ue.CODUE || ''} - ${ue.INTITULE || ''}`.toUpperCase();
    doc.fontSize(12).font('Helvetica');
    doc.text(ueTitle, 0, 150, { align: 'center' });

    doc.fontSize(10).font('Helvetica');
    doc.text(`Filiere : ${classe.FILIERE_NOM || '-'}   |   Specialite : ${classe.SPECIALITE_INTITULE || '-'}`, 0, 170, { align: 'center' });
    doc.text(`Grade : ${classe.GRADE_INTITULE || classe.CODGRADE || '-'}   |   Niveau : ${classe.NIVEAU || '-'}   |   Annee : ${annee}   |   Semestre : ${idsemestre}`, 0, 185, { align: 'center' });

    if (evaluationColumns.length > 1) {
      const labels = [...new Map(evaluationRows.map((item, index) => [item.IDEC, `EC${evaluationRows.findIndex((row) => Number(row.IDEC) === Number(item.IDEC)) + 1}: ${item.INTITULE || `Élément ${item.IDEC}`}`])).values()];
      doc.fontSize(7).font('Helvetica').text(`Détail des EC : ${labels.join('   |   ')}`, 40, 198, { width: pageWidth - 80, align: 'center' });
    }

    const detailWidth = evaluationColumns.length ? Math.max(28, Math.floor(280 / evaluationColumns.length)) : 0;
    const headers = ['N', 'Matricule', 'Nom & Prenom', ...evaluationColumns.map((column) => column.label), 'Moyenne\n/100', 'Credit', 'QdP', 'Mention', 'Decision'];
    const colWidths = [24, 65, 135, ...evaluationColumns.map(() => detailWidth), 55, 40, 40, 50, 60];

    const tableRows = [];
    const decisionCounts = {};

    rows.forEach((r, i) => {
      const decision = r.Decision || (r.MOYENNE !== null ? getGradeLocal(Number(r.MOYENNE)) : '-');
      decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;
      const studentNotes = notesByStudent.get(r.MATRICULE) || {};
      tableRows.push([
        (i + 1).toString(),
        r.MATRICULE,
        r.NOM,
        ...evaluationColumns.map((column) => {
          const note = studentNotes[column.idec];
          const value = column.type === 'CC' ? note?.note_cc : column.type === 'TP' ? note?.note_tp : note?.note_sn;
          return value !== null && value !== undefined ? Number(value).toFixed(2) : '-';
        }),
        r.MOYENNE !== null ? Number(r.MOYENNE).toFixed(2) : '-',
        r.CREDIT !== null ? r.CREDIT : '-',
        r.QdP !== null ? Number(r.QdP).toFixed(2) : (r.MOYENNE !== null ? getQdpLocal(Number(r.MOYENNE)).toFixed(2) : '-'),
        r.CODMENTION || (r.MOYENNE !== null ? getMentionLocal(Number(r.MOYENNE)) : '-'),
        decision
      ]);
    });

    let finalY = drawTable(doc, evaluationColumns.length > 1 ? 212 : 210, headers, tableRows, colWidths, 40);

    // Statistiques : comptage dynamique par valeur de Decision reellement
    // rencontree (CA/CANT/NC/...), pas une liste de grades codee en dur.
    finalY += 30;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000');
    doc.text("Statistiques de l'Unite d'Enseignement", 40, finalY);

    const totalEtudiants = rows.length;
    const statLabels = Object.keys(decisionCounts);
    const statHeaders = ['Effectif', ...statLabels.map(l => l), ...statLabels.map(l => `%${l}`)];
    const statColWidths = [60, ...statLabels.map(() => 45), ...statLabels.map(() => 45)];
    const statRow = [
      totalEtudiants.toString(),
      ...statLabels.map(l => decisionCounts[l].toString()),
      ...statLabels.map(l => totalEtudiants ? ((decisionCounts[l] / totalEtudiants) * 100).toFixed(2) : '0.00')
    ];

    drawTable(doc, finalY + 15, statHeaders, [statRow], statColWidths, 40);

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
// POST /api/pv/generate-ue-rattrapage
// Body: { idue, annee, idsemestre, idclasse }
// idsemestre = semestre de BASE de l'UE (1 ou 2).
// Semestre de rattrapage derive automatiquement : S1 -> S3, S2 -> S4.
// Seuls les etudiants ayant une note de rattrapage (INNER JOIN) apparaissent.
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

    // INNER JOIN : seuls les etudiants ayant une note de rattrapage apparaissent
    const rows = await query(
      `SELECT e.MATRICULE, e.NOM,
              m.MOYENNE, m.CODMENTION, m.CREDIT, m.QdP, m.Decision
       FROM Inscript i
       JOIN Etudiant e ON e.MATRICULE = i.MATRICULE
       INNER JOIN Moyennes m
              ON m.MATRICULE = i.MATRICULE
             AND m.IDUE = ? AND m.ANNEE = ? AND m.IDSEMESTRE = ?
       WHERE i.IDCLASSE = ? AND i.ANNEE = ?
       ORDER BY e.NOM`,
      [idue, annee, semRattrapage, idclasse, annee]
    );

    const [evaluationRows, ecNoteRows] = await Promise.all([
      query(`SELECT e.IDEC,e.INTITULE,t.type,t.echelle
             FROM ec e JOIN ec_evaluation_types t ON t.IDEC=e.IDEC
             WHERE e.IDUE=? ORDER BY e.IDEC, FIELD(t.type,'CC','TP','SN')`, [idue]),
      query(`SELECT n.MATRICULE,n.IDEC,n.note_cc,n.note_tp,n.note_sn
             FROM ec_notes n JOIN ec e ON e.IDEC=n.IDEC
             WHERE e.IDUE=? AND n.IDCLASSE=? AND n.ANNEE=?`, [idue, idclasse, annee]),
    ]);

    const evaluationColumns = evaluationRows.map((item) => ({
      key: `${item.IDEC}-${item.type}`,
      idec: Number(item.IDEC),
      type: item.type,
      echelle: Number(item.echelle),
      label: evaluationRows.length === 1
        ? `${item.type} /${item.echelle}`
        : `EC${evaluationRows.findIndex((row) => Number(row.IDEC) === Number(item.IDEC)) + 1} ${item.type}\n/${item.echelle}`,
    }));

    const notesByStudent = new Map();
    ecNoteRows.forEach((note) => {
      if (!notesByStudent.has(note.MATRICULE)) notesByStudent.set(note.MATRICULE, {});
      notesByStudent.get(note.MATRICULE)[note.IDEC] = note;
    });

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PV_RATTRAPAGE_UE_${idue}_${Date.now()}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    drawHeader(doc, pageWidth);

    doc.fontSize(14).font('Helvetica-Bold');
    doc.text("PROCES VERBAL DE RATTRAPAGE - UNITE D'ENSEIGNEMENT", 0, 130, { align: 'center' });

    doc.fontSize(12).font('Helvetica');
    doc.text(`${ue.CODUE || ''} - ${ue.INTITULE || ''}`.toUpperCase(), 0, 150, { align: 'center' });

    doc.fontSize(10).font('Helvetica');
    doc.text(`Filiere : ${classe.FILIERE_NOM || '-'}   |   Specialite : ${classe.SPECIALITE_INTITULE || '-'}`, 0, 170, { align: 'center' });
    doc.text(
      `Grade : ${classe.GRADE_INTITULE || classe.CODGRADE || '-'}   |   Niveau : ${classe.NIVEAU || '-'}   |   Annee : ${annee}   |   Session : Rattrapage S${semBase} (Semestre ${semRattrapage})`,
      0, 185, { align: 'center' }
    );

    if (evaluationColumns.length > 1) {
      const labels = [...new Map(evaluationRows.map((item) => [
        item.IDEC,
        `EC${evaluationRows.findIndex((row) => Number(row.IDEC) === Number(item.IDEC)) + 1}: ${item.INTITULE || `Element ${item.IDEC}`}`
      ])).values()];
      doc.fontSize(7).font('Helvetica').text(`Detail des EC : ${labels.join('   |   ')}`, 40, 198, { width: pageWidth - 80, align: 'center' });
    }

    const detailWidth = evaluationColumns.length ? Math.max(28, Math.floor(280 / evaluationColumns.length)) : 0;
    const headers = ['N', 'Matricule', 'Nom & Prenom', ...evaluationColumns.map((col) => col.label), 'Moyenne\n/100', 'Credit', 'QdP', 'Mention', 'Decision'];
    const colWidths = [24, 65, 135, ...evaluationColumns.map(() => detailWidth), 55, 40, 40, 50, 60];

    if (!rows.length) {
      doc.fontSize(11).font('Helvetica').fillColor('#555');
      doc.text(
        'Aucun etudiant ne figure en session de rattrapage pour cette UE.',
        40, evaluationColumns.length > 1 ? 220 : 215,
        { align: 'center', width: pageWidth - 80 }
      );
    } else {
      const tableRows = [];
      const decisionCounts = {};

      rows.forEach((r, i) => {
        const decision = r.Decision || (r.MOYENNE !== null ? getGradeLocal(Number(r.MOYENNE)) : '-');
        decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;
        const studentNotes = notesByStudent.get(r.MATRICULE) || {};
        tableRows.push([
          (i + 1).toString(),
          r.MATRICULE,
          r.NOM,
          ...evaluationColumns.map((col) => {
            const note = studentNotes[col.idec];
            const value = col.type === 'CC' ? note?.note_cc : col.type === 'TP' ? note?.note_tp : note?.note_sn;
            return value !== null && value !== undefined ? Number(value).toFixed(2) : '-';
          }),
          r.MOYENNE !== null ? Number(r.MOYENNE).toFixed(2) : '-',
          r.CREDIT !== null ? r.CREDIT : '-',
          r.QdP !== null ? Number(r.QdP).toFixed(2) : (r.MOYENNE !== null ? getQdpLocal(Number(r.MOYENNE)).toFixed(2) : '-'),
          r.CODMENTION || (r.MOYENNE !== null ? getMentionLocal(Number(r.MOYENNE)) : '-'),
          decision,
        ]);
      });

      let finalY = drawTable(doc, evaluationColumns.length > 1 ? 212 : 210, headers, tableRows, colWidths, 40);

      finalY += 30;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000');
      doc.text('Statistiques - Session de Rattrapage', 40, finalY);

      const totalRattrapage = rows.length;
      const statLabelsR = Object.keys(decisionCounts);
      const statHeadersR = ['Effectif', ...statLabelsR, ...statLabelsR.map((l) => `%${l}`)];
      const statColWidthsR = [60, ...statLabelsR.map(() => 45), ...statLabelsR.map(() => 45)];
      const statRowR = [
        totalRattrapage.toString(),
        ...statLabelsR.map((l) => decisionCounts[l].toString()),
        ...statLabelsR.map((l) => totalRattrapage ? ((decisionCounts[l] / totalRattrapage) * 100).toFixed(2) : '0.00'),
      ];
      drawTable(doc, finalY + 15, statHeadersR, [statRowR], statColWidthsR, 40);
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
// POST /api/pv/generate-recap
// Body: { matricule, grade }   grade = CODGRADE, ex: 'L' ou 'M'
//
// Source de verite : ulmdpvrecap. La colonne DECISION est deja calculee en
// amont par le jury/le processus de deliberation -- ce controleur ne la
// recalcule jamais, il applique seulement la regle d'agregation de la
// section 10 du schema : un niveau est admis si TOUTES ses lignes
// (= tous les semestres presents pour ce niveau) portent DECISION = ADMIS ;
// le cycle est admis si TOUS ses niveaux le sont.
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
    const fixedWidths = [25, 65, 150, 45];
    const tailHeaders = ['CAP', 'CHOI', '%CAP', 'MGP', 'Decision'];
    const tailWidths = [35, 35, 40, 35, 70];

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
