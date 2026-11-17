// 元数据刮削：EPUB / PDF / MOBI / PPTX / DOCX / FB2 / CBZ + 文件名解析 + 在线刮削
'use strict';
const fs = require('fs');
const path = require('path');
const safeio = require('./safeio');
const zipread = require('./zipread');
const textdoc = require('./textdoc');
const mojibake = require('./mojibake');
const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, removeNSPrefix: true });

const BOOK_EXTS = ['epub', 'pdf', 'mobi', 'azw3', 'azw', 'prc', 'txt', 'md', 'cbz', 'cbr', 'djvu', 'fb2', 'ppt', 'pptx', 'doc', 'docx', 'rtf', 'chm', 'html', 'htm'];

function extOf(fp) { return path.extname(fp).slice(1).toLowerCase(); }

// ---------- 文件名兜底解析 ----------
function parseFilename(filename) {
  let name = mojibake.fix(String(filename || '').replace(/\.[^.]+$/, '')).trim();
  // 清理常见后缀标记
  name = name.replace(/[\[【（(][^\]】）)]*(\d{4}|epub|mobi|azw3|pdf|txt|精校|校对|全集|完结|修订|扫描版|txt)[^\]】）)]*[\]】）)]/gi, ' ').trim();
  // 1.8.1：清理开头的来源标记「(NEW)」「[扫描]」「【PDF】」，只要去掉后还剩东西
  for (let i = 0; i < 3; i++) {
    const t = name.replace(/^[\[【（(][^\]】）)]{0,10}[\]】）)]\s*/, '').trim();
    if (!t || t === name) break;
    name = t;
  }
  // 结尾的「- 副本」「_扫描版」「(1)」这类下载痕迹
  name = name.replace(/[-_—\s]*(副本|复制|扫描版|电子版|高清|完整版)\s*$/g, '')
    .replace(/\s*\(\d{1,2}\)\s*$/, '').trim();
  // 序列提取
  let series = '';
  const sm = name.match(/(.+?)\s*[·\-–:：]?\s*(第?[\d一二三四五六七八九十百]+[卷册部集]|vol\.?\s*\d+|v\d+|第?\d+季)/i);
  if (sm) { series = sm[1].trim(); }
  // 作者 - 书名 / 书名 - 作者（启发式）
  let author = '', title = name;
  const parts = name.split(/\s*[\-–—·]\s*/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0].trim(), last = parts[parts.length - 1].trim(), rest = parts.slice(0, -1).join(' - ').trim();
    const zhName = s => /^[\u4e00-\u9fa5·]{2,4}$/.test(s) && !/全集|系列|文集|作品集/.test(s);
    const enName = s => /^[A-Z][A-Za-z.'-]*(\s+[A-Z][A-Za-z.'-]*)+$/.test(s) || /^[\u4e00-\u9fa5·]{2,4}(先生|女士|著)$/.test(s);
    // 中国常见姓氏，用于判断「两段中文」里哪一段更像人名
    const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄家封芮羿储靳汲邴松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公';
    const looksPerson = s => {
      const core = s.replace(/著|编著|主编|译$/, '');
      return /^[\u4e00-\u9fa5·]{2,3}$/.test(core) && SURNAMES.includes(core[0]);
    };
    if (enName(last)) { author = last.replace(/著$/, ''); title = rest; }                    // 「书名 - Andrew Hunt」
    else if (looksPerson(last) && !looksPerson(first)) { author = last; title = rest; }       // 「书名 - 刘慈欣」
    else if (looksPerson(first) && !looksPerson(last)) { author = first; title = parts.slice(1).join(' - '); } // 「刘慈欣 - 书名」
    else if (zhName(last) && !zhName(first)) { author = last; title = rest; }
    else if (zhName(first) && zhName(last)) { author = last; title = rest; }                  // 两段都像：默认「书名 - 作者」
  }
  if (/\sby\s/i.test(title)) {
    const m = title.match(/^(.*?)\s+by\s+(.+)$/i);
    if (m) { title = m[1].trim(); if (!author) author = m[2].trim(); }
  }
  return { title: title.trim() || filename, author, series };
}

// ---------- EPUB ----------
function parseEpub(fp, coversDir, bookId) {
  const zip = zipread.open(fp);
  const getEntry = n => zip.getEntry(n);
  const readText = n => { const e = getEntry(n); return e ? zip.readAsText(e) : null; };
  const container = xml.parse(readText('META-INF/container.xml') || '');
  let opfPath = null;
  try {
    const rf = container.container.rootfiles.rootfile;
    opfPath = (Array.isArray(rf) ? rf[0] : rf)['@_full-path'];
  } catch (_) {}
  if (!opfPath) {
    const opf = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.opf'));
    if (!opf) return {};
    opfPath = opf.entryName;
  }
  const opfDir = path.posix.dirname(opfPath);
  const doc = xml.parse(readText(opfPath));
  const meta = doc.package && doc.package.metadata || {};
  const man = doc.package && doc.package.manifest && doc.package.manifest.item || [];
  const items = Array.isArray(man) ? man : [man];
  const txt = v => { if (v == null) return ''; if (typeof v === 'object') return String(v['#text'] ?? ''); return String(v); };
  const first = v => txt(Array.isArray(v) ? v[0] : v);
  const all = v => (Array.isArray(v) ? v : [v]).map(txt).filter(Boolean);
  const out = {
    title: first(meta.title), author: all(meta.creator).join(', '), publisher: first(meta.publisher),
    description: first(meta.description).replace(/<[^>]+>/g, '').trim(), language: first(meta.language),
    date: first(meta.date), tags: all(meta.subject), isbn: ''
  };
  for (const id of all(meta.identifier)) { const m = String(id).match(/(?:isbn:)?(\d{10}|\d{13})/i); if (m) { out.isbn = m[1]; break; } }
  for (const k of ['title', 'author', 'publisher', 'description']) if (out[k]) out[k] = mojibake.fix(out[k]);
  // 封面
  try {
    let coverId = null;
    const metaItems = Array.isArray(meta.meta) ? meta.meta : (meta.meta ? [meta.meta] : []);
    for (const m of metaItems) { if (m['@_name'] === 'cover') coverId = m['@_content']; }
    let href = null;
    if (coverId) { const it = items.find(i => i['@_id'] === coverId); if (it) href = it['@_href']; }
    if (!href) { const it = items.find(i => String(i['@_properties'] || '').includes('cover-image')); if (it) href = it['@_href']; }
    if (!href) { const it = items.find(i => /image\/(jpeg|png)/.test(i['@_media-type'] || '')); if (it) href = it['@_href']; }
    if (href) {
      const cp = path.posix.join(opfDir, decodeURIComponent(href));
      const entry = getEntry(cp);
      if (entry) {
        const ext = extOf(cp) === 'png' ? '.png' : '.jpg';
        fs.writeFileSync(path.join(coversDir, bookId + ext), zip.readFile(entry));
        out.coverExt = ext;
      }
    }
  } catch (e) { /* 无封面不致命 */ }
  return out;
}

// ---------- PDF（从原始字节提取 Info/XMP 元数据） ----------
// ---------- TXT / MD：前 500 字识别「书名/作者」（1.8.0：先做编码自动识别） ----------
function parseTxtHead(fp) {
  let text = '';
  try {
    const r = textdoc.readHeadText(fp, 256 * 1024, 4000);
    text = String(r.text || '');
  } catch (_) { return {}; }
  text = text.replace(/^\uFEFF/, '');
  // 只在前 500 字里找，避免正文中段的「作者：」被误当成元数据
  const head500 = text.slice(0, 500);
  const lines = head500.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 30);
  const out = {};
  const pick = (re) => {
    for (const l of lines) {
      const m = l.match(re);
      if (m && m[1]) return m[1].trim().replace(/^[《「"']|[》」"'"]$/g, '').trim();
    }
    return '';
  };
  out.title = pick(/^(?:书\s*名|标\s*题|title)\s*[:：]\s*(.{1,60})$/i);
  out.author = pick(/^(?:作\s*者|著\s*者|author)\s*[:：]\s*(.{1,40})$/i);
  if (!out.title) {
    const m = head500.match(/《([^》]{2,40})》/);
    if (m) out.title = m[1].trim();
  }
  // 1.8.1：中文 TXT 常见「第一行就是书名」，没有「书名：」前缀时也用上（前 500 字内）
  if (!out.title && lines.length) {
    const l = lines[0].replace(/^[#\s]+/, '').trim();
    const looksHead = /^(第[0-9一二三四五六七八九十百零〇]+[章节回卷部篇集]|序言?|前言|目录|内容简介|简介|声明|版权|声明：)/.test(l);
    if (l.length >= 2 && l.length <= 24 && !/[。！？；，,]/.test(l) && !looksHead) out.title = l;
  }
  if (!out.author) {
    const m = head500.match(/([\u4e00-\u9fa5·]{2,4})\s*(?:著|编著|主编|译)/);
    if (m) out.author = m[1];
  }
  const res = {};
  if (out.title) res.title = mojibake.fix(out.title);
  if (out.author) res.author = mojibake.fix(out.author);
  return res;
}

function parsePdf(fp) {
  const fd = fs.openSync(fp, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(Math.min(size, 256 * 1024));
  const tailSize = Math.min(size, 256 * 1024);
  const tail = Buffer.alloc(tailSize);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.readSync(fd, tail, 0, tailSize, size - tailSize);
  fs.closeSync(fd);
  const sample = Buffer.concat([head, tail]);
  const s = sample.toString('latin1');
  const out = {};
  // 1.8.0 修复：八进制转义要取捕获组（此前 parseInt('\346', 8) 得到 NaN，
  // 于是任何用 \ooo 写中文标题的 PDF 都会被解析成一串 \u0000 —— 就是用户看到的「□□□」）
  const unescape = str => String(str || '')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
  const m = s.match(/\/Title\s*\(((?:\\.|[^\\()])*)\)/);
  if (m) out.title = decodeMaybeUtf16(unescape(m[1])).trim();
  const ma = s.match(/\/Author\s*\(((?:\\.|[^\\()])*)\)/);
  if (ma) out.author = decodeMaybeUtf16(unescape(ma[1]));
  // XMP
  const xt = s.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>[\s\S]*?<\/dc:title>/);
  if (xt) out.title = out.title || xt[1].trim();
  const xa = s.match(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>[\s\S]*?<\/dc:creator>/);
  if (xa) out.author = out.author || xa[1].trim();
  // 页数估算
  const pc = s.match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (pc) out.pages = parseInt(pc[1], 10);
  return out;
}

function decodeMaybeUtf16(str) {
  const buf = Buffer.from(str, 'latin1');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE（带 BOM）
    let out = '';
    for (let i = 2; i + 1 < buf.length; i += 2) out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    return out;
  }
  // 尝试按 UTF-8 解码（无替换字符则认为正确）
  const decoded = buf.toString('utf8');
  if (!decoded.includes('\uFFFD')) return decoded;
  // 1.8.0：UTF-8 字节被按 latin1 读进来的「双重编码」——先把字节还原成 UTF-8
  const fixed = mojibake.fix(str);
  if (fixed && fixed !== str && !fixed.includes('\uFFFD')) return fixed;
  // 老式中文 PDF：标题本身就是 GBK 字节
  try {
    const gb = new TextDecoder('gb18030').decode(buf);
    if (/[\u4e00-\u9fff]/.test(gb)) return gb;
  } catch (_) {}
  return str;
}

// ---------- MOBI / AZW3（EXTH 头） ----------
function parseMobi(fp) {
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const data = buf.subarray(0, n);
  const out = {};
  if (data.length < 512) return out;
  out.title = data.toString('utf8', 0, 32).replace(/\0.*$/, '').trim();
  if (data.toString('ascii', 60, 68) !== 'BOOKMOBI') return out;
  // PalmDB: 首条记录偏移
  const recOffset = data.readUInt32BE(78);
  const rec = recOffset;
  if (data.length < rec + 512) return out;
  if (data.toString('ascii', rec + 16, rec + 20) !== 'MOBI') return out;
  const mobiLen = data.readUInt32BE(rec + 20);
  const flags = data.readUInt32BE(rec + 128);
  const fullNameOffset = data.readUInt32BE(rec + 84);
  const fullNameLen = data.readUInt32BE(rec + 88);
  if (fullNameOffset && fullNameLen) {
    const t = data.toString('utf8', rec + fullNameOffset, rec + fullNameOffset + fullNameLen);
    if (t.trim()) out.title = t.trim();
  }
  // EXTH
  if (flags & 0x40) {
    let p = rec + 16 + mobiLen;
    if (data.toString('ascii', p, p + 4) === 'EXTH') {
      const len = data.readUInt32BE(p + 4);
      const count = data.readUInt32BE(p + 8);
      let q = p + 12;
      const fields = {};
      for (let i = 0; i < count && q + 8 <= p + len; i++) {
        const type = data.readUInt32BE(q), l = data.readUInt32BE(q + 4);
        fields[type] = data.toString('utf8', q + 8, q + l);
        q += l + ((l % 4) ? (4 - l % 4) : 0);
      }
      if (fields[100]) out.author = fields[100];
      if (fields[101]) out.publisher = fields[101];
      if (fields[103]) out.description = (fields[103] || '').replace(/<[^>]+>/g, '').trim().slice(0, 2000);
      if (fields[106]) out.date = fields[106];
      if (fields[104]) out.isbn = (fields[104].match(/\d{10,13}/) || [''])[0];
      if (fields[105]) out.tags = fields[105].split(/[;；]/).map(s => s.trim()).filter(Boolean);
    }
  }
  return out;
}

// ---------- PPTX / DOCX（docProps/core.xml） ----------
function parseOoxml(fp) {
  const zip = zipread.open(fp);
  const e = zip.getEntry('docProps/core.xml');
  if (!e) return {};
  const doc = xml.parse(zip.readAsText(e));
  // fast-xml-parser 开了 removeNSPrefix 后根键是 coreProperties；不同生成器还可能带前缀
  const p = doc.coreProperties || doc['cp:coreProperties'] || doc.Properties || doc['cp:Properties'] || {};
  const get = (...keys) => {
    for (const k of keys) {
      const v = p[k] != null ? p[k] : (p['dc:' + k] != null ? p['dc:' + k] : p['dcterms:' + k]);
      if (v != null && v !== '') return typeof v === 'object' ? String(v['#text'] ?? '') : String(v);
    }
    return '';
  };
  return { title: mojibake.fix(get('title')), author: mojibake.fix(get('creator')), date: get('created', 'modified') };
}

// ---------- PPTX 幻灯片解析（文本 + 图片，降级阅读用） ----------
function extractPptxSlides(fp, cacheDir) {
  const zip = zipread.open(fp);
  const slides = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => parseInt(a.entryName.match(/\d+/)[0]) - parseInt(b.entryName.match(/\d+/)[0]));
  const out = [];
  const mediaCache = new Map();
  const strip = s => String(s).replace(/<[^>]+>/g, '').trim();
  const textsOf = xmlDoc => {
    const res = [];
    const walk = o => {
      if (o == null) return;
      if (typeof o === 'object') { for (const k in o) { if (k === 't') { const v = o[k]; (Array.isArray(v) ? v : [v]).forEach(x => { const t = typeof x === 'object' ? String(x['#text'] ?? '') : String(x); if (t.trim()) res.push(t); }); } else walk(o[k]); } }
    };
    walk(xmlDoc);
    return res;
  };
  for (const s of slides) {
    let texts = [], images = [];
    try {
      const doc = xml.parse(zip.readAsText(s));
      texts = textsOf(doc);
    } catch (_) {}
    // 图片：解析关系文件
    try {
      const relName = s.entryName.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      const relEntry = zip.getEntry(relName);
      if (relEntry) {
        const rels = xml.parse(zip.readAsText(relEntry));
        const list = rels.Relationships && rels.Relationships.Relationship ? (Array.isArray(rels.Relationships.Relationship) ? rels.Relationships.Relationship : [rels.Relationships.Relationship]) : [];
        for (const r of list) {
          if (/image/i.test(r['@_Type'] || '')) {
            const target = path.posix.normalize(path.posix.join('ppt/slides', r['@_Target']));
            const me = zip.getEntry(target);
            if (me && /\.(png|jpe?g|gif|webp)$/i.test(target)) {
              const key = target.replace(/[^\w.-]/g, '_');
              if (!mediaCache.has(key)) {
                const dest = path.join(cacheDir, key);
                if (!fs.existsSync(dest)) fs.writeFileSync(dest, zip.readFile(me));
                mediaCache.set(key, dest);
              }
              images.push(key);
            }
          }
        }
      }
    } catch (_) {}
    out.push({ texts, images });
  }
  return out;
}

// ---------- FB2 ----------
function parseFb2(fp) {
  const buf = safeio.readHead(fp, safeio.MAX_TEXT_HEAD);
  let text = buf.toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  try {
    const doc = xml.parse(text);
    const info = doc.FictionBook && doc.FictionBook.description && doc.FictionBook.description['title-info'] || {};
    const authors = Array.isArray(info.author) ? info.author : (info.author ? [info.author] : []);
    return {
      title: typeof info['book-title'] === 'string' ? info['book-title'] : '',
      author: authors.map(a => [(a['first-name'] || ''), (a['middle-name'] || ''), (a['last-name'] || '')].join(' ').trim()).filter(Boolean).join(', '),
      description: typeof info.annotation === 'object' ? JSON.stringify(info.annotation).replace(/<[^>]+>/g, '') : String(info.annotation || ''),
      tags: String(info.genre || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
    };
  } catch (_) { return {}; }
}

// ---------- CBZ 封面 ----------
function extractCbzCover(fp, coversDir, bookId) {
  try {
    const zip = zipread.open(fp);
    const imgs = zip.getEntries().filter(e => /\.(jpe?g|png|webp|gif)$/i.test(e.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName));
    if (imgs.length) {
      const ext = extOf(imgs[0].entryName) === 'png' ? '.png' : '.jpg';
      fs.writeFileSync(path.join(coversDir, bookId + ext), zip.readFile(imgs[0]));
      return ext;
    }
  } catch (_) {}
  return null;
}

// ---------- 目录层级（1.8.1：刮削与书名兜底都要参照「存储目录的文件夹名」） ----------
// 说明：NAS 上的整理习惯往往把有用信息放在目录名里（出版社 / 丛书 / 作者 / 年份），
// 而文件名可能只剩「001.pdf」「(NEW)xxx.pdf」。这里把各级目录名从深到浅取出来。
const DIR_NOISE = /^(图书|电子书|电子书籍|书籍|书库|books?|ebooks?|下载|downloads?|待整理|未分类|其他|others?|新建文件夹|new folder|tmp|temp|合集|整理)$/i;

function dirNames(filePath, depth) {
  const parts = String(filePath || '').split(/[\\/]+/).filter(Boolean);
  parts.pop();                                   // 去掉文件名
  const out = [];
  for (let i = parts.length - 1; i >= 0 && out.length < (depth || 6); i--) {
    const raw = parts[i].trim();
    if (!raw || raw.length > 60) continue;
    if (/^[A-Za-z]:$/.test(raw)) continue;        // 盘符
    if (raw.startsWith('.')) continue;            // .git / .t181 这类
    if (/^\d+$/.test(raw)) continue;              // 纯数字（卷号、年份）
    if (DIR_NOISE.test(raw)) continue;
    out.push(mojibake.fix(raw).replace(/\.(zip|rar|7z)$/i, '').trim());
  }
  return out.filter(Boolean);
}

/** 目录名里最像「书名/丛书名」的一条（用于文件名不可用时的兜底） */
function bestDirTitle(filePath) {
  for (const d of dirNames(filePath)) {
    if (/[\u4e00-\u9fa5A-Za-z]{2,}/.test(d) && !/^\d+$/.test(d)) return d;
  }
  return '';
}

/**
 * 1.8.2：文件内嵌的元数据书名经常是「垃圾」——Word 导出的 PDF 里写着
 * 「Microsoft Word - 1234.doc」、扫描件写着「未命名-1」、或者干脆是文件名本身。
 * 这类值不能当书名，更不能拿去做刮削检索。
 */
function looksJunkTitle(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (t.length > 200) return true;
  // 纯符号 / 纯编号：001、12 这类扫描件序号没信息量，但 4 位数可能是书名（1984）
  if (/^[\s._\-()\[\]#*]+$/.test(t)) return true;
  if (/^\d{1,3}$/.test(t)) return true;
  if (/^\d{5,}$/.test(t)) return true;
  if (/^(?:untitled|无标题|未命名|新建文档|文档\d*|扫描件|扫描版|电子版|document\s*\d*|book\s*\d*|ebook|unknown)\s*[-_–—(（]?\s*\d*\s*[)）]?$/i.test(t)) return true;
  if (/^microsoft\s*(word|powerpoint)\s*[-–—]/i.test(t)) return true;
  if (/\.(docx?|pdf|txt|epub|mobi|azw3|pptx?|indd|djvu)$/i.test(t)) return true;  // 书名里带文件后缀，基本是导出残留
  if (/^(作者|书名|标题|title|author)\s*[:：]?$/i.test(t)) return true;
  return false;
}

module.exports = { BOOK_EXTS, extOf, parseFilename, parseTxtHead, parseEpub, parsePdf, parseMobi, parseOoxml, extractPptxSlides, parseFb2, extractCbzCover, dirNames, bestDirTitle, looksJunkTitle };
