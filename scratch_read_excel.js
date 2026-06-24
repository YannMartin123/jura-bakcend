const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'example', 'fiche2.xlsx');
const workbook = xlsx.readFile(filePath);
console.log('Sheet Names:', workbook.SheetNames);

const firstSheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[firstSheetName];
const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

console.log('Rows 11 to 30:');
data.slice(10, 30).forEach((row, index) => {
  console.log(`Row ${index + 11}:`, row);
});
