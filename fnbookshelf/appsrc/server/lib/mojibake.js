// 乱码修复：把「字节被按错误编码解码」得到的字符串还原成正常中文。
//
// 现场一（1.8.0 用户反馈）：PDF 内嵌标题是 UTF-8 的「把自己变成稀缺资产」，
// 解析时按 latin1 读成 "æŠŠè‡ªå·±å˜æˆä¸ºç¨€ç¼ºèµ„äº§"，
// 其中 0x80–0x9F 区间的字节会变成 C1 控制字符，在页面上显示成一串 □。
// 还原方法：把字符串按单字节取回原始字节，再按 UTF-8 解码。
//
// 现场二（1.8.1 用户反馈）：书名显示成「幙晓驗苷萌諼塵全乜□嚌尉」这类全是生僻字的串。
// 成因是同一批字节被按 GBK/BIG5/UTF-16 之类的编码解过（不同 PDF 生成器写法不一样），
// 单靠一种反向映射修不回来。这里的策略是：
//   ① 判定「这串文字不像正常中文」（含替换符/□/控制符，或汉字里生僻字占比过高）
//   ② 用多种编码把字节重新解一遍，取「最像人话」的结果（GB2312 一级字库占比打分）
//   ③ 实在救不回来就交给调用方用文件名兜底（meta/scanner 都会带上 fallback）
'use strict';

// Windows-1252 在 0x80–0x9F 区间把控制字符映射成了可见字符，反向映射回来
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
};

const C1 = /[\u0080-\u009f]/;
const MOJI_HINT = /[ÃÂÐåæçèéä¤‰§¨©«¬®°±²³´µ¶·¸¹º»]/;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_ONE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;const BAD_CHAR = /[\uFFFD\u25A1\u25AF]/;   // 替换符 / □ —— 正常书名里不会出现
// 1.9.2：「锟斤拷」是 UTF-8 ↔ GBK 反复误转的典型产物，字都挺「常用」，编码也救不回来，
// 只能认出来是乱码并交给文件名兜底。
const REPLACE_JUNK = /锟斤拷|烫烫烫|屯屯屯|鍩庡|鏂囦|ï¿½/;

function cjkCount(s) { const m = String(s || '').match(CJK); return m ? m.length : 0; }

/** 是否是「救不回来的替换型乱码」（能识别，只能换名，不能还原） */
function looksReplaceJunk(s) {
  const v = String(s || '');
  if (!v) return false;
  if (REPLACE_JUNK.test(v)) return true;
  // 「?\uFFFD\ufffd」或多处替换符成片出现
  const fffd = (v.match(/\uFFFD/g) || []).length;
  return fffd >= 2 && fffd >= v.length * 0.2;
}

/** 把「单字节误解码」的字符串还原成原始字节；含真正的多字节字符则返回 null */
function toBytes(s) {
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0xff) { out[n++] = c; continue; }
    const b = CP1252[c];
    if (b === undefined) return null;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

// ---------- GB18030 双向表（懒加载，只建一次；约 2.4 万条，20ms 左右） ----------
let GBK_ENC = null;
function gbkEnc() {
  if (GBK_ENC) return GBK_ENC;
  GBK_ENC = new Map();
  try {
    const dec = new TextDecoder('gb18030');
    for (let b1 = 0x81; b1 <= 0xfe; b1++) {
      for (let b2 = 0x40; b2 <= 0xfe; b2++) {
        if (b2 === 0x7f) continue;
        const ch = dec.decode(Buffer.from([b1, b2]));
        if (ch.length === 1 && ch !== '\uFFFD' && !GBK_ENC.has(ch)) GBK_ENC.set(ch, (b1 << 8) | b2);
      }
    }
  } catch (_) { /* 运行时没有 gb18030 解码器就退化为只做 UTF-8/latin1 修复 */ }
  return GBK_ENC;
}

/** 字符 → GB18030 字节；无法编码返回 null */
function encodeGbk(str) {
  const map = gbkEnc();
  const out = [];
  for (const ch of String(str || '')) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const v = map.get(ch);
    if (!v) return null;
    out.push(v >> 8, v & 0xff);
  }
  return Buffer.from(out);
}

/** 是否 GB2312 一级字库（3755 个最常用汉字，编码区间 0xB0A1–0xD7F9） */
function isCommonHan(ch) {
  const map = gbkEnc();
  const v = map.get(ch);
  if (!v) return /[\u3000-\u303f\uff00-\uffef]/.test(ch);
  const b1 = v >> 8, b2 = v & 0xff;
  return b1 >= 0xb0 && b1 <= 0xd7 && b2 >= 0xa1;
}

/** 汉字里「常用字」的占比；没有汉字时返回 1（日文假名、纯英文标题不参与判定） */
function commonRatio(s) {
  const chars = String(s || '').split('').filter(c => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(c));
  if (!chars.length) return 1;
  let n = 0;
  for (const c of chars) if (isCommonHan(c)) n++;
  return n / chars.length;
}

/** 像不像正常文字（分数越高越像人话） */
function textScore(s) {
  const str = String(s || '');
  if (!str.trim()) return -99;
  if (str.includes('\uFFFD')) return -50;
  const han = (str.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const kana = (str.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (str.match(/[\uac00-\ud7af]/g) || []).length;
  const ascii = (str.match(/[\x20-\x7e]/g) || []).length;
  let sc = 0;
  if (han) sc += commonRatio(str) * 4 + Math.min(2, han / 4);
  if (kana) sc += Math.min(1.5, kana / 6);        // 日文标题合法，但权重低于中文
  if (!han && !kana && !hangul) sc += 0.8;        // 纯英文/数字标题也正常
  sc -= hangul * 0.4;                             // 中文书库里成片韩文基本是误解码
  sc += Math.min(0.6, ascii / 24);
  if (CTRL.test(str)) sc -= 6;
  if (BAD_CHAR.test(str)) sc -= 3;
  if (MOJI_HINT.test(str)) sc -= 1.5;
  return sc;
}

/** 这串文字是不是明显的乱码 */
function looksGarbled(s) {
  if (!s || typeof s !== 'string' || !s.trim()) return false;
  if (/\uFFFD/.test(s)) return true;
  if (CTRL.test(s)) return true;
  if (C1.test(s) || MOJI_HINT.test(s)) return true;
  if (looksReplaceJunk(s)) return true;
  // 「幙晓驗苷萌諼塵全乜□嚌尉」这类：汉字数量够多，但基本全是生僻字
  if (BAD_CHAR.test(s) && cjkCount(s) >= 2) return true;
  // 生僻字占比过高时，只有「换个编码能解出更像人话的版本」才算乱码，
  // 这样繁体书名、古籍名（本来就少见）不会被误判。
  if (cjkCount(s) >= 4 && commonRatio(s) < 0.34) return !!reDecode(s);
  return false;
}

function fixOnce(s) {
  if (!s || typeof s !== 'string') return null;
  if (!(C1.test(s) || MOJI_HINT.test(s))) return null;
  const bytes = toBytes(s);
  if (!bytes || !bytes.length) return null;
  const out = bytes.toString('utf8');
  if (!out || out.includes('\uFFFD')) return null;       // 不是合法 UTF-8，说明本来就不是这种乱码
  if (CTRL.test(out)) return null;                       // 还原后还有控制字符，多半解错了
  const before = cjkCount(s), after = cjkCount(out);
  if (after > before) return out;                        // 中文变多 → 认可
  if (before === 0 && after === 0 && C1.test(s) && /[\x20-\x7e]{3,}/.test(out)) return out;
  return null;
}

/**
 * 用多种编码把「疑似被解错的字节」重新解一遍，取最像人话的结果。
 * 处理 GBK/Big5/UTF-16 误解码，以及 UTF-8 字节被当单字节读的情况。
 */
function reDecode(s) {
  const cands = [];
  const push = t => { if (t && t !== s) cands.push(String(t).trim()); };
  const dec = (enc, buf) => { try { return new TextDecoder(enc).decode(buf); } catch (_) { return ''; } };
  // A. s 里已有汉字 → 字节是被多字节编码解出来的，按 GBK 反推回去再试 UTF-8/Big5
  if (CJK_ONE.test(s)) {
    const back = encodeGbk(s);
    if (back && back.length >= 2) {
      push(back.toString('utf8'));
      push(dec('big5', back));
      push(dec('utf-16le', back));
    }
  }
  // B. s 是「UTF-8 字节按单字节读」→ 取回原始字节再按各种编码解
  const raw = toBytes(s);
  if (raw && raw.length >= 2) {
    push(raw.toString('utf8'));
    push(dec('gb18030', raw));
    push(dec('big5', raw));
    for (const off of [0, 1]) {
      const b = raw.subarray(off);
      if (b.length < 4) continue;
      push(dec('utf-16le', b));
      const be = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
      for (let i = 0; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
      push(dec('utf-16le', be));
    }
  }
  const base = textScore(s);
  let best = null, bestSc = base + 0.35;   // 新结果必须明显更好才采用
  const needHan = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length >= 2;
  for (const t of cands) {
    if (!t || t.includes('\uFFFD') || t.length > 400) continue;
    if (needHan && !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(t)) continue;
    const sc = textScore(t);
    if (sc > bestSc) { best = t; bestSc = sc; }
  }
  return best;
}

/**
 * 修复字符串（最多迭代两次，latin1 与多字节误解码都试）；无法判断时原样返回
 */
function fix(s) {
  let cur = String(s == null ? '' : s);
  // 1.9.2：「锟斤拷」这类救不回来的直接返回空串，交给调用方的 fallback（文件名）兜底
  if (REPLACE_JUNK.test(cur)) return '';
  for (let i = 0; i < 2; i++) {
    const next = fixOnce(cur);
    if (!next) break;
    cur = next;
  }
  if (cur && (BAD_CHAR.test(cur) || C1.test(cur) || MOJI_HINT.test(cur) ||
      (cjkCount(cur) >= 3 && commonRatio(cur) < 0.4))) {
    const alt = reDecode(cur);
    if (alt) cur = alt;
  }
  return cur;
}

/**
 * 书名修复：先修乱码，修不好就用「文件名 / 目录名」兜底。
 * 用户的真实痛点不是「乱码从哪来」，而是「详情页上书名没法看」——
 * 所以只要判定原书名不可信、而兜底名是正常文字，就换掉。
 * 1.9.2：兜底名本身是「原始文件名」时，它才是真相——只要它不像乱码就直接用它。
 * 以前《我不(大冰).pdf》会被反方向换掉：文件名里 6 个汉字、书名只有 4 个，
 * 元数据那串没救回来时 textScore 略高，于是把好名字换成了乱码名。
 */
function repairTitle(title, fallback) {
  const t = fix(String(title == null ? '' : title)).trim();
  const f = fix(String(fallback == null ? '' : fallback)).trim();
  if (f && f !== t && !looksGarbled(f) && !looksReplaceJunk(f)) return f;   // 文件名可信 → 直接采信
  if (t && !looksGarbled(t)) {
    // 元数据书名里几乎没有常用字、且与文件名没有一个共同汉字 → 多半是解错的字节，
    // 直接用文件名（繁体/日文书名因为和文件名的字重合，不会被误换）
    const rare = cjkCount(t) >= 4 && commonRatio(t) < 0.5;
    if (rare && f && !looksGarbled(f)) {
      const a = new Set(t), shared = [...f].some(ch => a.has(ch));
      if (!shared && textScore(f) > textScore(t)) return f;
    }
    return t;
  }
  if (f && !looksGarbled(f) && textScore(f) > textScore(t) + 0.3) return f;
  return t || f;
}

/** 修复对象里的常见文本字段（就地修改，返回是否有改动） */
function fixBookMeta(b) {
  if (!b || typeof b !== 'object') return false;
  let changed = false;
  const stem = String(b.filename || '').replace(/\.[^.]+$/, '');
  const manualTitle = !!(b.manual && b.manual.title);
  for (const k of ['title', 'author', 'publisher', 'description', 'series', 'filename']) {
    const v = b[k];
    if (typeof v !== 'string' || !v) continue;
    if (k === 'title' && manualTitle) continue;      // 手动改过的书名不动
    const nv = k === 'title' ? repairTitle(v, stem) : fix(v);
    if (nv !== v) { b[k] = nv; changed = true; }
  }
  return changed;
}

module.exports = {
  fix, fixBookMeta, looksMojibake: looksGarbled, looksGarbled, looksReplaceJunk,
  repairTitle, textScore, commonRatio
};
