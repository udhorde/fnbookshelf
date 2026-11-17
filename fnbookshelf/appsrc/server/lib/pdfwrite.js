// 极简 PDF 写入器：把一批图片合成为 PDF（每页一张整图，即"图片版 PDF"）
// 只依赖 Node 内置模块，JPEG 直接 DCTDecode 嵌入，PNG 解码后 FlateDecode 嵌入。
'use strict';
const zlib = require('zlib');
const fs = require('fs');

/** 读取 JPEG 的尺寸与颜色分量数 */
function jpegInfo(buf) {
  if (!(buf[0] === 0xFF && buf[1] === 0xD8)) return null;
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/** 解码 PNG 为 RGB 原始像素 */
function pngDecode(buf) {
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)) return null;
  let pos = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h || bitDepth !== 8 || interlace !== 0) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (_) { return null; }
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xFF;
      else if (filter === 2) v = (v + b) & 0xFF;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xFF;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v + pr) & 0xFF;
      }
      line[x] = v;
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      let r, g, b2;
      if (colorType === 0 || colorType === 4) { r = g = b2 = line[x * channels]; }
      else if (colorType === 3) {
        const idx = line[x];
        if (palette && idx * 3 + 2 < palette.length) { r = palette[idx * 3]; g = palette[idx * 3 + 1]; b2 = palette[idx * 3 + 2]; }
        else r = g = b2 = 0;
      } else { r = line[x * channels]; g = line[x * channels + 1]; b2 = line[x * channels + 2]; }
      const o = (y * w + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b2;
    }
  }
  return { width: w, height: h, rgb: out };
}

/**
 * 用图片生成 PDF
 * @param {Array<{data:Buffer,type?:'jpeg'|'png'}>} images
 * @returns {Buffer}
 */
function imagesToPdf(images) {
  const chunks = [];
  let offset = 0;
  const push = b => { chunks.push(b); offset += b.length; };
  generatePdf(images, push);
  return Buffer.concat(chunks);
}

/** 1.6.0：流式写盘，逐页合成时不必把所有页面和整份 PDF 同时留在内存里 */
function imagesToPdfFile(images, outPath) {
  const fd = fs.openSync(outPath, 'w');
  let offset = 0;
  try {
    const push = b => {
      let done = 0;
      while (done < b.length) done += fs.writeSync(fd, b, done, b.length - done);
      offset += b.length;
    };
    generatePdf(images, push);
  } finally { fs.closeSync(fd); }
  return offset;
}

function generatePdf(images, push) {
  let offset = 0;
  const emit = b => { push(b); offset += b.length; };
  const offsets = [0];

  emit(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n%fnbookshelf-imagepdf\n', 'latin1'));

  const pageCount = images.length;

  // 1: Catalog, 2: Pages
  const pageIds = [];
  let nextId = 3;
  for (let i = 0; i < pageCount; i++) {
    const pageId = nextId++;
    const contentId = nextId++;
    const imgId = nextId++;
    pageIds.push({ pageId, contentId, imgId });
  }

  const addObj = (id, body, stream) => {
    offsets[id] = offset;
    let head = `${id} 0 obj\n${body}\n`;
    if (stream) {
      emit(Buffer.from(head, 'latin1'));
      emit(Buffer.from('stream\n', 'latin1'));
      emit(stream);
      emit(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      emit(Buffer.from(head + 'endobj\n', 'latin1'));
    }
  };

  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageIds.map(p => `${p.pageId} 0 R`).join(' ');
  addObj(2, `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>`);

  pageIds.forEach((p, i) => {
    const img = images[i];
    let info = null, stream = null, filter = '', cs = '/DeviceRGB';
    const type = img.type || (img.data[0] === 0xFF ? 'jpeg' : 'png');
    if (type === 'jpeg') {
      info = jpegInfo(img.data);
      if (!info) throw new Error('第 ' + (i + 1) + ' 页图片不是有效的 JPEG');
      stream = img.data;
      filter = '/DCTDecode';
      if (info.comps === 1) cs = '/DeviceGray';
      else if (info.comps === 4) { cs = '/DeviceCMYK'; filter = '/DCTDecode'; }
    } else {
      const dec = pngDecode(img.data);
      if (!dec) throw new Error('第 ' + (i + 1) + ' 页图片 PNG 解码失败');
      info = { width: dec.width, height: dec.height, comps: 3 };
      stream = zlib.deflateSync(dec.rgb, { level: 6 });
      filter = '/FlateDecode';
      cs = '/DeviceRGB';
    }
    // 页面尺寸按 96dpi 换算，限制最大 2000pt
    const pw = Math.min(2000, Math.max(72, info.width * 72 / 96));
    const ph = Math.min(2000, Math.max(72, info.height * 72 / 96));
    const content = Buffer.from(`q\n${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`, 'latin1');
    addObj(p.contentId, `<< /Length ${content.length} >>`, content);
    addObj(p.pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${p.imgId} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${p.contentId} 0 R >>`);
    addObj(p.imgId, `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
      `/ColorSpace ${cs} /BitsPerComponent 8 /Filter ${filter} /Length ${stream.length} >>`, stream);
  });

  // xref
  const maxId = nextId - 1;
  const xrefStart = offset;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    const off = offsets[id] || 0;
    xref += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  emit(Buffer.from(xref, 'latin1'));
  emit(Buffer.from(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, 'latin1'));
}

module.exports = { imagesToPdf, imagesToPdfFile, jpegInfo, pngDecode };
