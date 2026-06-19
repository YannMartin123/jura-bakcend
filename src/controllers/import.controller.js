const importService = require('../services/import.service');
const { supabase } = require('../config/supabase');
const fs = require('fs');

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

  try {
    const results = [];
    const errors = [];

    // Process in batches or one by one for better error tracking
    for (const item of data) {
      try {
        let studentId;

        if (isAnonymous) {
          // Map anonymat code to studentId
          const { data: mapping, error: mapErr } = await supabase
            .from('anonymiser')
            .select('etudiant_id')
            .eq('code', item.anonymat)
            .eq('ec_id', ecId)
            .single();

          if (mapErr || !mapping) {
            errors.push(`Code anonymat ${item.anonymat} non trouvé pour cette EC.`);
            continue;
          }
          studentId = mapping.etudiant_id;
        } else {
          // Find student by matricule
          const { data: student, error: stuErr } = await supabase
            .from('etudiant')
            .select('id')
            .eq('matricule', item.matricule)
            .single();

          if (stuErr || !student) {
            errors.push(`Matricule ${item.matricule} non trouvé.`);
            continue;
          }
          studentId = student.id;
        }

        // Upsert note
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
      } catch (err) {
        errors.push(`Erreur lors de l'enregistrement pour ${item.matricule || item.anonymat}: ${err.message}`);
      }
    }

    res.status(200).json({
      message: 'Import confirmed',
      importedCount: results.length,
      errors: errors
    });
  } catch (err) {
    console.error('Import confirmation error:', err);
    res.status(500).json({ message: 'Internal server error during import confirmation.' });
  }
};
