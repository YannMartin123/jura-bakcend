const { parentPort, workerData } = require('worker_threads');
const PDFParser = require('pdf2json');

const parsePDF = (filePath) => {
  const pdfParser = new PDFParser();
  
  pdfParser.on("pdfParser_dataError", errData => {
    parentPort.postMessage({ error: errData.parserError });
  });

  pdfParser.on("pdfParser_dataReady", pdfData => {
    const pages = pdfData.Pages;
    let allItems = [];

    pages.forEach(page => {
      const texts = page.Texts;
      const items = texts.map(t => ({
        text: decodeURIComponent(t.R[0].T),
        x: t.x,
        y: t.y,
        w: t.w
      }));
      allItems = [...allItems, ...items];
    });

    parentPort.postMessage({ data: allItems });
  });

  pdfParser.loadPDF(filePath);
};

parsePDF(workerData.filePath);
