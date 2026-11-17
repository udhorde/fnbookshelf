// PPTX 解析：把每页幻灯片还原为「绝对定位的图形 + 文本 + 图片」模型，
// 供浏览器端逐页栅格化为图片，再由服务端合成为图片版 PDF。
// 不依赖 LibreOffice、不依赖二进制 .ppt 解析。
'use strict';
const fs = require('fs');
const path = require('path');
const zipread = require('./zipread');
const { XMLParser } = require('fast-xml-parser');

const P = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  parseTagValue: false, trimValues: false, removeNSPrefix: true
});

const EMU_PER_PX = 9525;
const px = v => Number(v || 0) / EMU_PER_PX;

const SCHEME = {
  bg1: '#ffffff', lt1: '#ffffff', bg2: '#f2f2f2', lt2: '#f2f2f2',
  tx1: '#000000', dk1: '#000000', tx2: '#44546a', dk2: '#44546a',
  accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000',
  accent5: '#5b9bd5', accent6: '#70ad47', hlink: '#0563c1', folHlink: '#954f72'
};

function colorOf(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.srgbClr && node.srgbClr['@_val']) return '#' + String(node.srgbClr['@_val']).slice(0, 6);
  if (node.schemeClr && node.schemeClr['@_val']) return SCHEME[node.schemeClr['@_val']] || '';
  if (node.sysClr && node.sysClr['@_lastClr']) return '#' + String(node.sysClr['@_lastClr']).slice(0, 6);
  if (node.gradFill) {
    const gs = arr(node.gradFill.gsLst && node.gradFill.gsLst.gs);
    for (const g of gs) { const c = colorOf(g); if (c) return c; }
  }
  if (node.prstClr) {
    const map = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00b050', blue: '#0070c0', gray: '#808080', dkGray: '#404040', ltGray: '#c0c0c0' };
    return map[node.prstClr['@_val']] || '';
  }
  return '';
}

function arr(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
function txt(v) { return v == null ? '' : (typeof v === 'object' ? String(v['#text'] ?? '') : String(v)); }

/** 取形状填充色（无填充返回透明） */
function fillOf(spPr) {
  if (!spPr) return '';
  if (spPr.noFill) return '';
  if (spPr.solidFill) return colorOf(spPr.solidFill);
  if (spPr.gradFill) return colorOf(spPr.gradFill);
  if (spPr.blipFill) return '';
  return '';
}

/** 文本段落 → {text, size, bold, italic, color, align, level, bullet} */
function paragraphsOf(txBody) {
  const out = [];
  for (const p of arr(txBody && txBody.p)) {
    if (!p || typeof p !== 'object') continue;
    const pPr = p.pPr || {};
    const runs = arr(p.r).concat(arr(p.fld));
    let text = '';
    let rPr = {};
    for (const r of runs) {
      if (!r || typeof r !== 'object') continue;
      if (!rPr || !Object.keys(rPr).length) rPr = r.rPr || {};
      text += txt(r.t);
    }
    if (!text && p.endParaRPr && p.endParaRPr['@_sz']) continue;
    if (!text.trim()) { if (text) out.push({ text: ' ', size: 0 }); continue; }
    const sz = Number((rPr && rPr['@_sz']) || (pPr.defRPr && pPr.defRPr['@_sz']) || 1800);
    const color = colorOf(rPr && rPr.solidFill) || colorOf(pPr.defRPr && pPr.defRPr.solidFill) || '';
    const latin = (rPr && rPr.latin && rPr.latin['@_typeface']) || '';
    out.push({
      text,
      size: Math.max(6, Math.min(96, sz / 100)),
      bold: String((rPr && rPr['@_b']) || '') === '1',
      italic: String((rPr && rPr['@_i']) || '') === '1',
      color,
      font: latin || '',
      align: pPr['@_algn'] === 'ctr' ? 'center' : (pPr['@_algn'] === 'r' ? 'right' : 'left'),
      level: Number(pPr['@_lvl'] || 0),
      bullet: !!(pPr.buChar || pPr.buAutoNum) && !pPr.buNone,
      spaceBef: Number(pPr['@_spcBef'] ? 1 : 0)
    });
  }
  return out;
}

/** 解析一个形状元素（kind: sp|pic|grpSp|graphicFrame，含组合递归） */
function shapeOf(kind, node, ctx, depth) {
  if (!node || typeof node !== 'object' || depth > 4) return [];
  const out = [];
  const xfrm = node.spPr && node.spPr.xfrm;
  let x = 0, y = 0, w = 0, h = 0, hasFrame = false;
  if (xfrm && xfrm.off && xfrm.ext) {
    x = px(xfrm.off['@_x']); y = px(xfrm.off['@_y']);
    w = px(xfrm.ext['@_cx']); h = px(xfrm.ext['@_cy']);
    hasFrame = true;
  }
  const rot = xfrm && xfrm['@_rot'] ? Number(xfrm['@_rot']) / 60000 : 0;

  // 组合
  if (kind === 'grpSp') {
    for (const [k, child] of [['sp', node.sp], ['pic', node.pic], ['grpSp', node.grpSp], ['graphicFrame', node.graphicFrame]]) {
      for (const c of arr(child)) {
        const items = shapeOf(k, c, ctx, depth + 1);
        if (hasFrame) for (const it of items) { it.x += x; it.y += y; }
        out.push(...items);
      }
    }
    return out;
  }

  // 图片
  if (kind === 'pic') {
    const blip = node.blipFill && node.blipFill.blip;
    const rid = blip && blip['@_embed'];
    const src = rid && ctx.rels.get(rid);
    if (src && hasFrame && w > 1 && h > 1) out.push({ type: 'image', x, y, w, h, src, rot });
    return out;
  }

  // 形状：色块 + 文本
  if (kind === 'sp' && node.spPr) {
    const fill = fillOf(node.spPr);
    const line = node.spPr.ln;
    const stroke = line && !line.noFill ? (colorOf(line.solidFill) || '') : '';
    const strokeW = line && line['@_w'] ? Math.max(0.5, px(line['@_w']) * 0.75) : 0;
    const geom = node.spPr.prstGeom && node.spPr.prstGeom['@_prst'];
    const paras = paragraphsOf(node.txBody);
    const hasText = paras.some(p => p.text && p.text.trim());
    if (fill && hasFrame && w > 1 && h > 1) {
      out.push({ type: 'rect', x, y, w, h, fill, stroke, strokeW, round: geom === 'roundRect', ellipse: geom === 'ellipse', rot });
    }
    if (hasText) {
      const bodyPr = node.txBody.bodyPr || {};
      out.push({
        type: 'text', x: x + 4, y: y + 2, w: Math.max(24, w - 8), h: Math.max(16, h - 4),
        paras, anchor: bodyPr['@_anchor'] || 't', wrap: bodyPr['@_wrap'] || 'square', rot
      });
    }
    return out;
  }

  // 表格 / 图表：取内部所有文字，按区块排版
  if (kind === 'graphicFrame') {
    const gd = node.graphic && node.graphic.graphicData;
    const tbl = gd && gd.tbl;
    if (tbl && hasFrame) {
      const rows = arr(tbl.tr).map(tr => arr(tr.tc).map(tc => paragraphsOf(tc.txBody).map(p => p.text).join(' ')));
      if (rows.length) out.push({ type: 'table', x, y, w, h, rows, size: 14 });
    }
    return out;
  }
  return out;
}

/**
 * 解析 PPTX
 * @param {string} fp 文件路径
 * @param {{mediaDir:string, bookId:string, mediaUrlBase:string, token:string}} opts
 */
function parsePptx(fp, opts) {
  const zip = zipread.open(fp);
  const pres = (() => {
    const e = zip.getEntry('ppt/presentation.xml');
    return e ? P.parse(zip.readAsText(e)) : {};
  })();
  const sldSz = pres.presentation && pres.presentation.sldSz;
  const width = sldSz ? Math.round(px(sldSz['@_cx'])) : 1280;
  const height = sldSz ? Math.round(px(sldSz['@_cy'])) : 720;

  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => parseInt(a.entryName.match(/\d+/)[0]) - parseInt(b.entryName.match(/\d+/)[0]));

  const mediaDir = opts.mediaDir;
  fs.mkdirSync(mediaDir, { recursive: true });

  const slides = [];
  for (const entry of slideEntries) {
    const no = parseInt(entry.entryName.match(/\d+/)[0]);
    // 关系表：rId -> 图片 URL
    const rels = new Map();
    let relEntry = null;
    try { relEntry = zip.getEntry(`ppt/slides/_rels/slide${no}.xml.rels`); } catch (_) {}
    if (relEntry) {
      const rdoc = P.parse(zip.readAsText(relEntry));
      for (const r of arr(rdoc.Relationships && rdoc.Relationships.Relationship)) {
        const target = String(r['@_Target'] || '');
        const type = String(r['@_Type'] || '');
        if (!/image/i.test(type)) continue;
        const full = path.posix.normalize(path.posix.join('ppt/slides', target));
        const me = zip.getEntry(full);
        if (!me) continue;
        const ext = (path.extname(full) || '.png').toLowerCase().replace('.jpeg', '.jpg');
        const name = `${opts.bookId}_s${no}_${String(r['@_Id']).replace(/[^\w-]/g, '')}${ext}`;
        const dest = path.join(mediaDir, name);
        if (!fs.existsSync(dest)) {
          try { fs.writeFileSync(dest, zip.readFile(me)); } catch (_) { continue; }
        }
        rels.set(r['@_Id'], `${opts.mediaUrlBase}/${encodeURIComponent(name)}`);
      }
    }

    let doc = {};
    try { doc = P.parse(zip.readAsText(entry)); } catch (_) { continue; }
    const cSld = doc.sld && doc.sld.cSld;
    if (!cSld) continue;
    const spTree = cSld.spTree || {};

    let bg = '#ffffff';
    if (cSld.bg && cSld.bg.bgPr) {
      const c = colorOf(cSld.bg.bgPr.solidFill);
      if (c) bg = c;
    }

    const items = [];
    for (const [kind, list] of [['sp', spTree.sp], ['pic', spTree.pic], ['grpSp', spTree.grpSp], ['graphicFrame', spTree.graphicFrame]]) {
      for (const node of arr(list)) {
        try { items.push(...shapeOf(kind, node, { rels }, 0)); } catch (_) {}
      }
    }
    slides.push({ no, bg, items });
  }
  return { width, height, slides };
}

module.exports = { parsePptx, EMU_PER_PX };
