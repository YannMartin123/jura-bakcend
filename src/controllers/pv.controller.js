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

// Fonction pour tracer un tableau basique avec pdfkit
const drawTable = (doc, startY, headers, rows, colWidths, startX = 40) => {
  const rowHeight = 20;
  let currentY = startY;

  // Header background
  doc.rect(startX, currentY, colWidths.reduce((a,b)=>a+b,0), rowHeight).fillAndStroke('#2d3e50', '#2d3e50');
  
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
  let currentX = startX;
  headers.forEach((h, i) => {
    doc.text(h, currentX, currentY + 6, { width: colWidths[i], align: 'center' });
    currentX += colWidths[i];
  });
  
  currentY += rowHeight;
  doc.fillColor('#000000').font('Helvetica').fontSize(8);

  rows.forEach((row) => {
    // Page break if needed
    if (currentY > doc.page.height - 50) {
      doc.addPage();
      currentY = 40;
    }
    
    currentX = startX;
    doc.rect(startX, currentY, colWidths.reduce((a,b)=>a+b,0), rowHeight).stroke();
    
    row.forEach((cell, i) => {
      // Draw vertical line separators
      if (i > 0) {
        doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      }
      doc.text(cell !== null && cell !== undefined ? String(cell) : '-', currentX + 2, currentY + 6, { 
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

    // --- 1. En-tête bilingue officiel ---
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
      const logoPath = path.join(__dirname, '../../ressources/images/uy1_logo.png');
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, pageWidth / 2 - 25, 40, { width: 50, height: 60 });
      }
    } catch (err) {
      console.warn("Logo non trouvé, ignoré.");
    }

    // Récupération des informations de la classe (filiere, grade, specialite, etc.)
    let filiereStr = 'Non défini';
    let specialiteStr = 'Non défini';
    let gradeStr = 'Non défini';
    let niveauStr = '-';
    let nomClasse = '-';
    let semestreStr = 'Non défini';
    let anneeText = annee_id || '-';

    if (classe_id) {
      // Nous utiliserons une requête imbriquée pour récupérer les libellés
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
      doc.text(`Filière : ${filiereStr}   |   Spécialité : ${specialiteStr}`, 0, 180, { align: "center" });
      doc.text(`Grade : ${gradeStr}   |   Année académique : ${anneeText}`, 0, 195, { align: "center" });

      // Récupération des notes
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

      const headers = ['N°', 'Matricule', 'Nom & Prénom', 'CC', 'TP', 'EE / SN', 'Observations'];
      const colWidths = [30, 80, 180, 40, 40, 50, 95];
      
      let finalY = drawTable(doc, 220, headers, rows, colWidths, 40);

      // Statistiques EC
      const pCa = etudiantsCount ? ((caCount / etudiantsCount) * 100).toFixed(2) : '0.00';
      const pCant = etudiantsCount ? ((cantCount / etudiantsCount) * 100).toFixed(2) : '0.00';
      const pNc = etudiantsCount ? ((ncCount / etudiantsCount) * 100).toFixed(2) : '0.00';

      doc.moveDown(2);
      finalY += 30;
      doc.fontSize(10).font("Helvetica-Bold").fillColor('#000');
      doc.text("Statistiques de l'Élément Constitutif", 40, finalY);
      
      const statHeaders = ['Filière', 'Grade', 'Niveau', 'Année', 'EC', 'Effectif', 'CA', '%CA', 'CANT', '%CANT', 'NC', '%NC'];
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
      doc.text(`Filière : ${filiereStr}   |   Spécialité : ${specialiteStr}`, 0, 170, { align: "center" });
      doc.text(`Grade : ${gradeStr}   |   Année académique : ${anneeText}`, 0, 185, { align: "center" });

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

      const headers = ['N°', 'Matricule', 'Nom & Prénom'];
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
          const rowData = [(i+1).toString(), s.matricule, nomComplet];

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
      const totalTableWidth = colWidths.reduce((a,b)=>a+b,0);
      const startX = (pageWidth - totalTableWidth) / 2;

      let finalY = drawTable(doc, 210, headers, rows, colWidths, startX);

      // Statistiques UE
      const totalStudents = inscriptions ? inscriptions.length : 0;
      const pCa = totalStudents ? ((caCount / totalStudents) * 100).toFixed(2) : '0.00';
      const pCant = totalStudents ? ((cantCount / totalStudents) * 100).toFixed(2) : '0.00';
      const pF = totalStudents ? ((fCount / totalStudents) * 100).toFixed(2) : '0.00';

      finalY += 30;
      doc.fontSize(10).font("Helvetica-Bold").fillColor('#000');
      doc.text("Statistiques Globales de l'Unité d'Enseignement", startX, finalY);

      const statHeaders = ['Filière', 'Grade', 'Niveau', 'Année', 'UE', 'Effectif', 'CA', '%CA', 'CANT', '%CANT', 'NC', '%NC'];
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

      // Récupérer les informations de l'étudiant
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
      doc.text(`Filière : ${filiereStr}   |   Spécialité : ${specialiteStr}`, 0, 170, { align: "center" });
      doc.text(`Grade : ${gradeStr}   |   Année académique : ${anneeText}`, 0, 185, { align: "center" });

      // Déterminer le cycle basé sur le niveau
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
        throw new Error("Niveau non reconnu pour le tirage par cycle. Niveaux supportés: L1, L2, L3, M1, M2");
      }

      doc.fontSize(12).font("Helvetica-Bold");
      doc.text(`CYCLE: ${cycle}`, 0, 210, { align: "center" });

      // Récupérer toutes les classes du même cycle pour la filière/spécialité
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
        throw new Error("Aucune classe trouvée pour ce cycle");
      }

      const classeIds = classesCycle.map(c => c.id_classe);

      // Récupérer toutes les inscriptions de l'étudiant dans ces classes
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
        throw new Error("Aucune inscription trouvée pour cet étudiant dans ce cycle");
      }

      // Organiser les données par niveau
      const notesParNiveau = {};
      niveauxCycle.forEach(n => notesParNiveau[n] = []);

      // Pour chaque inscription, récupérer les UEs et les notes
      for (const insc of inscriptions) {
        const niveau = insc.classe?.niveau?.id_niveau?.toUpperCase() || '';
        if (!niveauxCycle.includes(niveau)) continue;

        // Récupérer les UEs pour cette classe
        const { data: ues } = await supabase
          .from('ue')
          .select('id_ue, code_ue, intitule_ue, credits_ue')
          .eq('classe_id', insc.classe_id);

        if (!ues || ues.length === 0) continue;

        // Récupérer les ECs pour chaque UE
        for (const ue of ues) {
          const { data: ecs } = await supabase
            .from('ec')
            .select('id_ec, code_ec, intitule_ec, credits_ec, has_cc, has_tp, has_sn')
            .eq('ue_id', ue.id_ue);

          if (!ecs || ecs.length === 0) continue;

          const ecIds = ecs.map(e => e.id_ec);

          // Récupérer les notes de l'étudiant pour ces ECs
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
              const ecScore4 = (final20 / 20) * 4; // Convertir en échelle /4.0
              
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

        // Calculer la moyenne pondérée du niveau (échelle /4.0)
        let totalCredits = 0;
        let weightedSum = 0;

        notes.forEach(note => {
          weightedSum += note.note * note.credits;
          totalCredits += note.credits;
        });

        const mgp = totalCredits > 0 ? weightedSum / totalCredits : 0;
        mgpParNiveau[niveau] = mgp;

        // Vérifier si MGP > 2.0 selon le système académique
        // Note: null est différent de 0 - si MGP est null, l'étudiant n'est pas admis
        if (mgp === null || mgp <= 2.0) {
          cycleAdmis = false;
        }
      }

      // Décision finale
      const decision = cycleAdmis ? 'ADMIS' : 'AJOURNE';

      // Afficher les résultats par niveau
      let currentY = 240;
      doc.fontSize(11).font("Helvetica-Bold");
      doc.text("RESULTATS PAR NIVEAU", 40, currentY);
      currentY += 20;

      for (const niveau of niveauxCycle) {
        const mgp = mgpParNiveau[niveau];
        const observation = mgp !== null && mgp > 2.0 ? 'VALIDE' : 'NON VALIDÉ (MGP <= 2.0)';

        doc.fontSize(10).font("Helvetica-Bold");
        doc.text(`NIVEAU ${niveau}`, 40, currentY);
        currentY += 15;

        doc.fontSize(9).font("Helvetica");
        doc.text(`MGP: ${mgp !== null ? mgp.toFixed(2) + '/4.0' : 'N/A (null)'}`, 50, currentY);
        currentY += 12;
        doc.text(`Observation: ${observation}`, 50, currentY);
        currentY += 20;

        // Détail des UE/EC pour ce niveau
        const notes = notesParNiveau[niveau];
        if (notes && notes.length > 0) {
          const detailHeaders = ['UE', 'EC', 'Crédits', 'Note/4.0'];
          const detailColWidths = [50, 80, 40, 50];
          const detailRows = notes.map(n => [
            n.ue,
            n.ec,
            n.credits.toString(),
            n.note.toFixed(2) // Déjà en /4.0
          ]);

          currentY = drawTable(doc, currentY, detailHeaders, detailRows, detailColWidths, 50);
          currentY += 15;
        }
      }

      // Décision finale
      currentY += 10;
      doc.fontSize(12).font("Helvetica-Bold");
      const decisionColor = decision === 'ADMIS' ? '#2e7d32' : '#c62828';
      doc.fillColor(decisionColor);
      doc.text(`DÉCISION FINALE: ${decision}`, 40, currentY);
      doc.fillColor('#000000');

      // Ajouter une note explicative
      currentY += 20;
      doc.fontSize(8).font("Helvetica");
      doc.text("* Note: Un étudiant est ADMIS si sa MGP (Moyenne Générale Pondérée) de chaque niveau du cycle est > 2.0/4.0. null est différent de 0.", 40, currentY, { width: 500 });
    }
    else {
      doc.text("En cours de construction pour ce type (Annuel / Recap)");
    }

    doc.end();

  } catch (err) {
    console.error('Erreur lors de la génération du PV PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Erreur lors de la génération du PV PDF', error: err.message });
    }
  }
};
