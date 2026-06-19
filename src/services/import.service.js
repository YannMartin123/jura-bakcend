const XLSX = require('xlsx');
const PDFParser = require('pdf2json');
const fs = require('fs');

/**
 * Service to handle parsing and validation of grade imports
 */
class ImportService {
  /**
   * Parse an Excel file and return structured data
   * @param {string} filePath 
   */
  async parseExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    return this.normalizeData(data);
  }

  /**
   * Parse a PDF file using coordinate-based logic via Worker Threads
   * @param {string} filePath 
   */
  async parsePDF(filePath) {
    const { Worker } = require('worker_threads');
    const path = require('path');

    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, '../workers/pdf-worker.js'), {
        workerData: { filePath }
      });

      worker.on('message', (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          const rows = this.groupItemsByRows(result.data);
          const data = this.extractDataFromRows(rows);
          resolve(this.normalizeData(data));
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }

  /**
   * Group PDF items into rows based on Y coordinate with a tolerance
   */
  groupItemsByRows(items, tolerance = 0.5) {
    // Sort by Y then X
    items.sort((a, b) => a.y - b.y || a.x - b.x);

    const rows = [];
    if (items.length === 0) return rows;

    let currentRow = [items[0]];
    let currentY = items[0].y;

    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      if (Math.abs(item.y - currentY) <= tolerance) {
        currentRow.push(item);
      } else {
        rows.push(currentRow);
        currentRow = [item];
        currentY = item.y;
      }
    }
    rows.push(currentRow);
    
    // Sort items within each row by X
    rows.forEach(row => row.sort((a, b) => a.x - b.x));
    
    return rows;
  }

  /**
   * Identify header and extract data from rows
   */
  extractDataFromRows(rows) {
    let header = null;
    let headerIndex = -1;
    const data = [];

    // Keywords to identify the header row
    const keywords = ['MATRICULE', 'NOM', 'CC', 'SN', 'TP', 'ANONYMAT', 'CODE'];

    for (let i = 0; i < rows.length; i++) {
      const rowText = rows[i].map(item => item.text.toUpperCase());
      const matchCount = keywords.filter(k => rowText.some(t => t.includes(k))).length;

      if (matchCount >= 2) {
        header = rows[i];
        headerIndex = i;
        break;
      }
    }

    if (!header) return [];

    // Map columns by X proximity
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      const entry = {};
      
      header.forEach(hItem => {
        const hText = hItem.text.toUpperCase();
        const key = this.mapHeaderToKey(hText);
        
        // Find item in current row closest to header X
        const closestItem = row.reduce((prev, curr) => {
          return (Math.abs(curr.x - hItem.x) < Math.abs(prev.x - hItem.x) ? curr : prev);
        }, row[0]);

        if (closestItem && Math.abs(closestItem.x - hItem.x) < 5) { // 5 is a broad tolerance for column alignment
          entry[key] = closestItem.text;
        }
      });

      if (Object.keys(entry).length > 0) {
        data.push(entry);
      }
    }

    return data;
  }

  mapHeaderToKey(headerText) {
    if (headerText.includes('MATRICULE')) return 'matricule';
    if (headerText.includes('ANONYMAT') || headerText.includes('CODE')) return 'anonymat';
    if (headerText.includes('NOM')) return 'nom';
    if (headerText.includes('CC')) return 'cc';
    if (headerText.includes('SN') || headerText.includes('EXAMEN')) return 'sn';
    if (headerText.includes('TP')) return 'tp';
    return headerText.toLowerCase().replace(/\s+/g, '_');
  }

  /**
   * Normalize data: handle types, scale notes to /20
   */
  normalizeData(data) {
    return data.map(item => {
      const normalized = { ...item };
      
      // Convert notes to numbers and handle scales if needed
      // Assume input might be string, convert to float
      ['cc', 'sn', 'tp'].forEach(key => {
        if (normalized[key]) {
          let val = parseFloat(normalized[key].toString().replace(',', '.'));
          if (isNaN(val)) val = null;
          normalized[key] = val;
        } else {
          normalized[key] = null;
        }
      });

      return normalized;
    });
  }

  /**
   * Business validation
   */
  async validateImport(data, ecId, isAnonymous = false) {
    const errors = [];
    const validData = [];

    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const rowNum = i + 1;

      if (!isAnonymous && !item.matricule) {
        errors.push(`Ligne ${rowNum}: Matricule manquant`);
        continue;
      }
      if (isAnonymous && !item.anonymat) {
        errors.push(`Ligne ${rowNum}: Code anonymat manquant`);
        continue;
      }

      // Check note scales
      ['cc', 'sn', 'tp'].forEach(key => {
        if (item[key] !== null && (item[key] < 0 || item[key] > 20)) {
          errors.push(`Ligne ${rowNum}: Note ${key.toUpperCase()} hors échelle (0-20)`);
        }
      });

      validData.push(item);
    }

    return { validData, errors };
  }
}

module.exports = new ImportService();
