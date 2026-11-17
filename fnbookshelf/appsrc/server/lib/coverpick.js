// 1.6.0：详情页手动设置封面 —— 刮削图 / 同目录图片 / 书内某一页
'use strict';
const fs = require('fs');
const path = require('path');

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};
const MAX_NEIGHBOR = 60;
const MAX_NEIGHBOR_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** 书内同目录的图片候选（只读，不搬运、不重命名） */
function neighbors(b) {
  const dir = path.dirname(b.path || '');
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (out.length >= MAX_NEIGHBOR) break;
      if (!IMG_EXT.test(name)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch (_) { continue; }
      if (!st.isFile() || !st.size || st.size > MAX_NEIGHBOR_BYTES) continue;
      out.push({ name, size: st.size, ext: path.extname(name).toLowerCase() });
    }
  } catch (_) {}
  return out.sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }));
}

/** Unicode 归一（NAS 上的文件名可能是 NFD，浏览器提交的是 NFC，直接比较会不相等） */
function normName(s) {
  try { return String(s || '').normalize('NFC'); } catch (_) { return String(s || ''); }
}

/**
 * 严格校验：只能取同目录里的普通文件名，杜绝 ../ 与路径穿越。
 * @param {object} b 书
 * @param {string} name 前端提交的文件名
 * @param {boolean} [lax] 宽松模式：允许子目录内的相对路径（管理员指定「同目录」及其子目录里的图）
 */
function resolveNeighbor(b, name, lax) {
  const n = normName(String(name || '')).trim().replace(/^(?:\.\.?[\\/])+/, '');
  if (!n || n.includes('\u0000')) return null;
  if (!IMG_EXT.test(n)) return null;
  const base = path.dirname(b.path || '');
  if (!base) return null;
  // 逐段校验：不允许 ..、不允许绝对路径、不允许盘符
  const parts = n.replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
  if (!parts.length) return null;
  for (const p of parts) {
    if (p === '..' || p.includes(':')) return null;
  }
  if (parts.length > 1 && !lax) return null;
  if (path.isAbsolute(n)) return null;
  const fp = path.resolve(base, ...parts);
  // 解析后必须仍在书籍目录之下（防软链接 / 符号路径穿越）
  const rel = path.relative(path.resolve(base), fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (path.resolve(fp) === path.resolve(b.path || '')) return null;
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > MAX_NEIGHBOR_BYTES) return null;
  } catch (_) { return null; }
  return fp;
}

/**
 * 解析失败时给出能照着排查的原因（前端直接显示，别再只丢一句「不在同目录」）。
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
function resolveNeighborInfo(b, name) {
  // 前端「上级目录」候选带 ../ 前缀：剥掉后按同目录校验，父目录必须真的是书籍目录的父级
  const raw = normName(String(name || '')).trim();
  const upLevels = (raw.match(/^\.\.[\\/]/) ? 1 : 0);
  const n = raw.replace(/^(?:\.\.?[\\/])+/, '');
  if (!n) return { ok: false, error: '没有收到图片文件名' };
  if (!IMG_EXT.test(n)) return { ok: false, error: `格式不支持：${n}（只支持 jpg / jpeg / png / webp / gif / bmp）` };
  let base = path.dirname(b.path || '');
  if (!base) return { ok: false, error: '这本书没有记录文件路径，无法查找同目录图片' };
  if (upLevels) {
    const up = path.dirname(base);
    if (!up || up === base) return { ok: false, error: '已经到最上层目录，没有上级目录可用' };
    base = up;
  }
  const parts = n.replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
  if (!parts.length) return { ok: false, error: '图片路径无效' };
  if (parts.length > 1) return { ok: false, error: `图片不在书籍同目录内：${n}（只能选与书同一个文件夹里的图）` };
  if (parts[0] === '..' || parts[0].includes(':')) return { ok: false, error: '图片路径无效' };
  const fp = path.resolve(base, parts[0]);
  const rel = path.relative(path.resolve(base), fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '图片不在书籍同目录内' };
  let st;
  try { st = fs.statSync(fp); }
  catch (_) {
    // Windows 与 SMB 上大小写不敏感，但 JS 字符串比较敏感——跑一遍同目录清单找忽略大小写的同名文件
    let hit = null;
    try {
      const low = parts[0].toLowerCase();
      hit = fs.readdirSync(base).find(f => f.toLowerCase() === low) || null;
    } catch (_) {}
    if (!hit) return { ok: false, error: `同目录里找不到这张图：${parts[0]}` };
    const fp2 = path.join(base, hit);
    try { if (!fs.statSync(fp2).isFile()) return { ok: false, error: `${hit} 不是文件` }; }
    catch (__) { return { ok: false, error: `${hit} 无法读取（权限不足？）` }; }
    return { ok: true, path: fp2 };
  }
  if (!st.isFile()) return { ok: false, error: '选中的不是文件' };
  if (!st.size) return { ok: false, error: '图片是空文件' };
  if (st.size > MAX_NEIGHBOR_BYTES) return { ok: false, error: `图片过大（${Math.round(st.size / 1048576)}MB，上限 20MB）` };
  try { fs.accessSync(fp, fs.constants.R_OK); }
  catch (_) { return { ok: false, error: '图片不可读（权限不足）' }; }
  return { ok: true, path: fp };
}

const COVER_EXTS = ['.jpg', '.png', '.webp', '.gif'];

function clearCoverFiles(store, id, keepExt = '') {
  // 只删确实存在的旧封面。绝不对不存在的路径 unlinkSync 再吞异常：
  // Windows 上一次失败的删除要约 200ms，多版本叠加会把「保存封面」拖成好几秒。
  try {
    const names = new Set(fs.readdirSync(store.coversDir));
    for (const e of COVER_EXTS) {
      if (e === keepExt) continue;
      const f = id + e;
      if (!names.has(f)) continue;
      fs.promises.unlink(path.join(store.coversDir, f)).catch(() => {});
    }
  } catch (_) {}
}

/** 把一张图片写进封面缓存（覆盖同书所有版本，卡片与详情保持一致） */
function writeCoverBytes(store, ids, buf, ext) {
  for (const id of ids) {
    // 先写目标文件（同名直接覆盖，不需要先删），再异步清掉其他扩展名的旧图。
    // 删文件在某些文件系统上很慢，放到后台不阻塞响应。
    fs.writeFileSync(path.join(store.coversDir, id + ext), buf);
    clearCoverFiles(store, id, ext);
  }
}

/**
 * 应用封面选择
 * @param {object} store
 * @param {Array<object>} books 同一作品的全部版本
 * @param {{source:string,name?:string,dataUrl?:string}} body
 */
function applyCover(store, books, body) {
  const b = books[0];
  const ids = books.map(x => x.id);
  const src = String((body && body.source) || '');

  if (src === 'reset') {
    for (const x of books) { x.coverSource = ''; x.coverExt = null; store.upsertBook(x); }
    return { ok: true, source: 'reset' };
  }
  if (src === 'scraped') {
    // 保留现有封面（刮削/书内提取得到的那张），只是标记为手动锁定
    if (!b.coverExt) {
      // 没有任何封面文件时，尝试沿用作品里另一个版本的封面
      for (const x of books) {
        if (x.id === b.id) continue;
        for (const e of ['.jpg', '.png', '.webp', '.gif']) {
          const f = path.join(store.coversDir, x.id + e);
          if (!fs.existsSync(f)) continue;
          writeCoverBytes(store, ids, fs.readFileSync(f), e);
          for (const y of books) { y.coverExt = e.slice(1); y.coverSource = 'manual'; store.upsertBook(y); }
          return { ok: true, source: 'scraped', borrowed: true };
        }
      }
      throw Object.assign(new Error('本书还没有刮削/提取到封面，请改选同目录图片或书内页面'), { status: 400 });
    }
    for (const x of books) { x.coverSource = 'manual'; store.upsertBook(x); }
    return { ok: true, source: 'scraped', locked: true };
  }
  if (src === 'neighbor') {
    const info = resolveNeighborInfo(b, body && body.name);
    if (!info.ok) throw Object.assign(new Error(info.error || '图片不在书籍同目录内或格式不支持'), { status: 400 });
    const fp = info.path;
    const ext = path.extname(fp).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(fp).toLowerCase();
    const extKey = ext === '.jpg' ? '.jpg' : ext;
    const buf = fs.readFileSync(fp);
    if (!buf.length || buf.length > MAX_NEIGHBOR_BYTES) throw Object.assign(new Error('图片为空或过大'), { status: 400 });
    writeCoverBytes(store, ids, buf, extKey);
    for (const x of books) { x.coverExt = extKey.slice(1); x.coverSource = 'manual'; store.upsertBook(x); }
    return { ok: true, source: 'neighbor', name: path.basename(fp) };
  }
  // 1.9.1：直接上传一张图片当封面（data URL，前端已压到 8MB 以内）
  if (src === 'upload') {
    const m = String((body && body.dataUrl) || '').match(/^data:image\/(jpeg|jpg|png|webp|gif|bmp);base64,(.+)$/i);
    if (!m) throw Object.assign(new Error('上传的图片格式不正确（只支持 jpg / png / webp / gif / bmp）'), { status: 400 });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw Object.assign(new Error('图片内容为空'), { status: 400 });
    if (buf.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('图片超过 8MB，请压缩后再上传'), { status: 400 });
    const t = m[1].toLowerCase();
    const ext = t === 'png' ? '.png' : t === 'webp' ? '.webp' : t === 'gif' ? '.gif' : t === 'bmp' ? '.bmp' : '.jpg';
    writeCoverBytes(store, ids, buf, ext);
    for (const x of books) { x.coverExt = ext.slice(1); x.coverSource = 'manual'; store.upsertBook(x); }
    return { ok: true, source: 'upload', bytes: buf.length };
  }
  if (src === 'page') {
    const m = String((body && body.dataUrl) || '').match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
    if (!m) throw Object.assign(new Error('页面图片格式不正确'), { status: 400 });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 2000 || buf.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('页面图片为空或超过 8MB'), { status: 400 });
    const ext = m[1] === 'png' ? '.png' : '.jpg';
    writeCoverBytes(store, ids, buf, ext);
    for (const x of books) { x.coverExt = ext.slice(1); x.coverSource = 'manual'; store.upsertBook(x); }
    return { ok: true, source: 'page' };
  }
  throw Object.assign(new Error('未知的封面来源'), { status: 400 });
}

module.exports = { neighbors, resolveNeighbor, resolveNeighborInfo, applyCover, MIME, IMG_EXT, MAX_NEIGHBOR_BYTES, MAX_UPLOAD_BYTES };
