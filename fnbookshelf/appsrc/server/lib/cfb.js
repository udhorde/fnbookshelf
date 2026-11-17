// OLE / CFB（复合文档）读取：给 .doc（Word 97-2003）等老式 Office 文件用。
// 与 pptbin.js 内的实现同源，但独立成模块，避免改动已验证过的 PPT 解析路径。
'use strict';

/** 读取指定名称的流；不存在返回 null */
function readStream(buf, streamName) {
  if (!buf || buf.length < 512) return null;
  // 签名 D0 CF 11 E0 A1 B1 1A E1
  if (buf[0] !== 0xd0 || buf[1] !== 0xcf || buf[2] !== 0x11 || buf[3] !== 0xe0) return null;
  const sectorShift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  if (sectorShift < 7 || sectorShift > 16 || miniShift > sectorShift) return null;
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniShift;
  const miniCutoff = buf.readInt32LE(0x38);
  const numFat = buf.readInt32LE(0x2c);
  const firstDirSector = buf.readInt32LE(0x30);

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

  const fat = [];
  for (const s of fatSectors.slice(0, Math.max(0, numFat))) {
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
      const off = secOff(s);
      parts.push(buf.slice(off, off + sectorSize));
      s = fat[s];
    }
    return Buffer.concat(parts);
  };

  const dirBuf = readChain(firstDirSector);
  const entries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameLen = dirBuf.readUInt16LE(off + 0x40);
    const type = dirBuf[off + 0x42];
    if (type === 0) continue;
    let name = '';
    try { name = dirBuf.slice(off, off + Math.max(0, nameLen - 2)).toString('utf16le'); } catch (_) {}
    entries.push({
      name, type,
      start: dirBuf.readInt32LE(off + 0x74),
      size: Number(dirBuf.readBigUInt64LE(off + 0x78))
    });
  }
  const target = entries.find(e => e.type === 2 && e.name === streamName);
  if (!target || !(target.size > 0)) return null;
  if (target.size > 400 * 1024 * 1024) return null;   // 防御异常尺寸

  if (target.size < miniCutoff) {
    const root = entries.find(e => e.type === 5);
    if (!root) return null;
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

/** 列出所有流名（排障用） */
function listStreams(buf) {
  if (!buf || buf.length < 512) return [];
  if (buf[0] !== 0xd0 || buf[1] !== 0xcf) return [];
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const fat = [];
  const numFat = buf.readInt32LE(0x2c);
  for (let i = 0; i < 109; i++) {
    const s = buf.readInt32LE(0x4c + i * 4);
    if (s >= 0 && s < 0xffffff00) {
      const off = 512 + s * sectorSize;
      if (off + sectorSize <= buf.length) for (let k = 0; k < sectorSize / 4; k++) fat.push(buf.readInt32LE(off + k * 4));
      if (fat.length >= numFat * (sectorSize / 4)) break;
    }
  }
  const chain = start => {
    const parts = []; let s = start; const guard = new Set();
    while (s >= 0 && s < fat.length && fat[s] !== 0xfffffffe && fat[s] !== 0xffffffff && !guard.has(s)) {
      guard.add(s);
      parts.push(buf.slice(512 + s * sectorSize, 512 + (s + 1) * sectorSize));
      s = fat[s];
    }
    return Buffer.concat(parts);
  };
  const dir = chain(buf.readInt32LE(0x30));
  const out = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    if (dir[off + 0x42] !== 2) continue;
    const nameLen = dir.readUInt16LE(off + 0x40);
    try { out.push(dir.slice(off, off + Math.max(0, nameLen - 2)).toString('utf16le')); } catch (_) {}
  }
  return out;
}

module.exports = { readStream, listStreams };
