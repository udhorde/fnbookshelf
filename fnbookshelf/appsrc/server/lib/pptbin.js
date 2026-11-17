// 二进制 .ppt（PowerPoint 97-2003, OLE/CFB 复合文档）解析器 —— 1.6.2 重写
// 不依赖 LibreOffice / OnlyOffice，提供两条能力：
//   ① extractPptImages()：从 Pictures 流里取出每页幻灯片引用的整页图片（扫描版绘本的每一页本来就是一张图），
//      按幻灯片顺序返回，交给后台任务合成图片版 PDF；
//   ② parsePpt()：给「浏览器渲染（兼容模式）」用的模型（图片 + 文字），没有图片的纯文字页仍按文本还原。
// 关键点：pib（FOPT 0x0104）是 Pictures 流里 1 起的图片序号，用它把图片对回具体页码，
// 而不是靠「图片流顺序」猜页码，避免同一张图被多页复用或页序错位。
'use strict';
const fs = require('fs');
const path = require('path');
const { jpegInfo } = require('./pdfwrite');

const REC = {
  SLIDE: 0x03EE,        // Slide 容器
  DOC: 0x03E8,          // Document 容器
  DOC_ATOM: 0x03E9,     // DocumentAtom（含幻灯片尺寸）
  FOPT: 0xF00B,         // OfficeArtFOPT（形状属性，pib 在其中）
  TEXT_CHARS: 0x0FA0,   // TextCharsAtom（UTF-16LE）
  TEXT_BYTES: 0x0FA8    // TextBytesAtom（单字节，中文老文档多为 GBK）
};

const PIB_ID = 0x0104;  // 图片序号属性
const MASTER_UNITS_PER_PX = 6; // 576/英寸 ÷ 96dpi

// ---------- CFB（复合文件）解析 ----------
function readCfbStream(buf, streamName) {
  // 校验签名 D0 CF 11 E0 A1 B1 1A E1
  if (buf.length < 512 || buf[0] !== 0xd0 || buf[1] !== 0xcf || buf[2] !== 0x11 || buf[3] !== 0xe0) return null;
  const sectorShift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  const sectorSize = 1 << sectorShift;       // 通常 512
  const miniSectorSize = 1 << miniShift;     // 64
  const miniCutoff = buf.readInt32LE(0x38);  // 通常 4096
  const numFat = buf.readInt32LE(0x2c);
  const firstDirSector = buf.readInt32LE(0x30);

  // DIFAT：前 109 个 FAT 扇区号在头部，更多在 DIFAT 链中
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readInt32LE(0x4c + i * 4);
    if (s >= 0 && s < 0xffffff00) fatSectors.push(s);
  }
  let difatSector = buf.readInt32LE(0x44);
  const seenDifat = new Set();
  while (difatSector >= 0 && difatSector < 0xffffff00 && !seenDifat.has(difatSector) && fatSectors.length < numFat + 128) {
    seenDifat.add(difatSector);
    const off = 512 + difatSector * sectorSize;
    if (off + sectorSize > buf.length) break;
    const per = Math.floor(sectorSize / 4) - 1;
    for (let i = 0; i < per; i++) {
      const s = buf.readInt32LE(off + i * 4);
      if (s >= 0 && s < 0xffffff00) fatSectors.push(s);
    }
    difatSector = buf.readInt32LE(off + sectorSize - 4);
  }

  // FAT 表：sector -> next
  const fat = [];
  for (const s of fatSectors.slice(0, numFat)) {
    const off = 512 + s * sectorSize;
    if (off + sectorSize > buf.length) continue;
    for (let i = 0; i < sectorSize / 4; i++) fat.push(buf.readInt32LE(off + i * 4));
  }
  const secOff = s => 512 + s * sectorSize;
  const readChain = (start) => {
    const parts = [];
    let s = start;
    const guard = new Set();
    while (s >= 0 && s < fat.length && fat[s] !== 0xfffffffe && fat[s] !== 0xffffffff && !guard.has(s)) {
      guard.add(s);
      parts.push(buf.slice(secOff(s), secOff(s) + sectorSize));
      s = fat[s];
    }
    return Buffer.concat(parts);
  };

  // 目录链
  const dirBuf = readChain(firstDirSector);
  const entries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameLen = dirBuf.readUInt16LE(off + 0x40);
    const type = dirBuf[off + 0x42];
    if (type === 0) continue;
    let name = '';
    try { name = dirBuf.slice(off, off + Math.max(0, nameLen - 2)).toString('utf16le'); } catch (_) {}
    entries.push({
      name,
      type, // 1=storage 2=stream 5=root
      start: dirBuf.readInt32LE(off + 0x74),
      size: Number(dirBuf.readBigUInt64LE(off + 0x78))
    });
  }
  const target = entries.find(e => e.type === 2 && e.name === streamName);
  if (!target) return null;
  if (target.size > 400 * 1024 * 1024) return null; // 防御：异常尺寸直接放弃

  // 小流（< miniCutoff）走 mini FAT + 根存储的 mini 流
  if (target.size < miniCutoff) {
    const root = entries.find(e => e.type === 5);
    if (!root) return null;
    // mini FAT 链
    const firstMiniFat = buf.readInt32LE(0x3c);
    const miniFat = [];
    const mfChain = readChain(firstMiniFat);
    for (let i = 0; i + 4 <= mfChain.length; i += 4) miniFat.push(mfChain.readInt32LE(i));
    const miniStream = readChain(root.start);
    const parts = [];
    let s = target.start;
    const guard = new Set();
    while (s >= 0 && s < miniFat.length && miniFat[s] !== 0xfffffffe && miniFat[s] !== 0xffffffff && !guard.has(s)) {
      guard.add(s);
      parts.push(miniStream.slice(s * miniSectorSize, (s + 1) * miniSectorSize));
      s = miniFat[s];
    }
    return Buffer.concat(parts).slice(0, target.size);
  }
  return readChain(target.start).slice(0, target.size);
}

// ---------- PowerPoint 记录遍历 ----------
function recsOf(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const verInst = buf.readUInt16LE(off);
    const type = buf.readUInt16LE(off + 2);
    const len = buf.readUInt32LE(off + 4);
    if (off + 8 + len > buf.length) break;
    out.push({ type, ver: verInst & 0x000f, inst: verInst >> 4, data: buf.subarray(off + 8, off + 8 + len) });
    off += 8 + len;
  }
  return out;
}

function walkRecords(buf, onAtom, depth) {
  depth = depth || 0;
  if (depth > 10) return;
  for (const r of recsOf(buf)) {
    if (r.ver === 0x0f) walkRecords(r.data, onAtom, depth + 1);
    else onAtom(r.type, r.data, r.inst);
  }
}

/** OfficeArtFOPT：6 字节一组的属性表，解析出 pib 等数值属性 */
function foptProps(data) {
  const props = {};
  let off = 0;
  while (off + 6 <= data.length) {
    const w = data.readUInt16LE(off);
    const id = w & 0x3FFF;
    const fComplex = (w >> 15) & 1;
    if (!fComplex) props[id] = data.readUInt32LE(off + 2);
    off += 6;
  }
  return props;
}

const gbkDecoder = (() => { try { return new TextDecoder('gbk'); } catch (_) { return null; } })();

function decodeAtom(type, data) {
  if (type === REC.TEXT_CHARS) {
    let s = '';
    for (let i = 0; i + 1 < data.length; i += 2) {
      const c = data.readUInt16LE(i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (type === REC.TEXT_BYTES) {
    let end = data.length;
    for (let i = 0; i < data.length; i++) { if (data[i] === 0) { end = i; break; } }
    const raw = data.slice(0, end);
    if (gbkDecoder) {
      try {
        const s = gbkDecoder.decode(raw);
        if (s && !/\u0000/.test(s)) return s;
      } catch (_) {}
    }
    return raw.toString('latin1');
  }
  return '';
}

// ---------- 图片（BLIP）提取 ----------
/** 在 BLIP / FBSE 记录里定位内嵌图片本体（前 300 字节里找 JPEG/PNG 魔数） */
function blipImage(data) {
  if (!data || data.length < 32) return null;
  const lim = Math.min(300, data.length - 4);
  for (let i = 0; i < lim; i++) {
    if (data[i] === 0xFF && data[i + 1] === 0xD8 && data[i + 2] === 0xFF) {
      let end = data.length;
      for (let j = data.length - 2; j > i; j--) {
        if (data[j] === 0xFF && data[j + 1] === 0xD9) { end = j + 2; break; }
      }
      const img = data.subarray(i, end);
      const info = jpegInfo(img);
      if (!info) return null;
      return { type: 'jpeg', data: img, width: info.width, height: info.height };
    }
    if (data[i] === 0x89 && data[i + 1] === 0x50 && data[i + 2] === 0x4E && data[i + 3] === 0x47) {
      const img = data.subarray(i);
      const dim = pngSize(img);
      return { type: 'png', data: img, width: dim.width, height: dim.height };
    }
  }
  return null;
}

function pngSize(buf) {
  try { return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; }
  catch (_) { return { width: 0, height: 0 }; }
}

/** Pictures 流 → 有序图片数组（顺序即 pib：数组下标 0 对应 pib=1） */
function parseBlips(picsBuf) {
  const out = [];
  if (!picsBuf || !picsBuf.length) return out;
  const visit = (list, depth) => {
    for (const r of list) {
      if (r.ver === 0x0f && depth < 3) { visit(recsOf(r.data), depth + 1); continue; }
      const img = blipImage(r.data);
      if (img) out.push(img);
    }
  };
  visit(recsOf(picsBuf), 0);
  return out;
}

/** 幻灯片尺寸（像素，按 96dpi 换算） */
function slideSizeOf(docBuf) {
  let w = 0, h = 0;
  for (const r of recsOf(docBuf)) {
    if (r.type !== REC.DOC) continue;
    for (const a of recsOf(r.data)) {
      if (a.type !== REC.DOC_ATOM || a.data.length < 8) continue;
      const sx = a.data.readInt32LE(0), sy = a.data.readInt32LE(4);
      if (sx > 0 && sy > 0 && sx < 100000 && sy < 100000) {
        w = Math.round(sx / MASTER_UNITS_PER_PX);
        h = Math.round(sy / MASTER_UNITS_PER_PX);
      }
      break;
    }
    if (w) break;
  }
  if (!w || !h) { w = 960; h = 720; }
  return { width: w, height: h };
}

/**
 * 解析整本 .ppt 的骨架：按「Document 块」切分幻灯片（多块是增量保存的修订版，取幻灯片最多的那块），
 * 每页取出 pib（对应图片）与文本。
 * @returns {{width:number,height:number,slides:Array<{no:number,pib:number,texts:string[]}>,blips:Array,reason?:string}|null}
 */
function parseDeck(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return null; }
  if (buf.length < 512) return null;
  const doc = readCfbStream(buf, 'PowerPoint Document');
  if (!doc) return { width: 960, height: 720, slides: [], blips: [], reason: '不是 PowerPoint 97-2003 复合文档' };

  const pics = readCfbStream(buf, 'Pictures');
  const blips = parseBlips(pics);
  const { width, height } = slideSizeOf(doc);

  // 按 Document 块分组；孤儿幻灯片并入第一个块
  const top = recsOf(doc);
  const blocks = [];
  let cur = null;
  for (const r of top) {
    if (r.type === REC.DOC) { cur = { slides: [] }; blocks.push(cur); continue; }
    if (r.type === REC.SLIDE) {
      if (!cur) { cur = { slides: [] }; blocks.push(cur); }
      cur.slides.push(r);
    }
  }
  let main = null;
  for (const b of blocks) if (!main || b.slides.length > main.slides.length) main = b;
  const slideRecs = main ? main.slides : [];

  const slides = [];
  slideRecs.forEach((sr, i) => {
    const texts = [];
    let pib = 0;
    walkRecords(sr.data, (type, data) => {
      if (type === REC.TEXT_CHARS || type === REC.TEXT_BYTES) {
        const s = decodeAtom(type, data);
        if (!s) return;
        for (const para of s.split(/[\r\v]+/)) {
          const p = para.replace(/\u000b/g, ' ').trim();
          if (p) texts.push(p);
        }
        return;
      }
      if (type === REC.FOPT && !pib) {
        const props = foptProps(data);
        const v = props[PIB_ID];
        if (v && v > 0 && v <= blips.length) pib = v;
      }
    });
    slides.push({ no: i + 1, pib, texts });
  });

  return { width, height, slides, blips };
}

/**
 * 逐页取图（后台转换用）
 * 纯文字页没有整页图片，直接跳过（绘本的封面/标题页常为纯文字，留白页反而影响阅读），并报告跳过数量。
 * @returns {{width:number,height:number,pages:Array<{no:number,data:Buffer,type:string,from:string}>,skipped:number,reason?:string}}
 */
function extractPptImages(filePath, opts) {
  opts = opts || {};
  const maxPages = Math.max(1, Math.min(400, Number(opts.maxPages) || 400));
  const maxPageBytes = Math.max(1, Number(opts.maxPageBytes) || 24 * 1024 * 1024);
  const deck = parseDeck(filePath);
  if (!deck) return { width: 960, height: 720, pages: [], skipped: 0, reason: '无法读取 .ppt 文件结构' };
  if (!deck.slides.length) return { width: deck.width, height: deck.height, pages: [], skipped: 0, reason: '未找到幻灯片页' };

  const pages = [];
  let skipped = 0;
  for (const s of deck.slides.slice(0, maxPages)) {
    const img = s.pib ? deck.blips[s.pib - 1] : null;
    if (!img || !img.data || img.data.length < 512 || img.data.length > maxPageBytes) { skipped++; continue; }
    pages.push({ no: s.no, data: img.data, type: img.type, from: 'pib#' + s.pib });
  }
  return { width: deck.width, height: deck.height, pages, skipped };
}

/** 按 96dpi 的页面尺寸把图片等比缩放并居中 */
function fitBox(imgW, imgH, pageW, pageH) {
  if (!imgW || !imgH) return { x: 0, y: 0, w: pageW, h: pageH };
  const k = Math.min(pageW / imgW, pageH / imgH);
  const w = Math.max(1, Math.round(imgW * k));
  const h = Math.max(1, Math.round(imgH * k));
  return { x: Math.round((pageW - w) / 2), y: Math.round((pageH - h) / 2), w, h };
}

/**
 * 兼容模式渲染模型（与 pptx.parsePptx 同构）
 * @param {string} filePath
 * @param {{mediaDir?:string, bookId?:string, mediaUrlBase?:string}} [opts]
 */
function parsePpt(filePath, opts) {
  opts = opts || {};
  const deck = parseDeck(filePath);
  if (!deck) return { width: 960, height: 720, slides: [] };
  const W = deck.width, H = deck.height;
  const withImages = !!(opts.mediaDir && deck.blips.length);
  if (withImages) { try { fs.mkdirSync(opts.mediaDir, { recursive: true }); } catch (_) {} }

  const slides = [];
  for (const s of deck.slides) {
    const items = [];
    const img = s.pib ? deck.blips[s.pib - 1] : null;
    if (img && withImages) {
      const ext = img.type === 'png' ? '.png' : '.jpg';
      const name = `${opts.bookId || 'x'}_ppt_s${s.no}${ext}`;
      const dest = path.join(opts.mediaDir, name);
      if (!fs.existsSync(dest)) {
        try { fs.writeFileSync(dest, img.data); } catch (_) { /* 写不进去就退回纯文字页 */ }
      }
      if (fs.existsSync(dest)) {
        const box = fitBox(img.width, img.height, W, H);
        const base = opts.mediaUrlBase || '/api/slidesmedia';
        items.push(Object.assign({ type: 'image', src: `${base}/${encodeURIComponent(name)}` }, box));
      }
    }
    // 纯文字页（标题页 / 版权页）：沿用文本版式，保证兼容模式下也有内容
    if (!items.length && s.texts.length) {
      const title = s.texts[0];
      const body = s.texts.slice(1);
      items.push({
        type: 'text', x: 48, y: Math.round(H * 0.32), w: W - 96, h: 80, anchor: 'ctr',
        paras: [{ text: title, size: Math.max(24, Math.round(H * 0.062)), bold: true, color: '#1a2a44', align: 'center' }]
      });
      if (body.length) {
        items.push({
          type: 'text', x: 72, y: Math.round(H * 0.5), w: W - 144, h: Math.round(H * 0.42), anchor: 't',
          paras: body.slice(0, 22).map(t => ({ text: t.length > 90 ? t.slice(0, 90) + '…' : t, size: 17, color: '#2c3a4e', align: 'left', bullet: true }))
        });
      }
    }
    if (!items.length) continue;
    slides.push({ no: s.no, bg: '#ffffff', items });
  }

  // 一张图都没有、也没有文字：返回空模型，由前端给出「下载原文件」的出口
  return { width: W, height: H, slides, pictures: deck.blips.length };
}

module.exports = { parsePpt, extractPptImages, parseDeck, readCfbStream };
