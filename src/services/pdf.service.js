const PDFDocument = require('pdfkit');
const fs = require('fs');

class PDFService {
  /**
   * Generate a Procès-Verbal (PV) PDF
   */
  async generatePV(data, metadata) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const filename = `PV_${metadata.ecCode}_${Date.now()}.pdf`;
      const filePath = `./exports/${filename}`;

      // Ensure directory exists
      if (!fs.existsSync('./exports')) {
        fs.mkdirSync('./exports');
      }

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Header
      doc.fontSize(12).text('REPUBLIQUE DU CAMEROUN', { align: 'center' });
      doc.text('Paix - Travail - Patrie', { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).text('UNIVERSITÉ DE YAOUNDÉ I', { align: 'center', bold: true });
      doc.fontSize(12).text(metadata.etablissement || 'FACULTÉ DES SCIENCES', { align: 'center' });
      doc.moveDown();

      doc.fontSize(16).text(`PROCÈS-VERBAL DE NOTES`, { align: 'center', underline: true });
      doc.fontSize(12).text(`EC: ${metadata.ecName} (${metadata.ecCode})`, { align: 'center' });
      doc.text(`Année Académique: ${metadata.annee} - Semestre: ${metadata.semestre}`, { align: 'center' });
      doc.moveDown();

      // Table Header
      const tableTop = 250;
      doc.fontSize(10);
      doc.text('Matricule', 50, tableTop);
      doc.text('Nom et Prénom', 150, tableTop);
      doc.text('CC', 350, tableTop);
      doc.text('SN', 400, tableTop);
      doc.text('Moyenne', 450, tableTop);
      doc.text('Observation', 500, tableTop);

      doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

      // Table Rows
      let y = tableTop + 25;
      data.forEach((item, index) => {
        if (y > 700) {
          doc.addPage();
          y = 50;
        }

        const moyenne = (item.cc * 0.3) + (item.sn * 0.7);
        const observation = moyenne >= 10 ? 'Validé' : 'Non Validé';

        doc.text(item.matricule, 50, y);
        doc.text(item.nom, 150, y, { width: 180, height: 20, ellipsis: true });
        doc.text(item.cc?.toFixed(2) || '-', 350, y);
        doc.text(item.sn?.toFixed(2) || '-', 400, y);
        doc.text(moyenne.toFixed(2), 450, y);
        doc.text(observation, 500, y);

        y += 20;
      });

      // Footer / Signatures
      doc.moveDown(2);
      const signatureY = doc.y + 50;
      doc.text('Signature de l\'Enseignant', 50, signatureY);
      doc.text('Le Chef de Département', 350, signatureY);

      doc.end();

      stream.on('finish', () => resolve({ filename, filePath }));
      stream.on('error', reject);
    });
  }
}

module.exports = new PDFService();
