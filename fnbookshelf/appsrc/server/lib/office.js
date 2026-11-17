// PPT/PPTX → PDF 转换（调用系统 LibreOffice，仅生成阅读缓存，不改动原文件）
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function findSoffice() {
  const candidates = [
    '/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice',
    '/usr/bin/libreoffice', '/opt/LibreOffice/program/soffice'
  ];
  for (const c of candidates) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {} }
  return null;
}

function convertToPdf(srcPath, cacheDir) {
  return new Promise((resolve) => {
    const soffice = findSoffice();
    if (!soffice) return resolve({ ok: false, reason: 'notfound' });
    const outDir = path.join(cacheDir, 'office');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = fs.statSync(srcPath).mtimeMs;
    const outPdf = path.join(outDir, path.basename(srcPath).replace(/\.[^.]+$/, '') + '.pdf');
    // 缓存有效则直接复用
    try {
      if (fs.existsSync(outPdf) && fs.statSync(outPdf).mtimeMs >= stamp) return resolve({ ok: true, pdf: outPdf, cached: true });
    } catch (_) {}
    execFile(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, srcPath],
      { timeout: 120000 }, (err) => {
        if (err || !fs.existsSync(outPdf)) return resolve({ ok: false, reason: err ? err.message : 'convert-failed' });
        resolve({ ok: true, pdf: outPdf, cached: false });
      });
  });
}

// 二进制 .ppt（无 LibreOffice 时）降级提取文本：
// PowerPoint 二进制格式的正文文本以 UTF-16LE 或单字节记录存储，
// 用启发式扫描可读字符流，尽力恢复文字内容（图片与版式无法恢复）
function extractPptText(srcPath) {
  try {
    const buf = fs.readFileSync(srcPath);
    if (buf.length > 80 * 1024 * 1024) return '';
    const out = [];
    let i = 0;
    const n = buf.length;
    const isPrintable = c => (c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x0d;
    // UTF-16LE 双字节字符：CJK 汉字（U+4E00-9FFF）、CJK 标点（U+3000-303F）、全角字符（U+FF00-FFEF）
    const isWide = (lo, hi) => (hi >= 0x4e && hi <= 0x9f) || hi === 0x30 || hi === 0xff;
    const okUnit = (lo, hi) => (hi === 0 && (isPrintable(lo) || lo === 0x09)) || isWide(lo, hi);
    while (i < n) {
      if (i + 1 < n && okUnit(buf[i], buf[i + 1])) {
        let j = i, s = '';
        while (j + 1 < n) {
          const lo = buf[j], hi = buf[j + 1];
          if (hi === 0 && (isPrintable(lo) || lo === 0x09)) { s += String.fromCharCode(lo); j += 2; }
          else if (isWide(lo, hi)) { s += String.fromCharCode((hi << 8) | lo); j += 2; }
          else break;
        }
        if (s.trim().length >= 4 && /[a-zA-Z\u4e00-\u9fa5]/.test(s)) out.push(s);
        i = j + 2;
        continue;
      }
      // 单字节运行段（至少 12 个可打印字符才算正文，避免噪音）
      if (isPrintable(buf[i]) && buf[i] !== 0x0d) {
        let j = i, s = '';
        while (j < n && isPrintable(buf[j])) { s += String.fromCharCode(buf[j]); j++; }
        if (s.trim().length >= 12 && /[a-zA-Z\u4e00-\u9fa5]/.test(s)) out.push(s);
        i = j;
        continue;
      }
      i++;
    }
    // 过滤误判：整段每个字符的低字节都是可打印 ASCII → 实际是单字节文本被按双字节误读
    const isMisread = s => {
      if (s.length < 4) return true;
      let printable = 0;
      for (const ch of s) {
        const lo = ch.codePointAt(0) & 0xff;
        if ((lo >= 0x20 && lo <= 0x7e) || lo === 0x09 || lo === 0x0a) printable++;
      }
      return printable === s.length;
    };
    // 清理：合并换行、去重连续重复行
    const seen = new Set();
    const lines = out
      .filter(s => !isMisread(s))
      .join('\n').split(/\n+/)
      .map(l => l.replace(/\u0000/g, '').trim())
      .filter(l => l && !seen.has(l) && seen.add(l));
    return lines.join('\n\n');
  } catch (e) { return ''; }
}

module.exports = { findSoffice, convertToPdf, extractPptText };
