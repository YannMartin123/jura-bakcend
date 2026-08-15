const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/supabase');

// Utilitaire de conversion (sur 100 vers Grade local)
const getGradeLocal = (score100) => {
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

// FIX: resolution robuste du chemin du logo.
// path.join(__dirname, '../../...') est fragile car il depend exactement de
// l'emplacement du fichier controller. On essaie plusieurs chemins plausibles
// et on logue clairement lesquels ont ete testes si aucun ne fonctionne,
// au lieu d'echouer silencieusement.
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

// Fonction pour tracer un tableau basique avec pdfkit
// FIX: hauteur de ligne dynamique (gere le texte qui wrap sur plusieurs lignes)
// + saut de page calcule AVANT de dessiner la ligne (evite qu'une ligne soit coupee entre 2 pages)
const drawTable = (doc, startY, headers, rows, colWidths, startX = 40) => {
  const headerRowHeight = 20;
  let currentY = startY;

  // Header background
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
    // Calcule la hauteur reelle necessaire pour cette ligne (gere le texte qui wrap)
    const cellHeights = row.map((cell, i) => {
      const text = cell !== null && cell !== undefined ? String(cell) : '-';
      return doc.heightOfString(text, { width: colWidths[i] - 4 });
    });
    const rowHeight = Math.max(20, Math.max(...cellHeights) + 8);

    // Saut de page si necessaire, calcule AVANT de dessiner la ligne
    if (currentY + rowHeight > doc.page.height - 50) {
      doc.addPage();
      currentY = 40;
    }

    currentX = startX;
    doc.rect(startX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight).stroke();

    row.forEach((cell, i) => {
      // Draw vertical line separators
      if (i > 0) {
        doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      }
      doc.text(cell !== null && cell !== undefined ? String(cell) : '-', currentX + 2, currentY + 4, {
        width: colWidths[i] - 4,
        align: i === 1 || i === 2 ? 'left' : 'center'
      });
      currentX += colWidths[i];
    });
    currentY += rowHeight;
  });

  return currentY;
};

exports.generatePV = async (req, res) => {
  const { type, annee_id, classe_id, ue_id, ec_id, etudiant_id } = req.body;

  if (!type) {
    return res.status(400).json({ message: 'Type de PV requis' });
  }

  if (!annee_id) {
    return res.status(400).json({ message: 'Annee academique requise' });
  }

  if (type === 'ec' && (!classe_id || !ue_id || !ec_id)) {
    return res.status(400).json({ message: "Classe, UE et EC sont requis pour generer le PV par EC" });
  }

  if (type === 'ue' && (!classe_id || !ue_id)) {
    return res.status(400).json({ message: "Classe et UE sont requis pour generer le PV par UE" });
  }

  if (type === 'cycle' && (!classe_id || !etudiant_id)) {
    return res.status(400).json({ message: "Classe et etudiant sont requis pour generer le PV par cycle" });
  }

  if (type === 'annuel' || type === 'recap_etudiant') {
    return res.status(501).json({
      message: "Ce type de PV n'est pas encore implemente cote serveur. Utilisez pour l'instant le PV par EC ou par UE."
    });
  }

  try {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: (type === 'ue' || type === 'cycle') ? 'landscape' : 'portrait' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PV_${type}_${Date.now()}.pdf"`);
    doc.pipe(res);

    // --- 1. En-tete bilingue officiel ---
    const pageWidth = doc.page.width;

    doc.fontSize(10).font("Helvetica-Bold");
    doc.text("REPUBLIQUE DU CAMEROUN", 40, 40);
    doc.fontSize(8).font("Helvetica");
    doc.text("Paix - Travail - Patrie", 60, 55);
    doc.fontSize(10).font("Helvetica-Bold");
    doc.text("UNIVERSITE DE YAOUNDE I", 45, 75);
    doc.fontSize(9).font("Helvetica");
    doc.text("FACULTE DES SCIENCES", 50, 90);

    doc.fontSize(10).font("Helvetica-Bold");
    doc.text("REPUBLIC OF CAMEROON", pageWidth - 190, 40);
    doc.fontSize(8).font("Helvetica");
    doc.text("Peace - Work - Fatherland", pageWidth - 175, 55);
    doc.fontSize(10).font("Helvetica-Bold");
    doc.text("UNIVERSITY OF YAOUNDE I", pageWidth - 195, 75);
    doc.fontSize(9).font("Helvetica");
    doc.text("FACULTY OF SCIENCE", pageWidth - 175, 90);

    // --- Logo ---
    try {
      const logoPath = getLogoPath();
      if (logoPath) {
        doc.image(logoPath, pageWidth / 2 - 25, 40, { width: 50, height: 60 });
      }
    } catch (err) {
      console.error("Erreur lors de l'insertion du logo:", err.message);
    }

    // Recuperation des informations de la classe (filiere, grade, specialite, etc.)
    let filiereStr = 'Non defini';
    let specialiteStr = 'Non defini';
    let gradeStr = 'Non defini';
    let niveauStr = '-';
    let nomClasse = '-';
    let semestreStr = 'Non defini';
    let anneeText = annee_id || '-';

    if (classe_id) {
      // Nous utiliserons une requete imbriquee pour recuperer les libelles
      const { data: classeData } = await supabase
        .from('classe')
        .select(`
          nom_classe,
          specialite ( nom, filiere ( nom_filiere ) ),
          grade ( libelle_grade ),
          niveau ( id_niveau )
        `)
        .eq('id_classe', classe_id)
        .single();

      if (classeData) {
        nomClasse = classeData.nom_classe;
        filiereStr = classeData.specialite?.filiere?.nom_filiere || filiereStr;
        specialiteStr = classeData.specialite?.nom || specialiteStr;
        gradeStr = classeData.grade?.libelle_grade || gradeStr;
        niveauStr = classeData.niveau?.id_niveau || niveauStr;
      }
    }

    if (type === 'ec') {
      // ---------------------------------------------------------
      // PV PAR ELEMENT CONSTITUTIF (EC)
      // ---------------------------------------------------------
      doc.fontSize(14).font("Helvetica-Bold");
      doc.text("PROCES VERBAL DE L'ELEMENT CONSTITUTIF", 0, 140, { align: "center" });

      const { data: ec } = await supabase.from('ec').select('*').eq('id_ec', ec_id).single();
      if (!ec) throw new Error("EC introuvable");

      const ecTitle = `${ec.code_ec || ''} - ${ec.intitule_ec || ''}`.toUpperCase();
      doc.fontSize(12).font("Helvetica");
      doc.text(ecTitle, 0, 160, { align: "center" });

      doc.fontSize(10).font("Helvetica");
      doc.text(`Filiere : ${filiereStr}   |   Specialite : ${specialiteStr}`, 0, 180, { align: "center" });
      doc.text(`Grade : ${gradeStr}   |   Annee academique : ${anneeText}`, 0, 195, { align: "center" });

      // Recuperation des notes
      const { data: notes } = await supabase
        .from('note')
        .select(`valeur_cc, valeur_tp, valeur_sn, etudiant ( matricule, nom, prenom )`)
        .eq('ec_id', ec_id)
        .eq('annee_id', annee_id);

      const rows = [];
      let caCount = 0; let cantCount = 0; let ncCount = 0;
      let etudiantsCount = notes ? notes.length : 0;

      if (notes && notes.length > 0) {
        notes.forEach((n, i) => {
          const e = n.etudiant;
          if (!e) return;
          const nomComplet = `${e.nom || ''} ${e.prenom || ''}`.trim();
          const ccv = n.valeur_cc !== null ? Number(n.valeur_cc) : 0;
          const tpv = n.valeur_tp !== null ? Number(n.valeur_tp) : 0;
          const snv = n.valeur_sn !== null ? Number(n.valeur_sn) : 0;

          let total20 = 0;
          if (ec.has_cc && ec.has_tp && ec.has_sn) total20 = ccv + tpv + snv;
          else if (ec.has_cc && ec.has_sn) total20 = ccv + snv;
          else if (ec.has_tp && ec.has_sn) total20 = tpv + snv;
          else if (ec.has_sn) total20 = snv;
          else if (ec.has_cc) total20 = ccv;

          const score100 = (total20 / 20) * 100;
          const grade = getGradeLocal(score100);

          if (['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'].includes(grade)) caCount++;
          else if (['C-', 'D+', 'D'].includes(grade)) cantCount++;
          else ncCount++;

          rows.push([
            (i + 1).toString(),
            e.matricule || '-',
            nomComplet,
            n.valeur_cc !== null ? ccv.toFixed(2) : '-',
            n.valeur_tp !== null ? tpv.toFixed(2) : '-',
            n.valeur_sn !== null ? snv.toFixed(2) : '-',
            ""
          ]);
        });
      }

      const headers = ['N', 'Matricule', 'Nom & Prenom', 'CC', 'TP', 'EE / SN', 'Observations'];
      const colWidths = [30, 80, 180, 40, 40, 50, 95];

      let finalY = drawTable(doc, 220, headers, rows, colWidths, 40);

      // Statistiques EC
      const pCa = etudiantsCount ? ((caCount / etudiantsCount) * 100).toFixed(2) : '0.00';
      const pCant = etudiantsCount ? ((cantCount / etudiantsCount) * 100).toFixed(2) : '0.00';
      const pNc = etudiantsCount ? ((ncCount / etudiantsCount) * 100).toFixed(2) : '0.00';

      doc.moveDown(2);
      finalY += 30;
      doc.fontSize(10).font("Helvetica-Bold").fillColor('#000');
      doc.text("Statistiques de l'Element Constitutif", 40, finalY);

      const statHeaders = ['Filiere', 'Grade', 'Niveau', 'Annee', 'EC', 'Effectif', 'CA', '%CA', 'CANT', '%CANT', 'NC', '%NC'];
      const statColWidths = [60, 40, 40, 50, 60, 40, 30, 35, 40, 40, 30, 35];
      const statRows = [[
        filiereStr.substring(0, 8), gradeStr, niveauStr, anneeText, ec.code_ec || '-',
        etudiantsCount.toString(), caCount.toString(), pCa, cantCount.toString(), pCant, ncCount.toString(), pNc
      ]];

      drawTable(doc, finalY + 15, statHeaders, statRows, statColWidths, 10);

    }
    else if (type === 'ue') {
      // ---------------------------------------------------------
      // PV GLOBAL DE L'UNITE D'ENSEIGNEMENT (UE)
      // ---------------------------------------------------------
      doc.fontSize(14).font("Helvetica-Bold");
      doc.text("PROCES VERBAL GLOBAL DE L'UNITE D'ENSEIGNEMENT", 0, 130, { align: "center" });

      const { data: ue } = await supabase.from('ue').select('*').eq('id_ue', ue_id).single();
      if (!ue) throw new Error("UE introuvable");

      const ueTitle = `${ue.code_ue || ''} - ${ue.intitule_ue || ''}`.toUpperCase();
      doc.fontSize(12).font("Helvetica");
      doc.text(ueTitle, 0, 150, { align: "center" });

      doc.fontSize(10).font("Helvetica");
      doc.text(`Filiere : ${filiereStr}   |   Specialite : ${specialiteStr}`, 0, 170, { align: "center" });
      doc.text(`Grade : ${gradeStr}   |   Annee academique : ${anneeText}`, 0, 185, { align: "center" });

      // Fetch all ECs for this UE
      const { data: ecs } = await supabase.from('ec').select('*').eq('ue_id', ue_id);
      const ecIds = ecs ? ecs.map(e => e.id_ec) : [];
      const totalUeCredits = ecs ? ecs.reduce((sum, ec) => sum + (ec.credits_ec || 0), 0) : 0;

      // Fetch students for class
      const { data: inscriptions } = await supabase
        .from('inscription')
        .select(`etudiant ( id_etudiant, matricule, nom, prenom )`)
        .eq('classe_id', classe_id)
        .eq('annee_id', annee_id)
        .eq('est_validee', true);

      // Fetch all notes for these ECs
      const { data: allNotes } = await supabase
        .from('note')
        .select('*')
        .in('ec_id', ecIds)
        .eq('annee_id', annee_id);

      const headers = ['N', 'Matricule', 'Nom & Prenom'];
      const colWidths = [30, 80, 200];

      if (ecs) {
        ecs.forEach(ec => {
          headers.push(`${ec.code_ec}\n(${ec.credits_ec} cr)`);
          colWidths.push(60);
        });
      }
      headers.push('Total\n(/100)', 'Grade', 'Obs');
      colWidths.push(50, 40, 50);

      const rows = [];
      let caCount = 0; let cantCount = 0; let fCount = 0;

      if (inscriptions && inscriptions.length > 0) {
        inscriptions.forEach((insc, i) => {
          const s = insc.etudiant;
          if (!s) return;
          const nomComplet = `${s.nom || ''} ${s.prenom || ''}`.trim();

          let studentWeightedSum = 0;
          const rowData = [(i + 1).toString(), s.matricule, nomComplet];

          if (ecs) {
            ecs.forEach(ec => {
              const sNotes = (allNotes || []).filter(n => n.etudiant_id === s.id_etudiant && n.ec_id === ec.id_ec);
              let ecScore100 = 0;
              if (sNotes.length > 0) {
                const n = sNotes[0];
                let final20 = 0;
                const ccv = n.valeur_cc !== null ? Number(n.valeur_cc) : 0;
                const tpv = n.valeur_tp !== null ? Number(n.valeur_tp) : 0;
                const snv = n.valeur_sn !== null ? Number(n.valeur_sn) : 0;
                if (ec.has_cc && ec.has_tp && ec.has_sn) final20 = ccv + tpv + snv;
                else if (ec.has_cc && ec.has_sn) final20 = ccv + snv;
                else if (ec.has_tp && ec.has_sn) final20 = tpv + snv;
                else if (ec.has_sn) final20 = snv;
                else if (ec.has_cc) final20 = ccv;
                ecScore100 = (final20 / 20) * 100;
              }
              studentWeightedSum += (ecScore100 * (ec.credits_ec || 0));
              rowData.push(ecScore100.toFixed(2));
            });
          }

          const totalScore100 = totalUeCredits > 0 ? studentWeightedSum / totalUeCredits : 0;
          const grade = getGradeLocal(totalScore100);
          rowData.push(totalScore100.toFixed(2));
          rowData.push(grade);
          rowData.push('OK');

          if (['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'].includes(grade)) caCount++;
          else if (['C-', 'D+', 'D'].includes(grade)) cantCount++;
          else fCount++;

          rows.push(rowData);
        });
      }

      // Landscape startX margin adjusting
      const totalTableWidth = colWidths.reduce((a, b) => a + b, 0);
      const startX = (pageWidth - totalTableWidth) / 2;

      let finalY = drawTable(doc, 210, headers, rows, colWidths, startX);

      // Statistiques UE
      const totalStudents = inscriptions ? inscriptions.length : 0;
      const pCa = totalStudents ? ((caCount / totalStudents) * 100).toFixed(2) : '0.00';
      const pCant = totalStudents ? ((cantCount / totalStudents) * 100).toFixed(2) : '0.00';
      const pF = totalStudents ? ((fCount / totalStudents) * 100).toFixed(2) : '0.00';

      finalY += 30;
      doc.fontSize(10).font("Helvetica-Bold").fillColor('#000');
      doc.text("Statistiques Globales de l'Unite d'Enseignement", startX, finalY);

      const statHeaders = ['Filiere', 'Grade', 'Niveau', 'Annee', 'UE', 'Effectif', 'CA', '%CA', 'CANT', '%CANT', 'NC', '%NC'];
      const statColWidths = [60, 40, 40, 50, 60, 40, 30, 40, 40, 40, 30, 40];
      const statRows = [[
        filiereStr.substring(0, 8), gradeStr, niveauStr, anneeText, ue.code_ue || '-',
        totalStudents.toString(), caCount.toString(), pCa, cantCount.toString(), pCant, fCount.toString(), pF
      ]];

      drawTable(doc, finalY + 15, statHeaders, statRows, statColWidths, startX);
    }
    else if (type === 'cycle') {
      // ---------------------------------------------------------
      // PV PAR CYCLE (LICENCE: L1, L2, L3 | MASTER: M1, M2)
      // ---------------------------------------------------------
      doc.fontSize(14).font("Helvetica-Bold");
      doc.text("PROCES VERBAL PAR CYCLE", 0, 130, { align: "center" });

      // Recuperer les informations de l'etudiant
      const { data: etudiant } = await supabase
        .from('etudiant')
        .select('*')
        .eq('id_etudiant', etudiant_id)
        .single();

      if (!etudiant) throw new Error("Etudiant introuvable");

      const nomComplet = `${etudiant.nom || ''} ${etudiant.prenom || ''}`.trim();
      const matricule = etudiant.matricule || '-';

      doc.fontSize(12).font("Helvetica");
      doc.text(`Etudiant: ${nomComplet} (${matricule})`, 0, 150, { align: "center" });
      doc.fontSize(10).font("Helvetica");
      doc.text(`Filiere : ${filiereStr}   |   Specialite : ${specialiteStr}`, 0, 170, { align: "center" });
      doc.text(`Grade : ${gradeStr}   |   Annee academique : ${anneeText}`, 0, 185, { align: "center" });

      // Determiner le cycle base sur le niveau
      const niveauLower = (niveauStr || '').toLowerCase();
      let cycle = '';
      let niveauxCycle = [];

      if (['l1', 'l2', 'l3'].includes(niveauLower)) {
        cycle = 'LICENCE';
        niveauxCycle = ['L1', 'L2', 'L3'];
      } else if (['m1', 'm2'].includes(niveauLower)) {
        cycle = 'MASTER';
        niveauxCycle = ['M1', 'M2'];
      } else {
        throw new Error("Niveau non reconnu pour le tirage par cycle. Niveaux supportes: L1, L2, L3, M1, M2");
      }

      doc.fontSize(12).font("Helvetica-Bold");
      doc.text(`CYCLE: ${cycle}`, 0, 210, { align: "center" });

      // Recuperer toutes les classes du meme cycle pour la filiere/specialite
      const { data: classesCycle } = await supabase
        .from('classe')
        .select(`
          id_classe,
          nom_classe,
          niveau ( id_niveau ),
          specialite ( nom, filiere ( nom_filiere ) )
        `)
        .in('niveau.id_niveau', niveauxCycle);

      if (!classesCycle || classesCycle.length === 0) {
        throw new Error("Aucune classe trouvee pour ce cycle");
      }

      const classeIds = classesCycle.map(c => c.id_classe);

      // Recuperer toutes les inscriptions de l'etudiant dans ces classes
      const { data: inscriptions } = await supabase
        .from('inscription')
        .select(`
          classe_id,
          classe ( nom_classe, niveau ( id_niveau ) )
        `)
        .eq('etudiant_id', etudiant_id)
        .in('classe_id', classeIds)
        .eq('annee_id', annee_id);

      if (!inscriptions || inscriptions.length === 0) {
        throw new Error("Aucune inscription trouvee pour cet etudiant dans ce cycle");
      }

      // Organiser les donnees par niveau
      const notesParNiveau = {};
      niveauxCycle.forEach(n => notesParNiveau[n] = []);

      // Pour chaque inscription, recuperer les UEs et les notes
      for (const insc of inscriptions) {
        const niveau = insc.classe?.niveau?.id_niveau?.toUpperCase() || '';
        if (!niveauxCycle.includes(niveau)) continue;

        // Recuperer les UEs pour cette classe
        const { data: ues } = await supabase
          .from('ue')
          .select('id_ue, code_ue, intitule_ue, credits_ue')
          .eq('classe_id', insc.classe_id);

        if (!ues || ues.length === 0) continue;

        // Recuperer les ECs pour chaque UE
        for (const ue of ues) {
          const { data: ecs } = await supabase
            .from('ec')
            .select('id_ec, code_ec, intitule_ec, credits_ec, has_cc, has_tp, has_sn')
            .eq('ue_id', ue.id_ue);

          if (!ecs || ecs.length === 0) continue;

          const ecIds = ecs.map(e => e.id_ec);

          // Recuperer les notes de l'etudiant pour ces ECs
          const { data: notes } = await supabase
            .from('note')
            .select('*')
            .in('ec_id', ecIds)
            .eq('etudiant_id', etudiant_id)
            .eq('annee_id', annee_id);

          if (!notes || notes.length === 0) continue;

          // Calculer la moyenne pour chaque EC
          ecs.forEach(ec => {
            const ecNotes = notes.filter(n => n.ec_id === ec.id_ec);
            if (ecNotes.length > 0) {
              const n = ecNotes[0];
              const ccv = n.valeur_cc !== null ? Number(n.valeur_cc) : 0;
              const tpv = n.valeur_tp !== null ? Number(n.valeur_tp) : 0;
              const snv = n.valeur_sn !== null ? Number(n.valeur_sn) : 0;

              let final20 = 0;
              if (ec.has_cc && ec.has_tp && ec.has_sn) final20 = ccv + tpv + snv;
              else if (ec.has_cc && ec.has_sn) final20 = ccv + snv;
              else if (ec.has_tp && ec.has_sn) final20 = tpv + snv;
              else if (ec.has_sn) final20 = snv;
              else if (ec.has_cc) final20 = ccv;

              const ecScore100 = (final20 / 20) * 100;
              const ecScore4 = (final20 / 20) * 4; // Convertir en echelle /4.0

              notesParNiveau[niveau].push({
                ue: ue.code_ue || '',
                ue_intitule: ue.intitule_ue || '',
                ec: ec.code_ec || '',
                ec_intitule: ec.intitule_ec || '',
                credits: ec.credits_ec || 0,
                note: ecScore4, // Stocker en /4.0
                note20: final20
              });
            }
          });
        }
      }

      // Calculer les MGP par niveau
      const mgpParNiveau = {};
      let cycleAdmis = true;

      for (const niveau of niveauxCycle) {
        const notes = notesParNiveau[niveau];
        if (notes.length === 0) {
          mgpParNiveau[niveau] = null;
          cycleAdmis = false;
          continue;
        }

        // Calculer la moyenne ponderee du niveau (echelle /4.0)
        let totalCredits = 0;
        let weightedSum = 0;

        notes.forEach(note => {
          weightedSum += note.note * note.credits;
          totalCredits += note.credits;
        });

        const mgp = totalCredits > 0 ? weightedSum / totalCredits : 0;
        mgpParNiveau[niveau] = mgp;

        // Verifier si MGP > 2.0 selon le systeme academique
        // Note: null est different de 0 - si MGP est null, l'etudiant n'est pas admis
        if (mgp === null || mgp <= 2.0) {
          cycleAdmis = false;
        }
      }

      // Decision finale
      const decision = cycleAdmis ? 'ADMIS' : 'AJOURNE';

      // Afficher les resultats par niveau
      let currentY = 240;
      doc.fontSize(11).font("Helvetica-Bold");
      doc.text("RESULTATS PAR NIVEAU", 40, currentY);
      currentY += 20;

      for (const niveau of niveauxCycle) {
        const mgp = mgpParNiveau[niveau];
        const observation = mgp !== null && mgp > 2.0 ? 'VALIDE' : 'NON VALIDE (MGP <= 2.0)';

        doc.fontSize(10).font("Helvetica-Bold");
        doc.text(`NIVEAU ${niveau}`, 40, currentY);
        currentY += 15;

        doc.fontSize(9).font("Helvetica");
        doc.text(`MGP: ${mgp !== null ? mgp.toFixed(2) + '/4.0' : 'N/A (null)'}`, 50, currentY);
        currentY += 12;
        doc.text(`Observation: ${observation}`, 50, currentY);
        currentY += 20;

        // Detail des UE/EC pour ce niveau
        const notes = notesParNiveau[niveau];
        if (notes && notes.length > 0) {
          const detailHeaders = ['UE', 'EC', 'Credits', 'Note/4.0'];
          const detailColWidths = [50, 80, 40, 50];
          const detailRows = notes.map(n => [
            n.ue,
            n.ec,
            n.credits.toString(),
            n.note.toFixed(2) // Deja en /4.0
          ]);

          currentY = drawTable(doc, currentY, detailHeaders, detailRows, detailColWidths, 50);
          currentY += 15;
        }
      }

      // Decision finale
      currentY += 10;
      doc.fontSize(12).font("Helvetica-Bold");
      const decisionColor = decision === 'ADMIS' ? '#2e7d32' : '#c62828';
      doc.fillColor(decisionColor);
      doc.text(`DECISION FINALE: ${decision}`, 40, currentY);
      doc.fillColor('#000000');

      // Ajouter une note explicative
      currentY += 20;
      doc.fontSize(8).font("Helvetica");
      doc.text("* Note: Un etudiant est ADMIS si sa MGP (Moyenne Generale Ponderee) de chaque niveau du cycle est > 2.0/4.0. null est different de 0.", 40, currentY, { width: 500 });
    }
    else {
      doc.text("En cours de construction pour ce type (Annuel / Recap)");
    }

    doc.end();

  } catch (err) {
    console.error('Erreur lors de la generation du PV PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la generation du PV PDF', error: err.message });
    }
  }
};


// --- generateRecap ---------------------------------------------------------
// POST /api/pv/generate-recap
// Body: { matricule: string, cycle: 'LICENCE'|'MASTER' }
// Returns: application/pdf stream
// ----------------------------------------------------------------------------
const n = (v) => Number(v ?? 0);

const computeScore4 = (ec, note) => {
  const ccv = note.valeur_cc !== null ? n(note.valeur_cc) : 0;
  const tpv = note.valeur_tp !== null ? n(note.valeur_tp) : 0;
  const snv = note.valeur_sn !== null ? n(note.valeur_sn) : 0;
  let total20 = 0;
  if (ec.has_cc && ec.has_tp && ec.has_sn) total20 = ccv + tpv + snv;
  else if (ec.has_cc && ec.has_sn) total20 = ccv + snv;
  else if (ec.has_tp && ec.has_sn) total20 = tpv + snv;
  else if (ec.has_sn) total20 = snv;
  else if (ec.has_cc) total20 = ccv;
  return Math.min(4, Math.max(0, total20 / 5));
};

const cote4 = (score4) => {
  const s = score4 * 25;
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
  return 'F';
};

exports.generateRecap = async (req, res) => {
  try {
    const { matricule, cycle } = req.body;
    if (!matricule || !cycle) {
      return res.status(400).json({ message: 'Matricule et cycle sont requis.' });
    }

    // -- 0. Etudiant ---------------------------------------------------------
    const { data: student, error: stuErr } = await supabase
      .from('etudiant')
      .select('id_etudiant, matricule, nom, prenom, date_naissance, lieu_naissance')
      .eq('matricule', matricule.trim())
      .maybeSingle();

    if (stuErr) throw stuErr;
    if (!student) return res.status(404).json({ message: 'Etudiant non trouve.' });

    // -- 1. Inscriptions validees ---------------------------------------------
    const { data: inscriptions, error: insErr } = await supabase
      .from('inscription')
      .select('classe_id, annee_id, classe(id_classe, nom_classe, niveau(id_niveau, libelle_niveau, cycle), specialite(nom, filiere(nom_filiere)))')
      .eq('etudiant_id', student.id_etudiant)
      .eq('est_validee', true);

    if (insErr) throw insErr;

    const cycleInscriptions = (inscriptions || []).filter(
      (item) => String(item.classe?.niveau?.cycle || '').toUpperCase() === cycle.toUpperCase()
    );
    if (!cycleInscriptions.length) throw new Error(`Aucune inscription validee dans le cycle ${cycle}.`);

    const niveauMap = new Map();
    cycleInscriptions.forEach((item) => {
      const key = item.classe?.niveau?.id_niveau ?? item.classe_id;
      if (!niveauMap.has(key)) niveauMap.set(key, item.classe);
    });
    const niveaux = [...niveauMap.values()].sort(
      (a, b) => (a.niveau?.id_niveau ?? 0) - (b.niveau?.id_niveau ?? 0)
    );
    const classeIds = niveaux.map((c) => c.id_classe);

    // -- 2. Programme (UE/EC/Semestre) ----------------------------------------
    const { data: programmes, error: progErr } = await supabase
      .from('programme')
      .select('classe_id, annee_id, semestre_id, ue(id_ue, code_ue, intitule_ue, ec(id_ec, code_ec, intitule_ec, credits_ec, has_cc, has_tp, has_sn))')
      .in('classe_id', classeIds);

    if (progErr) throw progErr;

    const uesByClasse = new Map();
    (programmes || []).forEach((p) => {
      if (!uesByClasse.has(p.classe_id)) uesByClasse.set(p.classe_id, new Map());
      const map = uesByClasse.get(p.classe_id);
      const ue = Array.isArray(p.ue) ? p.ue[0] : p.ue;
      if (!ue) return;
      if (!map.has(ue.id_ue)) map.set(ue.id_ue, { ue, sem: p.semestre_id });
    });

    const allEcIds = [...new Set([...uesByClasse.values()].flatMap(map =>
      [...map.values()].flatMap(({ ue }) => {
        const ecs = Array.isArray(ue.ec) ? ue.ec : (ue.ec ? [ue.ec] : []);
        return ecs.map((ec) => ec.id_ec);
      })
    ))];

    // -- 3. Notes -------------------------------------------------------------
    const { data: notes, error: noteErr } = allEcIds.length
      ? await supabase.from('note')
          .select('ec_id, annee_id, valeur_cc, valeur_tp, valeur_sn')
          .eq('etudiant_id', student.id_etudiant)
          .in('ec_id', allEcIds)
      : { data: [], error: null };

    if (noteErr) throw noteErr;

    const notesByEc = new Map();
    (notes || []).forEach((note) => {
      if (!notesByEc.has(note.ec_id)) notesByEc.set(note.ec_id, []);
      notesByEc.get(note.ec_id).push(note);
    });

    // -- 4. Calcul par niveau -------------------------------------------------
    const levels = niveaux.map((classe) => {
      const ueEntries = [...(uesByClasse.get(classe.id_classe)?.values() || [])];
      const rows = ueEntries.map(({ ue, sem }) => {
        const ecs = Array.isArray(ue.ec) ? ue.ec : (ue.ec ? [ue.ec] : []);
        const results = ecs.map((ec) => {
          const attempts = notesByEc.get(ec.id_ec) || [];
          let best = null;
          for (const note of attempts) {
            const score4 = computeScore4(ec, note);
            if (!best || score4 > best.score4) best = { score4, annee: note.annee_id };
          }
          return { ec, score4: best?.score4 ?? 0, annee: best?.annee ?? '-' };
        });
        const credits = results.reduce((sum, r) => sum + n(r.ec.credits_ec), 0);
        const score4 = credits
          ? results.reduce((sum, r) => sum + r.score4 * n(r.ec.credits_ec), 0) / credits
          : 0;
        return {
          code: ue.code_ue,
          intitule: ue.intitule_ue,
          credits,
          sem: sem ?? '-',
          score4,
          ecResults: results.map((r) => ({
            code: r.ec.code_ec,
            intitule: r.ec.intitule_ec,
            credits: n(r.ec.credits_ec),
            note100: r.score4 * 25,
            cote: cote4(r.score4),
            annee: r.annee,
          })),
        };
      });
      const totalCredits = rows.reduce((s, r) => s + r.credits, 0);
      const validatedCredits = rows.filter(r => r.score4 > 2).reduce((s, r) => s + r.credits, 0);
      const average = totalCredits
        ? rows.reduce((s, r) => s + r.score4 * r.credits, 0) / totalCredits : 0;
      return { classe, rows, totalCredits, validatedCredits, average, hasResults: rows.length > 0 };
    }).filter(level => level.hasResults);

    if (!levels.length) throw new Error("Aucune donnee d'evaluation trouvee pour ce cycle.");

    const creditsCycle = levels.reduce((s, l) => s + l.totalCredits, 0);
    const finalAverage = creditsCycle
      ? levels.reduce((s, l) => s + l.average * l.totalCredits, 0) / creditsCycle : 0;
    const admitted = levels.every(l => l.average > 2);

    // -- 5. Template config ----------------------------------------------------
    const { data: tmplData } = await supabase
      .from('document_templates')
      .select('config')
      .eq('type', 'PV_RECAP')
      .maybeSingle();

    const tmpl = tmplData?.config || {};
    const hl1 = tmpl.headerLeftL1 || 'UNIVERSITE DE YAOUNDE I';
    const hr1 = tmpl.headerRightL1 || 'UNIVERSITE DE YAOUNDE I';
    const hl2 = tmpl.headerLeftL2 || 'FACULTE DES SCIENCES';
    const hr2 = tmpl.headerRightL2 || 'FACULTY OF SCIENCE';
    const hl3 = tmpl.headerLeftL3 || 'BP/P.O Box 812 Yaounde-CAMEROUN /';
    const hr3 = tmpl.headerRightL3 || 'BP/P.O Box 812 Yaounde-CAMEROUN /';
    const hl4 = tmpl.headerLeftL4 || 'Tel: 222 234 496 / Email: diplome@facsciences.uy1.cm';
    const hr4 = tmpl.headerRightL4 || 'Tel: 222 234 496 / Email: diplome@facsciences.uy1.cm';
    const footerCity = tmpl.footerCity || 'Yaounde';
    const footerSignLeft = tmpl.footerSignLeft || 'Le President de Jury';
    const footerSignRight = tmpl.footerSignRight || 'Les Membres';

    // -- 6. PDF Generation with PDFKit -----------------------------------------
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename=PV_Cycle_${cycle}_${student.matricule}.pdf`);
    doc.pipe(res);

    const W = 595.28; // A4 width in pt
    const ML = 32;
    const MR = 32;

    // Header
    doc.font('Helvetica-Bold').fontSize(10).fillColor('black')
      .text(hl1, ML, 30)
      .text(hr1, ML, 30, { align: 'right', width: W - ML - MR });

    doc.fontSize(9)
      .text(hl2, ML, 44)
      .text(hr2, ML, 44, { align: 'right', width: W - ML - MR });

    doc.font('Helvetica').fontSize(7)
      .text(hl3, ML, 56)
      .text(hr3, ML, 56, { align: 'right', width: W - ML - MR })
      .text(hl4, ML, 66)
      .text(hr4, ML, 66, { align: 'right', width: W - ML - MR });

    // --- Logo (FIX: manquait completement dans generateRecap) ---
    try {
      const logoPath = getLogoPath();
      if (logoPath) {
        doc.image(logoPath, W / 2 - 22, 28, { width: 44, height: 52 });
      }
    } catch (err) {
      console.error("Erreur lors de l'insertion du logo:", err.message);
    }

    const filiere = levels[0]?.classe?.specialite?.filiere?.nom_filiere || '-';
    const specialite = levels[0]?.classe?.specialite?.nom || '-';

    doc.font('Helvetica-Bold').fontSize(11)
      .text(`${cycle === 'MASTER' ? 'MASTER' : 'LICENCE'} DE : ${filiere.toUpperCase()}`,
            ML, 88, { align: 'center', width: W - ML - MR });
    doc.fontSize(9)
      .text(`SPECIALITE : ${specialite.toUpperCase()}`,
            ML, 102, { align: 'center', width: W - ML - MR });
    doc.fontSize(14)
      .text('PROCES VERBAL RECAPITULATIF',
            ML, 120, { align: 'center', width: W - ML - MR });

    doc.moveTo(ML, 140).lineTo(W - MR, 140).lineWidth(0.5).stroke();

    // Student info box
    doc.font('Helvetica').fontSize(9).fillColor('black');
    const dob = student.date_naissance ? new Date(student.date_naissance).toLocaleDateString('fr-FR') : '-';
    doc.text(`Matricule : ${student.matricule}`, ML, 148);
    doc.text(`Nom & Prenom : ${student.nom || ''} ${student.prenom || ''}`, ML + 160, 148);
    doc.text(`Ne(e) le : ${dob}  a  ${student.lieu_naissance || '-'}`, ML, 160);

    doc.moveTo(ML, 173).lineTo(W - MR, 173).lineWidth(0.3).stroke();

    let y = 183;

    // FIX: mesure la hauteur reelle d'une ligne AVANT de la dessiner
    // (permet de decider un saut de page sans jamais couper une ligne en deux)
    const measureRowHeight = (cols, widths, fontSize = 7) => {
      doc.fontSize(fontSize);
      const heights = cols.map((col, i) => doc.heightOfString(String(col), { width: widths[i] }));
      return Math.max(11, Math.max(...heights) + 3);
    };

    // FIX: hauteur de ligne dynamique + retourne la hauteur utilisee pour que
    // l'appelant incremente "y" correctement (fini le chevauchement de texte)
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
    const HDRS = ['UE / EC', 'Intitule', 'Credits', 'Note/100', 'Cote', 'Sem.', 'Annee'];

    // Table header
    const headerHeight = drawTableRow(HDRS, COL_X, COL_W, y, true, true);
    y += headerHeight + 4;
    doc.moveTo(ML, y).lineTo(W - MR, y).lineWidth(0.3).stroke();
    y += 3;

    for (const level of levels) {
      // Niveau header (FIX: bullet "." remplace par "-" pour eviter les caracteres corrompus)
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1a237e')
        .text(`Niveau : ${level.classe?.niveau?.libelle_niveau || level.classe.nom_classe}  -  MGP: ${level.average.toFixed(2)}/4.0  -  Credits: ${level.validatedCredits}/${level.totalCredits}`,
              ML, y, { width: W - ML - MR });
      y += 13;
      doc.fillColor('black');

      for (const ueRow of level.rows) {
        const ueCols = [ueRow.code, ueRow.intitule, ueRow.credits.toString(),
          (ueRow.score4 * 25).toFixed(2), cote4(ueRow.score4), ueRow.sem, ''];

        // Saut de page calcule AVANT de dessiner la ligne UE
        const ueHPreview = measureRowHeight(ueCols, COL_W);
        if (y + ueHPreview > 760) {
          doc.addPage();
          y = 40;
        }

        const ueH = drawTableRow(ueCols, COL_X, COL_W, y, true, false);
        y += ueH;

        // EC rows
        for (const ec of ueRow.ecResults) {
          const ecCols = [`  ${ec.code}`, ec.intitule, ec.credits.toString(),
            ec.note100.toFixed(2), ec.cote, ueRow.sem, ec.annee];

          // Saut de page calcule AVANT de dessiner la ligne EC
          const ecHPreview = measureRowHeight(ecCols, COL_W);
          if (y + ecHPreview > 760) {
            doc.addPage();
            y = 40;
          }

          const ecH = drawTableRow(ecCols, COL_X, COL_W, y, false, false);
          y += ecH;
        }
        doc.moveTo(ML, y).lineTo(W - MR, y).lineWidth(0.2).strokeColor('#cccccc').stroke();
        doc.strokeColor('black');
        y += 4;
      }
      y += 6;
    }

    // Decision box (FIX: bullet "." remplace par "-")
    y += 10;
    const decisionColor = admitted ? '#1b5e20' : '#b71c1c';
    doc.rect(ML, y, W - ML - MR, 22).lineWidth(1).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(decisionColor)
      .text(`DECISION : ${admitted ? 'ADMIS(E)' : 'AJOURN(E)'}  -  MGP Cycle : ${finalAverage.toFixed(2)}/4.0  -  Credits : ${levels.reduce((s, l) => s + l.validatedCredits, 0)}/${creditsCycle}`,
            ML + 5, y + 5, { width: W - ML - MR - 10, align: 'center' });
    doc.fillColor('black');

    y += 36;

    // Footer
    const pageRange = doc.bufferedPageRange();
    const totalPages = pageRange.count;
    for (let pg = 0; pg < totalPages; pg++) {
      doc.switchToPage(pageRange.start + pg);
      const H = 841.89;
      doc.moveTo(ML, H - 26).lineTo(W - MR, H - 26).lineWidth(0.4).stroke();
      doc.font('Helvetica').fontSize(7)
        .text(`PV cycle ${cycle} - ${student.matricule}`, ML, H - 14)
        .text(`Page ${pg + 1} / ${totalPages}`, ML, H - 14, { align: 'right', width: W - ML - MR });
    }

    // Signatures on last page
    doc.switchToPage(pageRange.start + totalPages - 1);
    const sigY = 780;
    doc.font('Helvetica').fontSize(8)
      .text(`Fait à ${footerCity} le ..........................................`,
            ML, sigY - 20, { align: 'center', width: W - ML - MR });
    doc.text(footerSignLeft, ML + 30, sigY);
    doc.text(footerSignRight, ML, sigY, { align: 'right', width: W - ML - MR - 30 });

    doc.end();

  } catch (err) {
    console.error('Erreur generateRecap:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la generation du PV recap', error: err.message });
    }
  }
};