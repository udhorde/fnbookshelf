// 安全读取：扫描/刮削路径上禁止把整本大文件同步读进内存
// ZIP 类文件已改由 zipread.js 按需读取，不再整本载入；这里的阈值只作为极端文件兜底。
'use strict';
const fs = require('fs');

const MAX_TEXT_HEAD = 4 * 1024 * 1024;      // TXT/FB2 目录与元数据只读前 4MB
const MAX_PDF_HEAD = 8 * 1024 * 1024;       // PDF 抽样只读头部 8MB
const MAX_INFLATE = 12 * 1024 * 1024;       // 单个压缩流解压上限（防压缩炸弹）
const MAX_ZIP_FILE = 1024 * 1024 * 1024;    // 超过 1GB 的打包文件跳过深度解析
const MAX_SAMPLE_FILE = 1024 * 1024 * 1024;
const MAX_TOC_TEXT = 8 * 1024 * 1024;       // 目录兜底累计读取的正文上限

function sizeOf(fp) { try { return fs.statSync(fp).size; } catch (_) { return 0; } }
function tooBig(fp, limit) { return sizeOf(fp) > (limit || MAX_ZIP_FILE); }

/** 只读文件头部 limit 字节（fd + readSync，永不整本加载） */
function readHead(fp, limit) {
  limit = limit || MAX_TEXT_HEAD;
  const fd = fs.openSync(fp, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, limit);
    const buf = Buffer.alloc(n);
    let read = 0;
    while (read < n) {
      const r = fs.readSync(fd, buf, read, n - read, read);
      if (!r) break;
      read += r;
    }
    return buf.subarray(0, read);
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

module.exports = {
  sizeOf, tooBig, readHead,
  MAX_TEXT_HEAD, MAX_PDF_HEAD, MAX_INFLATE, MAX_ZIP_FILE, MAX_SAMPLE_FILE, MAX_TOC_TEXT
};
