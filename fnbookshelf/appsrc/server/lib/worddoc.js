// Word 文档读取：.docx（OOXML，ZIP）与 .doc（Word 97-2003，OLE/CFB）→ 段落数组
//
// 设计目标：只做「读」，不改动、不转换原文件；大文档分块返回，绝不一次性塞给浏览器。
//  - .docx：只解压 word/document.xml，按 <w:p> 顺序抽取文字（保留粗体/斜体/标题层级）
//  - .doc ：走 CFB 的 WordDocument + 1Table/0Table 里的片段表（piece table）还原正文；
//           失败时退化为 fcMin..fcMac 连续区，再不行用启发式扫描（尽力而为）
'use strict';
const fs = require('fs');
const zipread = require('./zipread');
const cfb = require('./cfb');
const safeio = require('./safeio');

const MAX_DOCX_XML = 48 * 1024 * 1024;   // document.xml 上限
const MAX_PARAS = 200000;                // 段落数上限（防止异常文档撑爆内存）
const MAX_FILE = 512 * 1024 * 1024;      // 超过 512MB 直接放弃解析

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return m; } });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- DOCX ----------
function docxParagraphs(fp) {
  const size = safeio.sizeOf(fp);
  if (size > MAX_FILE) return [];
  const zip = zipread.open(fp);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) return [];
  if (entry.size > MAX_DOCX_XML) {
    const e = new Error(`文档正文过大（${Math.round(entry.size / 1048576)}MB），已跳过`);
    e.skipped = true;
    throw e;
  }
  const xml = zip.readAsText(entry);
  const bodyStart = xml.indexOf('<w:body');
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;

  const out = [];
  const pRe = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = pRe.exec(body)) && out.length < MAX_PARAS) {
    const inner = m[1] || '';
    let level = 0;
    const ol = inner.match(/<w:outlineLvl\b[^>]*w:val="(\d)"/);
    if (ol) level = Math.min(3, parseInt(ol[1], 10) + 1);
    else {
      const st = inner.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/);
      if (st) {
        const v = st[1];
        if (/^Heading(\d)$/i.test(v)) level = Math.min(3, parseInt(v.replace(/\D/g, ''), 10));
        else if (/^(Title|标题)$/i.test(v)) level = 1;
        else if (/^(Subtitle|副标题)$/i.test(v)) level = 2;
      }
    }
    const isList = /<w:numPr\b/.test(inner);

    let html = '';
    const rRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let r;
    let runCount = 0;
    while ((r = rRe.exec(inner))) {
      runCount++;
      const run = r[1];
      let text = '';
      const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
      let t;
      while ((t = tRe.exec(run))) text += decodeEntities(t[1]);
      if (!text) {
        if (/<w:tab\b/.test(run)) text = '\t';
        else if (/<w:br\b/.test(run)) text = '\n';
      }
      if (!text) continue;
      const off = run.match(/<w:b\b[^>]*w:val="(?:0|false|off)"/i);
      const bold = !off && /<w:b\b/.test(run);
      const ital = /<w:i\b/.test(run) && !/<w:i\b[^>]*w:val="(?:0|false|off)"/i.test(run);
      const und = /<w:u\b/.test(run) && !/<w:u\b[^>]*w:val="none"/i.test(run);
      let piece = esc(text).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
      if (bold) piece = '<b>' + piece + '</b>';
      if (ital) piece = '<i>' + piece + '</i>';
      if (und) piece = '<u>' + piece + '</u>';
      html += piece;
    }
    // 没有 <w:r> 的极简文档（例如某些导出工具）
    if (!runCount) {
      const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
      let t;
      while ((t = tRe.exec(inner))) html += esc(decodeEntities(t[1]));
    }
    html = html.replace(/\s+$/, '');
    if (!html) continue;
    if (isList && level === 0) html = '• ' + html;
    out.push({ html, level, text: html.replace(/<[^>]+>/g, '') });
  }
  return out;
}

// ---------- DOC（Word 97-2003） ----------
/** 8 位片段：中文老文档多为 GBK，纯西文为 CP1252 */
function decodeAnsi(bytes) {
  const hasHigh = bytes.some ? bytes.some(b => b >= 0x80) : Array.from(bytes).some(b => b >= 0x80);
  if (!hasHigh) return Buffer.from(bytes).toString('latin1');
  const buf = Buffer.from(bytes);
  try {
    const s = new TextDecoder('gb18030').decode(buf);
    if (/[\u4e00-\u9fff]/.test(s)) return s;
  } catch (_) {}
  return buf.toString('latin1');
}

function cleanDocText(s) {
  return String(s || '')
    .replace(/\r/g, '\n')
    .replace(/\u0007/g, '\n')                       // 表格单元格结束标记
    .replace(/\u000b/g, '\n')                       // 软换行
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, '')   // 其余控制字符
    .replace(/\u0013[^\u0014\u0015]*\u0014/g, '')   // 域代码
    .replace(/[\u0013\u0014\u0015]/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** 片段表（piece table）：Word 97 起正文按片段存放在 WordDocument 流的任意位置 */
function piecesText(clx, wd) {
  let p = 0;
  while (p < clx.length) {
    const kind = clx[p];
    if (kind === 0x01) {                            // Prc：属性块，跳过
      const cb = clx.readUInt16LE(p + 1);
      p += 3 + cb;
      continue;
    }
    if (kind !== 0x02) break;                       // Pcdt 之前只可能是 Prc
    const lcb = clx.readUInt32LE(p + 1);
    const plc = clx.subarray(p + 5, Math.min(clx.length, p + 5 + lcb));
    const n = Math.floor((lcb - 4) / 12);
    if (!(n > 0)) return '';
    const cps = [];
    for (let i = 0; i <= n; i++) cps.push(plc.readUInt32LE(i * 4));
    let out = '';
    for (let i = 0; i < n; i++) {
      const pcdOff = (n + 1) * 4 + i * 8;
      if (pcdOff + 8 > plc.length) break;
      const fcRaw = plc.readUInt32LE(pcdOff + 2);
      const compressed = (fcRaw & 0x40000000) !== 0;
      let fc = fcRaw & 0x3FFFFFFF;
      const len = Math.max(0, cps[i + 1] - cps[i]);
      if (!len) continue;
      if (compressed) {
        fc = fc >>> 1;                              // 压缩片段：偏移以「字符」计
        if (fc + len > wd.length) continue;
        out += decodeAnsi(wd.subarray(fc, fc + len));
      } else {
        if (fc + len * 2 > wd.length) continue;
        out += wd.subarray(fc, fc + len * 2).toString('utf16le');
      }
    }
    return out;
  }
  return '';
}

/** fcMin..fcMac 连续区（简单文档、未做快速保存的旧文件） */
function plainRange(wd) {
  try {
    const fcMin = wd.readUInt32LE(0x0018);
    const fcMac = wd.readUInt32LE(0x001c);
    if (!(fcMac > fcMin) || fcMac > wd.length) return '';
    if (fcMac - fcMin > 64 * 1024 * 1024) return '';
    const seg = wd.subarray(fcMin, fcMac);
    let text = seg.toString('utf16le');
    // 明显不是 UTF-16（大量替换符）就按单字节试
    if ((text.match(/\uFFFD/g) || []).length > text.length / 10) text = decodeAnsi(seg);
    return text;
  } catch (_) { return ''; }
}

/** 启发式兜底：扫描 UTF-16LE 可读字符段（与 PPT 文本抽取同思路） */
function heuristicScan(buf) {
  const out = [];
  const n = Math.min(buf.length, 64 * 1024 * 1024);
  const isWide = (lo, hi) => (hi >= 0x4e && hi <= 0x9f) || hi === 0x30 || hi === 0xff;
  const isPrintable = c => (c >= 0x20 && c <= 0x7e) || c === 0x09;
  let i = 0;
  while (i + 1 < n) {
    const lo = buf[i], hi = buf[i + 1];
    if ((hi === 0 && isPrintable(lo)) || isWide(lo, hi)) {
      let j = i, s = '';
      while (j + 1 < n) {
        const a = buf[j], b = buf[j + 1];
        if (b === 0 && isPrintable(a)) { s += String.fromCharCode(a); j += 2; }
        else if (isWide(a, b)) { s += String.fromCharCode((b << 8) | a); j += 2; }
        else break;
      }
      if (s.trim().length >= 8 && /[\u4e00-\u9fa5]{2,}|[a-zA-Z]{4,}/.test(s)) out.push(s);
      i = j + 2;
      continue;
    }
    i++;
  }
  return out.join('\n');
}

function docText(fp) {
  const size = safeio.sizeOf(fp);
  if (!size || size > MAX_FILE) return '';
  const buf = fs.readFileSync(fp);
  const wd = cfb.readStream(buf, 'WordDocument');
  if (!wd || wd.length < 32) return '';
  let text = '';
  try {
    if (wd.readUInt16LE(0) === 0xA5EC) {
      const flags = wd.readUInt16LE(0x0A);
      const tblName = (flags & 0x0200) ? '1Table' : '0Table';
      const tbl = cfb.readStream(buf, tblName) || cfb.readStream(buf, '1Table') || cfb.readStream(buf, '0Table');
      if (tbl && wd.length >= 0x01AE) {
        const fcClx = wd.readUInt32LE(0x01A2);
        const lcbClx = wd.readUInt32LE(0x01A6);
        if (lcbClx > 0 && fcClx + lcbClx <= tbl.length) text = piecesText(tbl.subarray(fcClx, fcClx + lcbClx), wd);
      }
    }
  } catch (_) { text = ''; }
  if (String(text).trim().length < 20) text = plainRange(wd);
  if (String(text).trim().length < 20) text = heuristicScan(wd);
  return cleanDocText(text);
}

/** 统一的段落入口：返回 [{html, level, text}] */
function paragraphs(fp, ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'docx') return docxParagraphs(fp);
  if (e === 'doc') {
    const text = docText(fp);
    if (!text.trim()) return [];
    return text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, MAX_PARAS)
      .map(l => ({ html: esc(l), level: 0, text: l }));
  }
  return [];
}

module.exports = { paragraphs, docxParagraphs, docText, esc };
