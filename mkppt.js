// 生成 .ppt 测试文件：模拟 OLE 复合文档 + UTF-16LE 文本流
const fs = require('fs');
const pathmod = require('path');
fs.mkdirSync(pathmod.join(__dirname, 'testlib'), { recursive: true });
const path = pathmod.join(__dirname, 'testlib', '产品发布会-theme.ppt');

const slides = [
  '2026 年度产品发布会',
  '第一部分：市场回顾',
  '过去一年，我们的用户规模增长了 180%，日活跃用户突破 120 万。',
  '第二部分：新品介绍',
  '全新一代产品将在下季度发布，主打轻量化与高性能。',
  '价格策略：延续高性价比路线，基础版保持原价。'
];

// OLE 头（D0 CF 11 E0 A1 B1 1A E1）
const ole = Buffer.from('D0CF11E0A1B11AE1', 'hex');
const parts = [ole, Buffer.alloc(504, 0)];
for (const s of slides) {
  parts.push(Buffer.from([0x0f, 0x00, 0x02, 0x00]));            // 记录头
  parts.push(Buffer.from(s, 'utf16le'));
  parts.push(Buffer.from([0x00, 0x00]));
  parts.push(Buffer.alloc(16, 0));
}
// 再加一段 ASCII 文本（模拟单字节记录）
parts.push(Buffer.from('\nSlide Notes: internal draft, do not distribute.\n', 'latin1'));
fs.writeFileSync(path, Buffer.concat(parts));
console.log('created', path, fs.statSync(path).size, 'bytes');

// 验证提取
const { extractPptText } = require('./fnbookshelf/appsrc/server/lib/office.js');
const text = extractPptText(path);
console.log('--- extracted ---');
console.log(text);
