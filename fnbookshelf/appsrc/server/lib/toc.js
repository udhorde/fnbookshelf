// 目录自动建立：EPUB(nav/ncx) / TXT·MD(章节正则) / PPTX(页标题) / PDF(前端 outline 兜底)
'use strict';
const fs = require('fs');
const path = require('path');
const safeio = require('./safeio');
const textdoc = require('./textdoc');
const zipread = require('./zipread');
const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, removeNSPrefix: true });

const stripTags = s => String(s || '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

function txt(v) { return v == null ? '' : (typeof v === 'object' ? String(v['#text'] ?? '') : String(v)); }
function arr(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

// ---------------- EPUB ----------------
function epubToc(fp) {
  const zip = zipread.open(fp);
  let opfPath = null;
  try {
    const c = xml.parse(zip.readAsText(zip.getEntry('META-INF/container.xml')));
    const rf = c.container.rootfiles.rootfile;
    opfPath = (Array.isArray(rf) ? rf[0] : rf)['@_full-path'];
  } catch (_) {}
  if (!opfPath) {
    const e = zip.getEntries().find(x => x.entryName.toLowerCase().endsWith('.opf'));
    if (!e) return { toc: [], source: 'none' };
    opfPath = e.entryName;
  }
  const dir = path.posix.dirname(opfPath);
  const doc = xml.parse(zip.readAsText(zip.getEntry(opfPath)));
  const items = arr(doc.package && doc.package.manifest && doc.package.manifest.item);
  const spine = arr(doc.package && doc.package.spine && doc.package.spine.itemref);
  const byId = new Map(items.map(i => [i['@_id'], i]));

  // spine 顺序 → 章节索引，便于按 href 定位
  const spineHrefs = spine.map(r => {
    const it = byId.get(r['@_idref']);
    return it ? path.posix.normalize(path.posix.join(dir, decodeURIComponent(it['@_href'] || ''))) : '';
  }).filter(Boolean);
  const indexOfHref = href => {
    const clean = String(href || '').split('#')[0];
    if (!clean) return -1;
    const full = path.posix.normalize(path.posix.join(dir, decodeURIComponent(clean)));
    let i = spineHrefs.indexOf(full);
    if (i < 0) i = spineHrefs.findIndex(h => h.endsWith(clean));
    return i;
  };

  const nav = items.find(i => /nav/.test(i['@_properties'] || '') || /(^|\/)nav\.x?html?$/i.test(i['@_href'] || ''));
  const out = [];

  // EPUB3 nav
  if (nav) {
    const p = path.posix.normalize(path.posix.join(dir, decodeURIComponent(nav['@_href'])));
    const entry = zip.getEntry(p);
    if (entry) {
      const html = zip.readAsText(entry);
      const navBlock = (html.match(/<nav[^>]*epub:type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i)
        || html.match(/<nav[^>]*type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i)
        || html.match(/<nav[\s\S]*?>([\s\S]*?)<\/nav>/i) || [])[1] || '';
      const parseList = (html, level) => {
        const items2 = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
        for (const it of items2) {
          const inner = it[1];
          const a = inner.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
          const span = inner.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
          const label = stripTags(a ? a[2] : (span ? span[1] : '')).slice(0, 80);
          if (a && label) {
            out.push({ label, href: a[1], level, idx: indexOfHref(a[1]), page: 0 });
          }
          const sub = inner.match(/<(ol|ul)[^>]*>([\s\S]*?)<\/\1>/i);
          if (sub && out.length < 600) parseList(sub[2], level + 1);
        }
      };
      const ol = html.match(/<(ol|ul)[^>]*>([\s\S]*?)<\/\1>/i);
      if (ol) parseList(ol[2], 1);
    }
  }

  // EPUB2 ncx
  if (!out.length) {
    const ncxItem = items.find(i => /ncx/.test(i['@_media-type'] || '') || /\.ncx$/i.test(i['@_href'] || ''));
    if (ncxItem) {
      const p = path.posix.normalize(path.posix.join(dir, decodeURIComponent(ncxItem['@_href'])));
      const entry = zip.getEntry(p);
      if (entry) {
        try {
          const ncx = xml.parse(zip.readAsText(entry));
          const navMap = ncx.ncx && ncx.ncx.navMap;
          const walk = (points, level) => {
            for (const pt of arr(points)) {
              if (!pt || typeof pt !== 'object') continue;
              const label = stripTags(txt(pt.navLabel && pt.navLabel.text)).slice(0, 80);
              const src = txt(pt.content && pt.content['@_src']);
              if (label) out.push({ label, href: src, level, idx: indexOfHref(src), page: 0 });
              if (pt.navPoint && out.length < 600) walk(pt.navPoint, level + 1);
            }
          };
          walk(navMap && navMap.navPoint, 1);
        } catch (_) {}
      }
    }
  }
  // 兜底：用 spine 文档的 <title> 或首行文字（限制累计读取量，避免长篇 EPUB 拖垮扫描）
  if (!out.length) {
    let budget = safeio.MAX_TOC_TEXT;
    for (let i = 0; i < Math.min(200, spineHrefs.length); i++) {
      const h = spineHrefs[i];
      const entry = zip.getEntry(h);
      if (!entry) continue;
      budget -= entry.size || 0;
      if (budget < 0) break;
      let html = '';
      try { html = zip.readAsText(entry); } catch (_) { continue; }
      const t = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      const h1 = stripTags((html.match(/<h[1-2][^>]*>([\s\S]*?)<\/h[1-2]>/i) || [])[1] || '');
      const label = (h1 || t || '').slice(0, 60);
      if (label) out.push({ label, href: h, level: 1, idx: i, page: 0 });
    }
  }
  return { toc: dedupe(out), source: out.length ? (nav ? 'epub-nav' : 'epub-ncx') : 'none' };
}

// ---------------- TXT / MD ----------------
const CH_RE = [
  [/^\s*(第[0-9零一二三四五六七八九十百千万两]+[章节回卷篇部集][^\n]{0,40})\s*$/, 1],
  [/^\s*((?:Chapter|CHAPTER|Part|PART)\s+[0-9IVXLCDM]+[^\n]{0,50})\s*$/, 1],
  [/^\s*(序[言章]?|前\s*言|引\s*子|楔\s*子|后\s*记|尾\s*声|附\s*录|目\s*录)\s*$/, 1],
  [/^\s*(#{1,3})\s+(.{1,60})$/, 2]
];

function textToc(fp, ext) {
  let text = '';
  try {
    // 目录标题只可能出现在开头若干 MB，绝不整本读入内存；编码由 textdoc 自动识别
    text = textdoc.readHeadText(fp, safeio.MAX_TEXT_HEAD, 0).text || '';
  } catch (_) { return { toc: [], source: 'none' }; }
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length && out.length < 600; i++) {
    const line = lines[i];
    if (!line || line.length > 80) continue;
    for (const [re, lvl] of CH_RE) {
      const m = line.match(re);
      if (m) {
        const label = (lvl === 2 ? m[2] : m[1]).trim().slice(0, 60);
        if (label.length < 2) break;
        out.push({ label, line: i, level: lvl === 2 ? Math.min(3, m[1].length) : 1, page: 0 });
        break;
      }
    }
  }
  // 目录型文件（开头就有大量「第X章」）不需要重复
  return { toc: dedupe(out), source: out.length ? 'text-heading' : 'none', lines: lines.length };
}

// ---------------- PPTX ----------------
function pptxToc(fp) {
  try {
    const zip = zipread.open(fp);
    const slides = zip.getEntries()
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => parseInt(a.entryName.match(/\d+/)[0]) - parseInt(b.entryName.match(/\d+/)[0]));
    const out = slides.map((s, i) => {
      let label = '';
      try {
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
                  if (t.trim()) texts.push(t.trim());
                });
              } else walk(o[k]);
            }
          }
        };
        walk(doc);
        label = texts[0] || '';
      } catch (_) {}
      return { label: (label || `第 ${i + 1} 页`).slice(0, 60), page: i + 1, level: 1 };
    });
    return { toc: out, source: 'pptx-title', pages: slides.length };
  } catch (_) { return { toc: [], source: 'none' }; }
}

// ---------------- DOC / DOCX：按标题样式建目录 ----------------
function wordToc(fp, ext) {
  try {
    const paras = require('./worddoc').paragraphs(fp, ext);
    const out = [];
    paras.forEach((p, i) => {
      if (!p.level || !p.text) return;
      out.push({ label: p.text.slice(0, 60), level: Math.min(3, p.level), line: i, page: 0 });
    });
    return { toc: dedupe(out).slice(0, 800), source: out.length ? 'word-heading' : 'none', lines: paras.length };
  } catch (_) { return { toc: [], source: 'none' }; }
}

// ---------------- 通用 ----------------
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const key = (it.label || '') + '|' + (it.href || it.line || it.page || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** 为书籍建立目录（PDF 交由前端用 pdf.js outline 补全） */
function buildToc(filePath, ext) {
  const e = String(ext || '').toLowerCase();
  try {
    // zipread 只读所需条目，不再整本载入；仅对极端大的文件做兜底跳过
    if (['epub', 'pptx', 'ppt'].includes(e) && safeio.tooBig(filePath, safeio.MAX_ZIP_FILE)) {
      return { toc: [], source: 'skipped-large' };
    }
    if (e === 'epub') return epubToc(filePath);
    if (e === 'txt' || e === 'md' || e === 'html' || e === 'htm') return textToc(filePath, e);
    if (e === 'pptx' || e === 'ppt') return pptxToc(filePath);
    if (e === 'doc' || e === 'docx') return wordToc(filePath, e);
    return { toc: [], source: 'none' };
  } catch (err) {
    return { toc: [], source: 'error', error: err.message };
  }
}

module.exports = { buildToc, epubToc, textToc, pptxToc };
