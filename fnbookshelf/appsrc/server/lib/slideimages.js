// 1.6.0：从 PPTX 包里「逐页取图」——图片型 PPT 的每一页本身就是一张整页截图，
// 直接在服务端抽出并按页序合成 PDF，不需要 LibreOffice / Chrome / 任何第三方软件。
// 纯 Node 内置模块 + 项目自带的 zipread / fast-xml-parser。
'use strict';
const path = require('path');
const zlib = require('zlib');
const zipread = require('./zipread');
const { XMLParser } = require('fast-xml-parser');

const P = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  parseTagValue: false, trimValues: true, removeNSPrefix: true
});
const arr = v => v == null ? [] : (Array.isArray(v) ? v : [v]);

// ---------- 最小 PNG 编码（只为「无整页图的幻灯片」补一张空白页，保持页码不乱） ----------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 生成一张纯白 RGB PNG（8bit / colorType=2 / 非隔行） */
function blankPng(w, h) {
  w = Math.max(16, Math.min(1600, Math.round(w || 960)));
  h = Math.max(16, Math.min(1600, Math.round(h || 720)));
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) raw.fill(255, y * stride + 1, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function imageType(buf) {
  if (!buf || buf.length < 16) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  return ''; // webp/gif/emf：pdfwrite 不支持，交给空白页或浏览器兼容模式
}

function relMap(zip, slideNo) {
  const out = new Map();
  let e = null;
  try { e = zip.getEntry(`ppt/slides/_rels/slide${slideNo}.xml.rels`); } catch (_) { return out; }
  if (!e) return out;
  let doc;
  try { doc = P.parse(zip.readAsText(e)); } catch (_) { return out; }
  for (const r of arr(doc.Relationships && doc.Relationships.Relationship)) {
    const id = String(r['@_Id'] || '');
    const target = String(r['@_Target'] || '');
    if (!id || !target) continue;
    out.set(id, path.posix.normalize(path.posix.join('ppt/slides', target)));
  }
  return out;
}

/** 递归收集形状树里的 <p:pic>，取面积最大的那张（整页图） */
function collectPics(tree, out) {
  if (!tree || typeof tree !== 'object') return;
  for (const pic of arr(tree.pic)) {
    const blip = pic.blipFill && (pic.blipFill.blip || (Array.isArray(pic.blipFill.blip) ? pic.blipFill.blip[0] : null));
    const embed = blip && (blip['@_embed'] || blip['@_link']);
    const ext = pic.spPr && pic.spPr.xfrm && pic.spPr.xfrm.ext;
    const cx = Number((ext && ext['@_cx']) || 0), cy = Number((ext && ext['@_cy']) || 0);
    if (embed) out.push({ embed: String(embed), area: cx * cy });
  }
  for (const g of arr(tree.grpSp)) collectPics(g, out);
}

/**
 * 逐页取图
 * @returns {{width:number,height:number,pages:Array<{no:number,data:Buffer,type:string,from:string}>,blank:number,reason?:string}}
 */
function extractSlideImages(fp, opts) {
  opts = opts || {};
  const maxPages = Math.max(1, Math.min(400, Number(opts.maxPages) || 400));
  const maxPageBytes = Math.max(1, Number(opts.maxPageBytes) || 24 * 1024 * 1024);
  const zip = zipread.open(fp);
  let slideW = 1280, slideH = 720;
  try {
    const pe = zip.getEntry('ppt/presentation.xml');
    if (pe) {
      const d = P.parse(zip.readAsText(pe));
      const sz = d.presentation && d.presentation.sldSz;
      if (sz && sz['@_cx'] && sz['@_cy']) {
        slideW = Math.round(Number(sz['@_cx']) / 9525);
        slideH = Math.round(Number(sz['@_cy']) / 9525);
      }
    }
  } catch (_) {}
  const slideArea = slideW * slideH * 9525 * 9525;

  const entries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => Number(a.entryName.match(/(\d+)\.xml$/)[1]) - Number(b.entryName.match(/(\d+)\.xml$/)[1]))
    .slice(0, maxPages);
  if (!entries.length) return { width: slideW, height: slideH, pages: [], blank: 0, reason: '未找到幻灯片页' };

  const pages = [];
  let blank = 0;
  for (const e of entries) {
    const no = Number(e.entryName.match(/(\d+)\.xml$/)[1]);
    const rels = relMap(zip, no);
    let picked = null;
    try {
      const doc = P.parse(zip.readAsText(e));
      const tree = doc.sld && doc.sld.cSld && doc.sld.cSld.spTree;
      const pics = [];
      collectPics(tree, pics);
      pics.sort((a, b) => b.area - a.area);
      for (const p of pics) {
        const target = rels.get(p.embed);
        if (!target) continue;
        // 只认「整页/近整页」图片，避免把页眉小图标当成整页截图
        if (p.area < slideArea * 0.45) continue;
        let me = null;
        try { me = zip.getEntry(target); } catch (_) {}
        if (!me) continue;
        const data = zip.readFile(me);
        const type = imageType(data);
        if (!type || data.length > maxPageBytes) continue;
        picked = { data, type, from: target };
        break;
      }
    } catch (_) {}
    if (picked) pages.push({ no, data: picked.data, type: picked.type, from: picked.from });
    else {
      // 纯文字/矢量页：补一张空白页保持页码，并在结果里报告数量
      pages.push({ no, data: blankPng(slideW, slideH), type: 'png', from: 'blank' });
      blank++;
    }
  }
  return { width: slideW, height: slideH, pages, blank };
}

module.exports = { extractSlideImages, blankPng, imageType };
