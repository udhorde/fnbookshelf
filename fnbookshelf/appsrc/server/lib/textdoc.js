// 文本类文档读取（TXT / MD / HTML / RTF / DOC / DOCX）
//
// 1.8.0 的两个刚需：
//   ① 编码自动识别——中文 TXT 大量是 GBK/GB18030，以前一律按 UTF-8 读 → 满屏乱码；
//      这里先看 BOM，再看 UTF-16 特征，再严格校验 UTF-8，最后在 GB18030 / BIG5 之间打分。
//   ② 分块读取——几 MB 的 TXT 一次性 decode + 每个自然段一个 <p>，浏览器会直接卡死；
//      这里给行文本建「检查点索引」（每 256KB 一个），接口按段落区间返回，
//      前端滚到哪儿取哪儿，内存占用与文件大小无关。
'use strict';
const fs = require('fs');
const path = require('path');
const safeio = require('./safeio');
const worddoc = require('./worddoc');

const BLOCK = 256 * 1024;        // 索引与读取的块大小（按换行对齐）
const MAX_ITEM_CHARS = 20000;    // 单段上限（防止一整本没有换行的文件撑爆响应）
const MEM_FILE_MAX = 16 * 1024 * 1024;  // DOC/HTML/RTF 这类要整体解析的文件上限
const CACHE_TTL = 10 * 60 * 1000;

const idxCache = new Map();   // filePath -> 索引
const memCache = new Map();   // filePath -> 解析好的段落

// ---------------- 编码识别 ----------------
function scoreEnc(sample, enc) {
  try {
    const s = new TextDecoder(enc).decode(sample);
    const bad = (s.match(/\uFFFD/g) || []).length;
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk - bad * 5;
  } catch (_) { return -1e9; }
}

function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf-8', skip: 3, label: 'UTF-8 (BOM)' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf-16le', skip: 2, label: 'UTF-16 LE' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf-16be', skip: 2, label: 'UTF-16 BE' };

  // 无 BOM 的 UTF-16：ASCII 区会出现大量 0x00
  const n = Math.min(buf.length, 8192) & ~1;
  let zeroEven = 0, zeroOdd = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    if (buf[i] === 0) zeroEven++;
    if (buf[i + 1] === 0) zeroOdd++;
  }
  const pairs = n / 2;
  if (pairs > 16) {
    if (zeroOdd > pairs * 0.4 && zeroEven < pairs * 0.08) return { enc: 'utf-16le', skip: 0, label: 'UTF-16 LE' };
    if (zeroEven > pairs * 0.4 && zeroOdd < pairs * 0.08) return { enc: 'utf-16be', skip: 0, label: 'UTF-16 BE' };
  }

  // 严格 UTF-8：样本尾部可能正好切断一个多字节字符，最多回退 3 个字节再试
  const len = Math.min(buf.length, 256 * 1024);
  let sample = buf.subarray(0, Math.max(4, len));
  for (let trim = 0; trim <= 3; trim++) {
    sample = buf.subarray(0, Math.max(4, len - trim));
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample);
      return { enc: 'utf-8', skip: 0, label: 'UTF-8' };
    } catch (_) { /* 继续回退 */ }
  }

  const gb = scoreEnc(sample, 'gb18030');
  const big = scoreEnc(sample, 'big5');
  if (big > gb && big > 0) return { enc: 'big5', skip: 0, label: 'BIG5' };
  return { enc: 'gb18030', skip: 0, label: 'GB18030 / GBK' };
}

function decodeBuf(buf, enc) {
  try { return new TextDecoder(enc || 'utf-8').decode(buf); }
  catch (_) { return buf.toString('utf8'); }
}

/** 只读文件开头，返回解码后的文本（刮削 / 目录 / 元数据共用） */
function readHeadText(fp, maxBytes, maxChars) {
  maxBytes = maxBytes || 256 * 1024;
  maxChars = maxChars || 20000;
  let buf;
  try { buf = safeio.readHead(fp, maxBytes); } catch (_) { return { text: '', enc: 'utf-8', label: '' }; }
  const det = detectEncoding(buf);
  let body = buf.subarray(Math.min(det.skip, buf.length));
  // 截断多字节字符尾部，避免最后一个字变 �
  if (det.enc !== 'utf-16le' && det.enc !== 'utf-16be') body = body.subarray(0, Math.max(0, body.length - 3));
  const text = decodeBuf(body, det.enc).replace(/\u0000/g, '');
  return { text: maxChars ? text.slice(0, maxChars) : text, enc: det.enc, label: det.label };
}

/** 读取最前面 n 个「字」（刮削用 500 字） */
function firstChars(fp, n) {
  const r = readHeadText(fp, Math.max(64 * 1024, (n || 500) * 4), (n || 500) * 2);
  return String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, n || 500);
}

// ---------------- 行文本索引 ----------------
function paraCountOf(text) {
  let c = 0;
  for (const line of text.split('\n')) if (line.trim()) c++;
  return c;
}

/** 把块尾对齐到换行边界：块之间不会有半个字符 / 半行 */
function alignCut(buf, bytesRead, isEof, enc) {
  if (isEof) return bytesRead;
  if (enc === 'utf-16le') {
    for (let i = bytesRead - 2; i >= 0; i -= 2) if (buf[i] === 0x0a && buf[i + 1] === 0) return i + 2;
    return bytesRead & ~1;
  }
  if (enc === 'utf-16be') {
    for (let i = bytesRead - 2; i >= 0; i -= 2) if (buf[i] === 0 && buf[i + 1] === 0x0a) return i + 2;
    return bytesRead & ~1;
  }
  const nl = buf.lastIndexOf(0x0a, bytesRead - 1);
  return nl > 0 ? nl + 1 : bytesRead;
}

async function buildIndex(fp) {
  const st = await fs.promises.stat(fp);
  const fh = await fs.promises.open(fp, 'r');
  try {
    const headLen = Math.min(st.size, 128 * 1024);
    const head = Buffer.alloc(headLen);
    if (headLen) await fh.read(head, 0, headLen, 0);
    const det = detectEncoding(head);
    const checkpoints = [{ byte: 0, para: 0 }];
    let pos = 0, para = 0, chars = 0, first = true;
    while (pos < st.size) {
      const want = Math.min(BLOCK, st.size - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      const cut = alignCut(buf, bytesRead, pos + bytesRead >= st.size, det.enc);
      let seg = buf.subarray(0, cut);
      if (first && det.skip) seg = seg.subarray(Math.min(det.skip, seg.length));
      first = false;
      const text = decodeBuf(seg, det.enc);
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) { para++; chars += t.length; }
      }
      pos += cut;
      if (pos < st.size) checkpoints.push({ byte: pos, para });
    }
    return {
      fp, size: st.size, mtime: st.mtimeMs, enc: det.enc, label: det.label,
      skip: det.skip, checkpoints, paraCount: para, chars, at: Date.now()
    };
  } finally { await fh.close(); }
}

async function getIndex(fp) {
  const cached = idxCache.get(fp);
  let st;
  try { st = await fs.promises.stat(fp); } catch (_) { return null; }
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;
  const idx = await buildIndex(fp);
  idxCache.set(fp, idx);
  if (idxCache.size > 12) {
    const oldest = [...idxCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) idxCache.delete(oldest[0]);
  }
  return idx;
}

function pickCheckpoint(idx, from) {
  let lo = 0, hi = idx.checkpoints.length - 1, best = idx.checkpoints[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cp = idx.checkpoints[mid];
    if (cp.para <= from) { best = cp; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

async function readRange(idx, from, count) {
  const cp = pickCheckpoint(idx, from);
  const fh = await fs.promises.open(idx.fp, 'r');
  try {
    let pos = cp.byte, para = cp.para;
    const items = [];
    let guard = 0;
    while (pos < idx.size && items.length < count && guard++ < 16) {
      const want = Math.min(BLOCK * 2, idx.size - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      const cut = alignCut(buf, bytesRead, pos + bytesRead >= idx.size, idx.enc);
      let seg = buf.subarray(0, cut);
      if (pos === 0 && idx.skip) seg = seg.subarray(Math.min(idx.skip, seg.length));
      const text = decodeBuf(seg, idx.enc);
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (para >= from && items.length < count) {
          items.push(t.length > MAX_ITEM_CHARS ? t.slice(0, MAX_ITEM_CHARS) + ' …（本行过长，已截断）' : t);
        }
        para++;
        if (items.length >= count) break;
      }
      pos += cut;
    }
    return items;
  } finally { await fh.close(); }
}

// ---------------- HTML / RTF 转纯文本 ----------------
function entities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch (_) { return m; } });
}

function htmlToLines(html) {
  const txt = entities(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
  return txt.split(/\r?\n/).map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
}

function rtfToLines(rtf) {
  let s = String(rtf || '');
  s = s.replace(/\\'([0-9a-f]{2})/gi, (m, h) => {
    try { return decodeBuf(Buffer.from([parseInt(h, 16)]), 'gb18030'); } catch (_) { return m; }
  });
  s = s.replace(/\\u(-?\d+)\??/g, (m, d) => { try { return String.fromCharCode((+d + 65536) % 65536); } catch (_) { return m; } });
  s = s.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t');
  s = s.replace(/\\[a-z]+-?\d*\s?/gi, '').replace(/[{}]/g, '');
  return s.split(/\r?\n/).map(l => l.replace(/\s+$/, '').trim()).filter(Boolean);
}

// ---------------- 统一入口 ----------------
function memDoc(fp, ext) {
  const st = fs.statSync(fp);
  const cached = memCache.get(fp);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached;
  let paras = [];
  let encoding = '';
  try {
    if (ext === 'docx' || ext === 'doc') {
      paras = worddoc.paragraphs(fp, ext);
      encoding = ext === 'docx' ? 'OOXML (UTF-8)' : 'Word 97 二进制';
    } else if (ext === 'html' || ext === 'htm') {
      const buf = safeio.readHead(fp, MEM_FILE_MAX);
      const det = detectEncoding(buf);
      encoding = det.label;
      paras = htmlToLines(decodeBuf(buf.subarray(Math.min(det.skip, buf.length)), det.enc)).map(t => ({ html: worddoc.esc(t), level: 0, text: t }));
    } else if (ext === 'rtf') {
      const buf = safeio.readHead(fp, MEM_FILE_MAX);
      paras = rtfToLines(buf.toString('latin1')).map(t => ({ html: worddoc.esc(t), level: 0, text: t }));
      encoding = 'RTF';
    }
  } catch (e) {
    paras = [{ html: '（无法解析这个文件：' + worddoc.esc(e.message) + '）', level: 0, text: e.message }];
  }
  const rec = { kind: 'html', encoding: encoding || ext.toUpperCase(), total: paras.length, paras, mtime: st.mtimeMs, size: st.size, at: Date.now() };
  memCache.set(fp, rec);
  if (memCache.size > 3) {
    const oldest = [...memCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) memCache.delete(oldest[0]);
  }
  return rec;
}

/**
 * 打开一个文本类文档
 * @returns {Promise<{kind:'text'|'html', encoding:string, total:number,
 *   read:(from:number,count:number)=>Promise<Array<{v:string,l:number}>>}>}
 *   v=段落内容（kind=text 时是纯文本，kind=html 时是已转义的安全 HTML），l=标题层级（0=正文）
 */
async function open(fp, ext) {
  const e = String(ext || '').toLowerCase();
  if (['doc', 'docx', 'html', 'htm', 'rtf'].includes(e)) {
    const rec = memDoc(fp, e);
    return {
      kind: 'html',
      encoding: rec.encoding,
      total: rec.total,
      read: async (from, count) => {
        from = Math.max(0, from | 0);
        count = Math.max(1, Math.min(400, count | 0));
        return rec.paras.slice(from, from + count).map(p => ({ v: p.html, l: p.level || 0 }));
      }
    };
  }
  const idx = await getIndex(fp);
  if (!idx) throw new Error('文件不存在或不可读');
  return {
    kind: 'text',
    encoding: idx.label || idx.enc,
    total: idx.paraCount,
    read: async (from, count) => (await readRange(idx, from, count)).map(v => ({ v, l: 0 }))
  };
}

function invalidate(fp) {
  idxCache.delete(fp);
  memCache.delete(fp);
}

module.exports = {
  open, detectEncoding, decodeBuf, readHeadText, firstChars, invalidate,
  htmlToLines, rtfToLines, paraCountOf, BLOCK
};
