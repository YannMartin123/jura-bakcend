const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { supabase } = require('../config/supabase');
const pdfService = require('../services/pdf.service');
const path = require('path');

router.get('/export/:ecId', 
  authenticateToken, 
  authorizeRoles('ENSEIGNANT', 'ADMIN'), 
  async (req, res) => {
    const { ecId } = req.params;

    try {
      // 1. Fetch data from Supabase
      const { data: notes, error: notesErr } = await supabase
        .from('note')
        .select(`
          *,
          etudiant:etudiant_id (matricule, nom)
        `)
        .eq('ec_id', ecId);

      if (notesErr) throw notesErr;

      const { data: ec, error: ecErr } = await supabase
        .from('ec')
        .select('*')
        .eq('id', ecId)
        .single();

      if (ecErr) throw ecErr;

      // 2. Format data for PDF
      const formattedData = notes.map(n => ({
        matricule: n.etudiant.matricule,
        nom: n.etudiant.nom,
        cc: n.value_cc,
        sn: n.value_sn,
        tp: n.value_tp
      }));

      const metadata = {
        ecName: ec.nom,
        ecCode: ec.code,
        annee: '2023-2024', // Should be dynamic
        semestre: '1'
      };

      // 3. Generate PDF
      const { filePath, filename } = await pdfService.generatePV(formattedData, metadata);

      // 4. Send file
      res.download(filePath, filename);
    } catch (err) {
      console.error('Export error:', err);
      res.status(500).json({ message: 'Error generating PV.' });
    }
  }
);

module.exports = router;
