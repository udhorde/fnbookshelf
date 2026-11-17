// 正文抽样：刮削失败时读取书籍前若干页，提取书名/作者/ISBN/关键词，再发起二次刮削
'use strict';
const fs = require('fs');
const path = require('path');
const safeio = require('./safeio');
const textdoc = require('./textdoc');
const zlib = require('zlib');
const zipread = require('./zipread');
const { XMLParser } = require('fast-xml-parser');

const MAX_PAGES = 10;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, removeNSPrefix: true });

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const htmlToText = html => decodeEntities(String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|h\d|li|br|tr)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// ---------- EPUB：按 spine 顺序取前 N 个文档 ----------
function sampleEpub(fp, pages) {
  const zip = zipread.open(fp);
  let opfPath = null;
  try {
    const c = xml.parse(zip.readAsText(zip.getEntry('META-INF/container.xml')));
    const rf = c.container.rootfiles.rootfile;
    opfPath = (Array.isArray(rf) ? rf[0] : rf)['@_full-path'];
  } catch (_) {}
  if (!opfPath) {
    const e = zip.getEntries().find(x => x.entryName.toLowerCase().endsWith('.opf'));
    if (!e) return '';
    opfPath = e.entryName;
  }
  const dir = path.posix.dirname(opfPath);
  const doc = xml.parse(zip.readAsText(zip.getEntry(opfPath)));
  const manifest = doc.package && doc.package.manifest && doc.package.manifest.item;
  const items = Array.isArray(manifest) ? manifest : (manifest ? [manifest] : []);
  const byId = new Map(items.map(i => [i['@_id'], i]));
  const spine = doc.package && doc.package.spine && doc.package.spine.itemref;
  const refs = Array.isArray(spine) ? spine : (spine ? [spine] : []);
  const order = refs.map(r => byId.get(r['@_idref'])).filter(Boolean);
  const docs = order.length ? order : items.filter(i => /html|xml/.test(i['@_media-type'] || ''));
  let text = '', used = 0;
  for (const it of docs) {
    if (used >= pages) break;
    const href = it['@_href'];
    if (!href) continue;
    const p = path.posix.normalize(path.posix.join(dir, decodeURIComponent(href)));
    const entry = zip.getEntry(p);
    if (!entry) continue;
    const t = htmlToText(zip.readAsText(entry));
    if (t.length < 40) continue; // 封面页/版权页字数太少，不算一页
    text += '\n\n' + t;
    used++;
    if (text.length > 24000) break;
  }
  return text.slice(0, 24000);
}

// ---------- PDF：解压内容流，抓取文本操作符 ----------
function samplePdf(fp, pages) {
  let buf;
  try {
    const st = fs.statSync(fp);
    const limit = Math.min(st.size, safeio.MAX_PDF_HEAD);
    buf = Buffer.alloc(limit);
    const fd = fs.openSync(fp, 'r');
    fs.readSync(fd, buf, 0, limit, 0);
    fs.closeSync(fd);
  } catch (_) { return ''; }

  const chunks = [];
  // 找所有 stream ... endstream
  let idx = 0;
  let guard = 0;
  // 1.8.2.3：整本抽样给 1.5 秒预算。扫描版 PDF 的流又多又大，逐流分析很容易
  // 把主线程占住；超时宁可少抽几页，也绝不能让一次抽样卡死整个服务。
  const budget = Date.now() + 1500;
  while (chunks.length < 400 && guard++ < 4000) {
    if (Date.now() > budget) break;
    const s = buf.indexOf('stream', idx);
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e < 0) break;
    const raw = buf.subarray(start, e);
    idx = e + 9;
    // 判断是否 FlateDecode（看流前 200 字节的对象字典）
    const head = buf.subarray(Math.max(0, s - 400), s).toString('latin1');
    // 1.8.2.3：图片 / 字体子集流里没有可用文字，直接跳过。
    // 扫描版 PDF 一页一个巨大图片流，以前会把它们解压后再拿正则去啃，纯属浪费。
    if (/\/Subtype\s*\/Image|\/(?:DCT|JPX|CCITTFax|JBIG2)Decode/.test(head)) continue;
    let data = null;
    if (/\/FlateDecode/.test(head)) {
      const zopts = { maxOutputLength: safeio.MAX_INFLATE };
      try { data = zlib.inflateSync(raw, zopts); } catch (_) {
        try { data = zlib.inflateRawSync(raw, zopts); } catch (__) { data = null; }
      }
    } else if (!/\/Filter/.test(head)) {
      data = raw;
    }
    if (!data) continue;
    const txt = pdfContentText(data);
    if (txt && txt.length > 30) chunks.push(txt);
  }
  return chunks.join('\n').slice(0, 24000);
}

/**
 * 1.8.2.3：从 PDF 内容流里取文本。**必须保持线性，不能出现嵌套量词正则。**
 *
 * 旧实现是：
 *   /\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:[^\]]|\\.)*)\]\s*TJ/g
 * 这个写法对每个起点都要在「普通字符」和「反斜杠转义」之间枚举组合，
 * 一旦二进制流里有大量 `[` 却没有配对的 `]`（扫描版 PDF 的图片流、字体子集流
 * 正是这种），回溯次数就是指数级。实测一本 6.6MB 的扫描版 PDF：
 * 解压只用 1ms，随后这行正则让 Node 主线程 100% CPU 卡死 30 秒以上，
 * 期间不写任何日志、端口仍在 LISTEN 却不 accept——用户看到的就是
 * 「应用没崩、网页一直转圈」。
 *
 * 改为手写扫描：按字符线性前进，括号真正配平才取值，且有输入/输出上限。
 * 任何输入都是 O(n)。
 */
function pdfContentText(data) {
  const MAX_IN = 4 * 1024 * 1024;   // 单个流最多分析 4MB
  const MAX_OUT = 60000;            // 单个流最多保留 6 万字
  const MAX_LITERAL = 2000;         // 单个字符串字面量上限
  const MAX_ARRAY = 20000;          // 单个数组上限

  const n = Math.min(data.length, MAX_IN);
  const s = (n < data.length ? data.subarray(0, n) : data).toString('latin1');
  // 连文本操作符都没有的流（图片 / 字体 / 配色）直接排除
  if (s.indexOf('Tj') < 0 && s.indexOf('TJ') < 0) return '';

  const decode = str => {
    let r = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '\\') {
        const nx = str[++i];
        if (nx === 'n') r += '\n';
        else if (nx === 'r') r += '\r';
        else if (nx === 't') r += '\t';
        else if (nx === '(' || nx === ')' || nx === '\\') r += nx;
        else if (nx >= '0' && nx <= '7') {
          let oct = nx;
          while (oct.length < 3 && str[i + 1] >= '0' && str[i + 1] <= '7') oct += str[++i];
          r += String.fromCharCode(parseInt(oct, 8));
        }
      } else r += c;
    }
    return r;
  };

  // i 指向 '('；返回 { value, next }，括号不配平返回 null
  const readLiteral = i => {
    let j = i + 1, depth = 1;
    while (j < s.length && j - i <= MAX_LITERAL) {
      const c = s.charCodeAt(j);
      if (c === 92) { j += 2; continue; }              // 反斜杠：跳过被转义的字符
      if (c === 40) depth++;
      else if (c === 41) { depth--; if (!depth) return { value: s.slice(i + 1, j), next: j + 1 }; }
      j++;
    }
    return null;
  };

  // i 指向 '['；取出数组里所有 (...) 字面量，方括号不配平返回 null
  const readArray = i => {
    let j = i + 1, buf = '';
    while (j < s.length && j - i <= MAX_ARRAY) {
      const c = s.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 40) {
        const r = readLiteral(j);
        if (!r) return null;
        buf += decode(r.value);
        j = r.next;
        continue;
      }
      if (c === 93) return { value: buf, next: j + 1 };
      j++;
    }
    return null;
  };

  const skipWs = i => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break;
    }
    return i;
  };

  const out = [];
  let total = 0;
  let i = 0;
  while (i < s.length && total < MAX_OUT) {
    const c = s.charCodeAt(i);
    if (c === 40) {                                  // '(' ... ')' Tj
      const r = readLiteral(i);
      if (!r) break;                                 // 括号不配平：不再相信后面的数据
      i = r.next;
      const k = skipWs(i);
      if (s.charCodeAt(k) === 84 && s.charCodeAt(k + 1) === 106) {   // "Tj"
        out.push(decode(r.value)); total += r.value.length; i = k + 2; continue;
      }
      continue;
    }
    if (c === 91) {                                  // '[' ... ']' TJ
      const r = readArray(i);
      if (!r) break;
      i = r.next;
      const k = skipWs(i);
      if (s.charCodeAt(k) === 84 && s.charCodeAt(k + 1) === 74) {    // "TJ"
        if (r.value) { out.push(r.value); total += r.value.length; }
        i = k + 2; continue;
      }
      continue;
    }
    i++;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------- 纯文本 / Markdown ----------
function samplePlain(fp) {
  // 1.8.0：交给 textdoc 做编码自动识别（GBK / GB18030 / UTF-16 / UTF-8）
  const r = textdoc.readHeadText(fp, 512 * 1024, 400000);
  const lines = String(r.text || '').split(/\r?\n/).filter(l => l.trim());
  return lines.slice(0, 400).join('\n').slice(0, 24000);
}

// ---------- DOC / DOCX：前 N 段 ----------
function sampleWord(fp, ext, pages) {
  try {
    const paras = require('./worddoc').paragraphs(fp, ext);
    return paras.slice(0, Math.max(1, pages) * 30).map(p => p.text).join('\n').slice(0, 24000);
  } catch (_) { return ''; }
}

// ---------- PPTX：前 N 页文字 ----------
function samplePptx(fp, pages) {
  try {
    const zip = zipread.open(fp);
    const slides = zip.getEntries()
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => parseInt(a.entryName.match(/\d+/)[0]) - parseInt(b.entryName.match(/\d+/)[0]))
      .slice(0, pages);
    const out = [];
    for (const s of slides) {
      const doc = xml.parse(zip.readAsText(s));
      const texts = [];
      const walk = o => {
        if (o == null) return;
        if (typeof o === 'object') {
          for (const k in o) {
            if (k === 't') {
              const v = o[k];
              (Array.isArray(v) ? v : [v]).forEach(x => {
                const t = typeof x === 'object' ? String(x['#text'] ?? '') : String(x);
                if (t.trim()) texts.push(t);
              });
            } else walk(o[k]);
          }
        }
      };
      walk(doc);
      if (texts.length) out.push(texts.join('\n'));
    }
    return out.join('\n\n').slice(0, 20000);
  } catch (_) { return ''; }
}

// ---------- FB2 ----------
function sampleFb2(fp) {
  try {
    const buf = safeio.readHead(fp, safeio.MAX_TEXT_HEAD);
    let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    return htmlToText(text).slice(0, 20000);
  } catch (_) { return ''; }
}

/** 抽样入口：返回正文文本（最多约 2.4 万字，约等于前 10 页） */
function sampleText(filePath, ext, pages) {
  pages = pages || MAX_PAGES;
  const e = String(ext).toLowerCase();
  try {
    // zipread 只读所需条目，不再整本载入；仅对极端大的文件做兜底跳过
    if (['epub', 'pptx', 'pdf'].includes(e) && safeio.tooBig(filePath, safeio.MAX_SAMPLE_FILE)) return '';
    switch (e) {
      case 'epub': return sampleEpub(filePath, pages);
      case 'pdf': return samplePdf(filePath, pages);
      case 'pptx': return samplePptx(filePath, pages);
      case 'fb2': return sampleFb2(filePath);
      case 'txt': case 'md': case 'html': case 'htm': case 'rtf': return samplePlain(filePath);
      case 'doc': case 'docx': return sampleWord(filePath, e, pages);
      default: return '';
    }
  } catch (e) { return ''; }
}

/** 从抽样文本里提取可用于二次刮削的线索 */
function extractHints(text, fallback) {
  const clean = String(text || '').replace(/\r/g, '');
  const head = clean.slice(0, 6000);
  const hints = { title: '', author: '', isbn: '', queries: [], keywords: [] };

  // ISBN（10/13 位，允许连字符）
  const isbnM = clean.match(/\b(?:ISBN[：:\s-]*)?((?:97[89][-\s]?)?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?[\dXx])\b/);
  if (isbnM) {
    const digits = isbnM[1].replace(/[^\dXx]/g, '');
    if (digits.length === 10 || digits.length === 13) hints.isbn = digits;
  }

  const grab = re => { const m = head.match(re); return m ? m[1].trim().replace(/\s+/g, ' ') : ''; };
  hints.title = grab(/(?:书\s*名|Title|题名)\s*[：:]\s*(.{1,60}?)(?:\n|$)/i)
    || grab(/《([^》]{2,40})》/);
  hints.author = grab(/(?:作\s*者|Author|著\s*者)\s*[：:]\s*(.{1,40}?)(?:\n|$)/i)
    || grab(/([\u4e00-\u9fa5·]{2,6})\s*(?:著|编著|主编)/);

  // 关键词：书名号内容 + 高频 2~6 字中文词组
  const quoted = [...head.matchAll(/《([^》]{2,40})》/g)].map(m => m[1].trim());
  const freq = new Map();
  for (const m of head.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) {
    const w = m[0];
    if (/^(我们|他们|你们|什么|这个|那个|一个|没有|可以|已经|因为|所以|但是|如果|就是|这样|那样|自己|时候|现在|不是|还是|只是|并且|以及|对于|关于)$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const top = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);

  hints.keywords = [...new Set([...quoted.slice(0, 3), ...top])].slice(0, 8);

  // 生成候选查询词（按可信度排序）
  const qs = [];
  const push = q => {
    const v = String(q || '').replace(/\.(epub|pdf|mobi|azw3?|txt|md|pptx?|docx?|cbz|fb2)$/i, '').replace(/[_]+/g, ' ').trim();
    if (v && v.length >= 2 && !qs.includes(v)) qs.push(v.slice(0, 40));
  };
  if (hints.title) push(hints.title);
  for (const q of quoted.slice(0, 2)) push(q);
  if (hints.title && hints.author) push(hints.title + ' ' + hints.author);
  if (fallback && fallback.title) push(fallback.title);
  if (!hints.title && top.length >= 2) push(top.slice(0, 2).join(' '));
  if (top.length >= 3) push(top.slice(0, 3).join(' '));
  hints.queries = qs.slice(0, 4);

  // 抽样质量：中文/字母占比太低说明是扫描件或 CID 字体的乱码
  const meaningful = (clean.match(/[\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length;
  hints.quality = clean.length ? meaningful / clean.length : 0;
  hints.length = clean.length;
  return hints;
}

module.exports = { sampleText, extractHints, htmlToText, MAX_PAGES };
