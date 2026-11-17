// 生成大体积测试 PDF（多页 + 长文本，未压缩以模拟大文件）
const fs = require('fs');
const path = require('path');
fs.mkdirSync(path.join(__dirname, 'testlib'), { recursive: true });
const OUT = path.join(__dirname, 'testlib', '大文件测试-500页.pdf');
const PAGES = 500;
const objs = [];
const pageIds = [];
// 1: catalog, 2: pages, 3: font, 之后 page / content
let nextId = 4;
const filler = 'The quick brown fox jumps over the lazy dog. Large file reading test for chunked loading and render performance.';
for (let i = 0; i < PAGES; i++) {
  const contentId = nextId++;
  const pageId = nextId++;
  pageIds.push(pageId);
  let text = '';
  for (let l = 0; l < 44; l++) {
    text += `BT /F1 11 Tf 56 ${760 - l * 16} Td (${(i + 1)}.${l + 1}  ${filler.slice(0, 78)}) Tj ET\n`;
  }
  const stream = `BT /F1 24 Tf 56 780 Td (Page ${i + 1} / ${PAGES}) Tj ET\n` + text;
  objs[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
}
objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
objs[2] = `<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count ${PAGES} >>`;
objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

let out = '%PDF-1.4\n';
const offsets = [];
for (let id = 1; id < nextId; id++) {
  if (!objs[id]) continue;
  offsets[id] = Buffer.byteLength(out);
  out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(out);
out += `xref\n0 ${nextId}\n0000000000 65535 f \n`;
for (let id = 1; id < nextId; id++) {
  out += (offsets[id] ? String(offsets[id]).padStart(10, '0') : '0000000000') + ' 00000 n \n';
}
out += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
fs.writeFileSync(OUT, Buffer.from(out, 'latin1'));
console.log('PDF created:', OUT, (fs.statSync(OUT).size / 1048576).toFixed(1), 'MB', PAGES, 'pages');
