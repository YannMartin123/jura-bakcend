const importService = require('../services/import.service');
const { supabase } = require('../config/supabase');
const fs = require('fs');
const xlsx = require('xlsx');
const { randomUUID } = require('crypto');

exports.validate = async (req, res) => {
  const file = req.file;
  const { ecId, isAnonymous } = req.body;

  if (!file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }

  try {
    let rawData;
    const extension = file.originalname.split('.').pop().toLowerCase();

    if (['xlsx', 'xls', 'csv'].includes(extension)) {
      rawData = await importService.parseExcel(file.path);
    } else if (extension === 'pdf') {
      rawData = await importService.parsePDF(file.path);
    } else {
      return res.status(400).json({ message: 'Unsupported file format.' });
    }

    const { validData, errors } = await importService.validateImport(rawData, ecId, isAnonymous === 'true');

    // Clean up uploaded file
    fs.unlinkSync(file.path);

    res.status(200).json({
      message: 'Validation complete',
      data: validData,
      errors: errors,
      stats: {
        total: rawData.length,
        valid: validData.length,
        invalid: errors.length
      }
    });
  } catch (err) {
    console.error('Import validation error:', err);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ message: 'Error processing file.', detail: err.message });
  }
};

exports.confirm = async (req, res) => {
  const { data, ecId, sessionId, isAnonymous } = req.body;

  if (!data || !ecId || !sessionId) {
    return res.status(400).json({ message: 'Missing required data (data, ecId, sessionId).' });
  }

  // Un UUID unique identifiant ce lot d'import
  const importBatchId = randomUUID();

  try {
    const results = [];
    const errors = [];

    // Récupérer l'annee_id depuis la session
    const { data: sessionData, error: sessionErr } = await supabase
      .from('session_correction')
      .select('annee_academique')
      .eq('id_session', sessionId)
      .single();

    const anneeId = sessionData?.annee_academique || null;

    // Process in batches or one by one for better error tracking
    for (const item of data) {
      try {
        let studentId = null;
        const itemProblems = [];

        if (isAnonymous) {
          // Map anonymat code to studentId
          const { data: mapping, error: mapErr } = await supabase
            .from('anonymiser')
            .select('etudiant_id')
            .eq('code', item.anonymat)
            .eq('ec_id', ecId)
            .single();

          if (mapErr || !mapping) {
            itemProblems.push(`Code anonymat ${item.anonymat} non trouvé pour cette EC.`);
          } else {
            studentId = mapping.etudiant_id;
          }
        } else {
          // Find student by matricule
          const { data: student, error: stuErr } = await supabase
            .from('etudiant')
            .select('id')
            .eq('matricule', item.matricule)
            .single();

          if (stuErr || !student) {
            itemProblems.push(`Matricule ${item.matricule} non trouvé.`);
          } else {
            studentId = student.id;
          }
        }

        // Validate note scales
        ['cc', 'sn', 'tp'].forEach(key => {
          if (item[key] !== null && item[key] !== undefined) {
            const val = parseFloat(item[key]);
            if (!isNaN(val) && (val < 0 || val > 20)) {
              itemProblems.push(`Note ${key.toUpperCase()} hors échelle (0-20): ${val}`);
            }
          }
        });

        if (itemProblems.length > 0) {
          // ─── Enregistrer l'erreur dans import_error ───────────────────
          const matriculeBrut = isAnonymous ? (item.anonymat || '') : (item.matricule || '');
          const { error: errInsertErr } = await supabase
            .from('import_error')
            .upsert({
              ec_id: parseInt(ecId),
              session_id: parseInt(sessionId),
              annee_id: anneeId,
              etudiant_id: studentId,
              matricule_brut: matriculeBrut,
              problemes: itemProblems,
              statut: 'EN_ERREUR',
              date_detection: new Date().toISOString(),
              date_resolution: null,
              import_batch_id: importBatchId
            }, { onConflict: 'ec_id,session_id,matricule_brut' });

          if (errInsertErr) {
            console.error('Erreur lors de l\'enregistrement dans import_error:', errInsertErr);
          }

          errors.push(...itemProblems);
          continue; // Passer à l'élément suivant si des problèmes fondamentaux existent (étudiant introuvable)
        }

        // Upsert note (uniquement si l'étudiant a été trouvé)
        if (studentId) {
          const { data: note, error: noteErr } = await supabase
            .from('note')
            .upsert({
              etudiant_id: studentId,
              ec_id: ecId,
              session_id: sessionId,
              value_cc: item.cc,
              value_sn: item.sn,
              value_tp: item.tp,
              updated_at: new Date()
            })
            .select()
            .single();

          if (noteErr) throw noteErr;
          results.push(note);
        }
      } catch (err) {
        const identifier = item.matricule || item.anonymat || 'inconnu';
        errors.push(`Erreur lors de l'enregistrement pour ${identifier}: ${err.message}`);
      }
    }

    res.status(200).json({
      message: 'Import confirmed',
      importedCount: results.length,
      errors: errors,
      importBatchId
    });
  } catch (err) {
    console.error('Import confirmation error:', err);
    res.status(500).json({ message: 'Internal server error during import confirmation.' });
  }
};

exports.traiterExcel = async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }

  try {
    const workbook = xlsx.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

    let headerRowIndex = -1;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row && Array.isArray(row) && row.includes('Nom') && row.includes('Prénom') && row.includes('Résultat')) {
        headerRowIndex = i;
        break;
      }
    }

    if (headerRowIndex === -1) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ message: "Le fichier ne correspond pas au format attendu (colonnes Nom, Prénom, Résultat introuvables)." });
    }

    const nomIndex = data[headerRowIndex].indexOf('Nom');
    const prenomIndex = data[headerRowIndex].indexOf('Prénom');
    const resultatIndex = data[headerRowIndex].indexOf('Résultat');
    const colonne2Index = data[headerRowIndex].indexOf('Colonne2');

    const normalizedData = [];
    for (let i = headerRowIndex + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !Array.isArray(row) || row.length === 0) continue;

      let nom = row[nomIndex] !== undefined ? row[nomIndex] : '';
      let matricule = row[prenomIndex] !== undefined ? row[prenomIndex] : '';

      nom = nom.toString().trim();
      matricule = matricule.toString().trim();

      if (!nom && !matricule) continue;

      let note = '';
      if (colonne2Index !== -1 && row[colonne2Index] !== undefined) {
        note = row[colonne2Index];
      } else if (resultatIndex !== -1 && row[resultatIndex] !== undefined) {
        const resStr = row[resultatIndex].toString();
        const match = resStr.match(/^([\d,.]+)/);
        if (match) {
          note = match[1].replace(',', '.');
        }
      }

      normalizedData.push({
        Matricule: matricule,
        Nom: nom,
        Note: note
      });
    }

    const newWs = xlsx.utils.json_to_sheet(normalizedData);
    const newWb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(newWb, newWs, "Notes");
    const buffer = xlsx.write(newWb, { type: 'buffer', bookType: 'xlsx' });

    fs.unlinkSync(file.path);

    res.setHeader('Content-Disposition', 'attachment; filename="normalized.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error('TeleEvaluation processing error:', err);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ message: 'Erreur lors du traitement du fichier.', detail: err.message });
  }
};
