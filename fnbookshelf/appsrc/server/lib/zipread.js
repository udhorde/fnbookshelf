// 轻量 ZIP 读取器：只解析中央目录、按需解压单个条目，绝不把整本书读入内存。
//
// 背景：adm-zip 的 new AdmZip(fp) 内部是 fs.readFileSync(fp)，会把整个 EPUB/CBZ/PPTX
// 一次性载入。扫描几百本书时这些 Buffer 反复分配、GC 来不及回收，在 NAS 小内存设备上
// 会被 OOM killer 直接杀掉（连异常栈都来不及写）。本模块用 fd + readSync 定点读取：
//   - 只读文件尾部找 EOCD / ZIP64 EOCD
//   - 只读中央目录（通常几十 KB）
//   - readFile(entry) 时只读该条目的压缩数据并解压
// 因此内存占用与书籍总体积无关，只与「单个条目的大小」有关。
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const Z64_EOCD_SIG = 0x06064b50;
const Z64_LOCATOR_SIG = 0x07064b50;

const MAX_EOCD_TAIL = 65557 + 22;      // EOCD + 最大注释长度
const MAX_CENTRAL_DIR = 24 * 1024 * 1024;      // 中央目录最多 24MB
const MAX_ENTRY_COMPRESSED = 32 * 1024 * 1024; // 单个条目压缩数据上限
const MAX_ENTRY_OUTPUT = 32 * 1024 * 1024;     // 单个条目解压后上限（防 zip bomb）
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;  // 超过 4GB 的 rar/伪 zip 直接放弃

let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { /* 无 GBK 解码器时退化为 UTF-8 */ }

function readAt(fd, buf, pos) {
  let read = 0;
  while (read < buf.length) {
    const n = fs.readSync(fd, buf, read, buf.length - read, pos + read);
    if (!n) break;
    read += n;
  }
  if (read !== buf.length) throw new Error('ZIP 数据不完整（文件可能被截断）');
  return buf;
}

function decodeName(buf, isUtf8) {
  if (isUtf8) return buf.toString('utf8');
  const s = buf.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  if (iconv) { try { return iconv.decode(buf, 'gbk'); } catch (_) {} }
  return s;
}

/** 从 central directory 的 ZIP64 extra field 里取 64 位大小 / 偏移 */
function readZip64Extra(extra, need) {
  const out = {};
  let q = 0;
  while (q + 4 <= extra.length) {
    const id = extra.readUInt16LE(q);
    const len = extra.readUInt16LE(q + 2);
    if (id === 0x0001) {
      let r = q + 4;
      const end = Math.min(extra.length, q + 4 + len);
      if (need.uncomp && r + 8 <= end) { out.uncomp = Number(extra.readBigUInt64LE(r)); r += 8; }
      if (need.comp && r + 8 <= end) { out.comp = Number(extra.readBigUInt64LE(r)); r += 8; }
      if (need.offset && r + 8 <= end) { out.offset = Number(extra.readBigUInt64LE(r)); r += 8; }
      return out;
    }
    q += 4 + len;
  }
  return out;
}

class ZipReader {
  constructor(fp, entries) {
    this.fp = fp;
    this.entries = entries;
    this.map = new Map();
    for (const e of entries) if (!this.map.has(e.entryName)) this.map.set(e.entryName, e);
  }

  getEntries() { return this.entries; }

  /** 兼容 adm-zip 的 getEntry(name)：返回条目对象或 null */
  getEntry(name) {
    if (name == null) return null;
    if (typeof name === 'object') return name;   // 也允许直接传 entry
    const n = String(name);
    return this.map.get(n) || this.map.get(n.replace(/^\/+/, '')) || null;
  }

  /** 兼容 adm-zip 的 readFile(entry)：只解压这一个条目。fd 短开短关，不会泄漏句柄。 */
  readFile(entry) {
    const e = this.getEntry(entry);
    if (!e) throw new Error('ZIP 中不存在条目：' + String(entry));
    if (e.entryName.endsWith('/')) return Buffer.alloc(0);
    if (e.compSize > MAX_ENTRY_COMPRESSED || e.size > MAX_ENTRY_OUTPUT) {
      throw new Error(`ZIP 条目过大（${Math.round(e.size / 1048576)}MB），已跳过以防内存暴涨`);
    }
    const fd = fs.openSync(this.fp, 'r');
    try {
      const lh = Buffer.alloc(30);
      readAt(fd, lh, e.localOff);
      if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error('ZIP 本地文件头无效');
      const dataOff = e.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(e.compSize);
      readAt(fd, comp, dataOff);
      if (e.method === 0) return comp;
      if (e.method === 8) {
        // maxOutputLength 会在解压结果超限时抛错，避免压缩炸弹撑爆内存
        return zlib.inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_OUTPUT });
      }
      throw new Error('不支持的 ZIP 压缩方式：' + e.method);
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }

  readAsText(entry, enc) { return this.readFile(entry).toString(enc || 'utf8'); }

  /** 兼容调用方可能存在的 finally { zip.close() }：此处无需关闭常驻 fd */
  close() {}
}

/**
 * 打开一个 ZIP（不载入文件内容）。中央目录解析完立刻释放 fd，
 * 之后每次 readFile 按需短开短关，因此调用方无需 try/finally，也不会泄漏句柄。
 */
function open(fp) {
  const fd = fs.openSync(fp, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error('不是有效的 ZIP 文件');
    if (size > MAX_FILE_SIZE) throw new Error('文件超过 4GB，已跳过解析');

    const tailLen = Math.min(size, MAX_EOCD_TAIL);
    const tail = readAt(fd, Buffer.alloc(tailLen), size - tailLen);

    // EOCD 可能带注释，从尾部倒着找签名并校验注释长度
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        eocd = i; break;
      }
    }
    if (eocd < 0) throw new Error('未找到 ZIP 结束记录（文件可能不是 ZIP 或损坏）');

    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64：条目数 >65535 或偏移/大小溢出 32 位
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorPos = size - tailLen + eocd - 20;
      if (locatorPos >= 0) {
        const loc = readAt(fd, Buffer.alloc(20), locatorPos);
        if (loc.readUInt32LE(0) === Z64_LOCATOR_SIG) {
          const z64off = Number(loc.readBigUInt64LE(8));
          const z64 = readAt(fd, Buffer.alloc(56), z64off);
          if (z64.readUInt32LE(0) === Z64_EOCD_SIG) {
            total = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
          }
        }
      }
    }
    if (!Number.isFinite(cdSize) || cdSize <= 0 || cdSize > MAX_CENTRAL_DIR ||
        !Number.isFinite(cdOffset) || cdOffset < 0 || cdOffset + cdSize > size) {
      throw new Error('ZIP 中央目录异常，已跳过');
    }

    const cd = readAt(fd, Buffer.alloc(cdSize), cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < total && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CD_SIG) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOff = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen > cd.length) break;

      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800));
      if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
        const z = readZip64Extra(
          cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
          { uncomp: uncompSize === 0xffffffff, comp: compSize === 0xffffffff, offset: localOff === 0xffffffff }
        );
        if (z.uncomp != null) uncompSize = z.uncomp;
        if (z.comp != null) compSize = z.comp;
        if (z.offset != null) localOff = z.offset;
      }
      entries.push({
        entryName: name.replace(/^\/+/, ''), method, flags,
        compSize, size: uncompSize, localOff,
        header: { size: uncompSize, compressedSize: compSize }
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipReader(fp, entries);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = { open, ZipReader, MAX_ENTRY_OUTPUT, MAX_CENTRAL_DIR };
