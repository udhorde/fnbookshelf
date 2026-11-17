// 从 PDF 首页提取图片，作为「刮削不到封面」时的兜底封面。
//
// 家庭书库里绝大多数是一本书一个 PDF，且相当比例是扫描版 / PPT 转换版：
// 这类 PDF 的每一页本身就是一张 JPEG（/DCTDecode），把第一页那张图取出来就是现成的封面，
// 不需要跑任何图像渲染器（NAS 上没有 poppler / mupdf，也不能装）。
//
// 做法：线性扫过文件里的每个 `obj … endobj`，挑出字典里同时有 /Subtype /Image 与
// /DCTDecode 的对象，取第一张「体积像封面」的 JPEG 直接落盘。文件顺序基本就是页序，
// 所以第一张通常就是封面页。
//
// 防坑：这里只做「按字节找 stream」，不做任何回溯型正则；扫描范围有上限，
// 大 PDF 也只读前 32MB（1.8.2.3 那次 PDF 正则灾难回溯的教训）。
'use strict';
const fs = require('fs');

const MAX_SCAN = 32 * 1024 * 1024;   // 最多读 32MB
const MIN_SIDE = 170;                // 宽高都要像一页纸（小于这个的多半是 logo / 装饰图）
const MIN_BYTES = 6000;              // 太小的是图标，不是封面

/** 从 buf 的 [from, to) 里找 JPEG 的 SOI…EOI，返回裁剪后的 Buffer */
function trimJpeg(buf) {
  const soi = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (soi < 0) return null;
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (eoi <= soi + 4) return null;
  return buf.slice(soi, eoi + 2);
}

/** 在字典文本里取数字参数 */
function num(dict, key) {
  const m = dict.match(new RegExp('/' + key + '\\s+(\\d+)'));
  return m ? Number(m[1]) : 0;
}

/**
 * 找第一张可用的图片对象。
 * @returns {{start:number,end:number,width:number,height:number}|null}
 */
function findFirstImage(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const objAt = buf.indexOf('obj', pos);
    if (objAt < 0) break;
    // 「obj」必须是个独立的词（前面是数字+空白）
    const before = buf.slice(Math.max(0, objAt - 24), objAt).toString('latin1');
    if (!/\d\s*$/.test(before)) { pos = objAt + 3; continue; }
    const dictEnd = buf.indexOf('stream', objAt);
    if (dictEnd < 0) break;
    const dict = buf.slice(objAt, dictEnd).toString('latin1');
    if (!/\/Subtype\s*\/Image/.test(dict) || !/\/DCTDecode/.test(dict)) {
      pos = dictEnd + 6;
      continue;
    }
    const w = num(dict, 'Width'), h = num(dict, 'Height');
    // stream 后面可能跟 \r\n 或 \n
    let s = dictEnd + 6;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const end = buf.indexOf('endstream', s);
    if (end < 0) break;
    const len = end - s;
    if (len >= MIN_BYTES && w >= MIN_SIDE && h >= MIN_SIDE) {
      const jpg = trimJpeg(buf.slice(s, end));
      if (jpg && jpg.length >= MIN_BYTES) return { jpg, width: w, height: h };
    }
    pos = end + 9;
  }
  return null;
}

/**
 * 把 PDF 首页图片写到 coversDir/<coverId>.jpg
 * @returns {string|null} '.jpg' 或 null（没找到 / 写失败）
 */
function extractToCover(pdfPath, coversDir, coverId) {
  let fd = null;
  try {
    const st = fs.statSync(pdfPath);
    const size = Math.min(st.size, MAX_SCAN);
    if (size < 2048) return null;
    fd = fs.openSync(pdfPath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    let hit = null;
    try { hit = findFirstImage(buf); } catch (_) { hit = null; }
    if (!hit) {
      // 兜底：没有对象字典信息时，退回「文件里第一段足够大的 JPEG」
      const jpg = trimJpeg(buf);
      if (jpg && jpg.length >= 20000) hit = { jpg };
    }
    if (!hit) return null;
    const out = require('path').join(coversDir, coverId + '.jpg');
    fs.writeFileSync(out, hit.jpg);
    return '.jpg';
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

module.exports = { extractToCover, findFirstImage };
