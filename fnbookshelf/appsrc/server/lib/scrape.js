// 在线刮削：全部为国内数据源（豆瓣读书 / ISBN 直达 / 当当 / SaltyLeo 的书架）
// 说明：应用整体离线可用，本模块仅在管理员显式开启刮削时访问外网。
// 1.5.0 起按用户要求移除 Google Books 与 Open Library，国内源优先。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 1.9.0：按用户要求移除「国家图书馆 OPAC」与「读秀」——家庭宽带基本不可达，
// 只会让每本书白白等 6 秒超时。
// 1.9.10：新增「SaltyLeo 的书架」（tstrs.me），藏书目录型数据源，带 JSON-LD 结构化条目。
// 优先级即数组顺序：豆瓣 > ISBN 直达 > 当当 > SaltyLeo
const PROVIDERS = {
  douban: { id: 'douban', name: '豆瓣读书', region: 'cn', order: 1 },
  isbn: { id: 'isbn', name: 'ISBN 直达（豆瓣条目）', region: 'cn', order: 2 },
  dangdang: { id: 'dangdang', name: '当当图书', region: 'cn', order: 3 },
  tstrs: { id: 'tstrs', name: 'SaltyLeo 的书架', region: 'cn', order: 4 }
};

// 不可达的源在 30 分钟内直接跳过，避免每本书都白等 6 秒
const DOWN = new Map();
const DOWN_MS = 30 * 60 * 1000;
const isDown = id => { const u = DOWN.get(id); return !!(u && Date.now() < u); };
const markDown = id => DOWN.set(id, Date.now() + DOWN_MS);

// ---------------- HTTP ----------------
let ACTIVE_DEADLINE = 0; // 扫描时设置的全局刮削截止时刻（防止堆积外网请求）
function request(url, opts = {}) {
  return new Promise(resolve => {
    // 刮削总预算到期后不再发起新请求，避免扫描时堆积大量外网连接
    const deadline = opts.deadline || ACTIVE_DEADLINE;
    if (deadline && Date.now() > deadline) return resolve(null);
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    const MAX_BODY = 3 * 1024 * 1024; // 单个页面最多收 3MB，防止异常大响应撑爆内存
    const client = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/json,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'close'
    }, opts.headers || {});
    const req = client.get(u, { headers, timeout: opts.timeout || 12000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (opts.redirects || 0) < 3) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(request(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));
      }
      const chunks = [];
      let received = 0;
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', c => {
        received += c.length;
        if (received > MAX_BODY) { req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      stream.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getText(url, opts) {
  const r = await request(url, Object.assign({ headers: { 'Accept': 'text/html,*/*' } }, opts));
  if (!r || r.status !== 200) return '';
  return decodeBody(r.body, r.headers);
}

/** 按响应头 / meta 声明解码（兼容 GBK/GB2312 站点，如当当） */
function decodeBody(buf, headers) {
  const ct = String((headers && headers['content-type']) || '').toLowerCase();
  let cs = (ct.match(/charset=([\w-]+)/) || [])[1] || '';
  if (!cs) {
    const head = buf.slice(0, 3000).toString('latin1');
    cs = (head.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || 'utf-8';
  }
  cs = cs.toLowerCase();
  if (/^(utf-?8|utf8)$/.test(cs)) return buf.toString('utf8');
  try { return new TextDecoder(cs === 'gb2312' ? 'gbk' : cs).decode(buf); } catch (_) { return buf.toString('utf8'); }
}
async function getJson(url, opts) {
  const r = await request(url, Object.assign({ headers: { 'Accept': 'application/json,*/*' } }, opts));
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch (_) { return null; }
}

// ---------------- 文本工具 ----------------
const stripTags = s => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

const norm = s => String(s || '').toLowerCase().replace(/[\s\-_·:：,，.。!！?？'"“”‘’《》<>()（）\[\]【】]/g, '');

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.82 - Math.abs(a.length - b.length) / Math.max(a.length, b.length) * 0.2;
  // 二元组 Dice 系数
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  let inter = 0, ta = 0, tb = 0;
  for (const v of A.values()) ta += v;
  for (const v of B.values()) tb += v;
  for (const [g, v] of A) if (B.has(g)) inter += Math.min(v, B.get(g));
  return (2 * inter) / (ta + tb || 1);
}

/** 候选评分：书名 0.6 / 作者 0.3 / ISBN 0.1（ISBN 命中直接满分） */
function score(item, q) {
  if (!item) return 0;
  if (q.isbn && item.isbn && norm(q.isbn) === norm(item.isbn)) return 1;
  const st = similarity(item.title, q.title);
  const sa = similarity(item.author, q.author);
  let s = st * 0.62 + (q.author ? sa * 0.3 : 0) + (item.coverUrl ? 0.04 : 0) + (item.description ? 0.04 : 0);
  // 书名包含关系加权：搜索页书名常带副标题/营销语，包含即视为高置信（作者对不上时不给此加成，避免同名不同书）
  const nt = norm(q.title), ni = norm(item.title);
  const authorOk = !q.author || !item.author || sa > 0.45;
  if (nt && ni && ni.includes(nt) && nt.length >= 2 && authorOk) {
    const extra = (ni.length - nt.length) / ni.length;
    s = Math.max(s, 0.86 - Math.min(0.22, extra * 0.35) + (q.author && sa > 0.5 ? 0.05 : 0));
  }
  // 1.8.1：存储目录的文件夹名也是证据——出版社/丛书名出现在路径里，说明候选大概率就是这本
  if (Array.isArray(q.dirs) && q.dirs.length) {
    const pub = norm(item.publisher || ''), ti = norm(item.title || ''), se = norm(item.series || '');
    for (const d of q.dirs) {
      const nd = norm(d);
      if (nd.length < 2) continue;
      if (pub && (pub.includes(nd) || nd.includes(pub))) { s += 0.06; break; }
      if (se && nd.includes(se)) { s += 0.04; break; }
      if (ti.length >= 3 && nd.includes(ti)) { s += 0.03; break; }
    }
  }
  // 副标题/系列名过长时略微惩罚
  if (item.title && q.title && item.title.length > q.title.length * 2.2) s -= 0.06;
  return Math.max(0, Math.min(1, s));
}

// ---------------- 豆瓣 ----------------
async function doubanSearch(keyword, opts) {
  const list = [];
  const suggest = await getJson(`https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(keyword)}`,
    { headers: { 'Referer': 'https://book.douban.com/' }, timeout: opts.timeout });
  if (Array.isArray(suggest)) {
    for (const s of suggest.slice(0, 6)) {
      if (s.type && s.type !== 'b') continue;
      list.push({
        provider: 'douban', id: String(s.id || ''), title: stripTags(s.title), author: stripTags(s.author_name || ''),
        year: String(s.year || ''), coverUrl: s.pic || '', url: s.url || (s.id ? `https://book.douban.com/subject/${s.id}/` : '')
      });
    }
  }
  // 搜索页兜底（suggest 被限流时）
  if (!list.length) {
    const html = await getText(`https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(keyword)}&cat=1001`,
      { headers: { 'Referer': 'https://book.douban.com/' }, timeout: opts.timeout });
    const re = /subject\/(\d+)\/?"[^>]*>[\s\S]{0,400}?<img[^>]*src="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) && list.length < 6) {
      list.push({ provider: 'douban', id: m[1], title: '', author: '', coverUrl: m[2], url: `https://book.douban.com/subject/${m[1]}/` });
    }
  }
  return list;
}

async function doubanDetail(item, opts) {
  if (!item.url) return null;
  const html = await getText(item.url, { headers: { 'Referer': 'https://book.douban.com/' }, timeout: opts.timeout });
  if (!html) return null;
  const out = { provider: 'douban', url: item.url, coverUrl: item.coverUrl || '' };

  // JSON-LD 是最稳定的结构化来源
  const ldm = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldm) {
    try {
      const ld = JSON.parse(ldm[1].trim());
      out.title = ld.name || '';
      const authors = ld.author;
      if (Array.isArray(authors)) out.author = authors.map(a => (typeof a === 'object' ? a.name : a)).filter(Boolean).join('/');
      else if (authors) out.author = typeof authors === 'object' ? authors.name : String(authors);
      if (ld.isbn) out.isbn = String(ld.isbn).replace(/[^\dXx]/g, '');
      if (ld.publisher) out.publisher = typeof ld.publisher === 'object' ? (ld.publisher.name || '') : String(ld.publisher);
      if (ld.datePublished) out.date = String(ld.datePublished).slice(0, 10);
      if (ld.image) out.coverUrl = typeof ld.image === 'string' ? ld.image : (ld.image.url || out.coverUrl);
      if (ld.numberOfPages) out.pages = Number(ld.numberOfPages) || 0;
    } catch (_) {}
  }

  const grab = (re) => { const m = html.match(re); return m ? stripTags(m[1]) : ''; };
  if (!out.title) out.title = grab(/<span property="v:itemreviewed">([\s\S]*?)<\/span>/);
  if (!out.author) {
    const a = grab(/<span class='pl'>\s*作者<\/span>[\s\S]*?<span class="all hidden">([\s\S]*?)<\/span>/)
      || grab(/<span class='pl'>\s*作者<\/span>\s*:?\s*<a[^>]*>([^<]+)<\/a>/);
    out.author = a.replace(/\s*\/\s*/g, '/');
  }
  if (!out.publisher) out.publisher = grab(/出版社:<\/span>\s*(?:<a[^>]*>)?([^<\n]+)/);
  if (!out.date) out.date = grab(/出版年:<\/span>\s*([^<\n]+)/);
  if (!out.isbn) out.isbn = (grab(/ISBN:<\/span>\s*([\dXx-]+)/) || '').replace(/[^\dXx]/g, '');
  if (!out.pages) out.pages = Number((grab(/页数:<\/span>\s*(\d+)/) || '').trim()) || 0;

  // 简介
  const intro = html.match(/<div class="intro">([\s\S]*?)<\/div>/);
  if (intro) {
    const ps = intro[1].match(/<p>([\s\S]*?)<\/p>/g) || [intro[1]];
    out.description = stripTags(ps.map(p => p.replace(/<\/?p>/g, '')).join('\n')).slice(0, 1600);
  }
  // 豆瓣标签
  const tagBlock = html.match(/<div class="subject-tags">([\s\S]*?)<\/div>/);
  if (tagBlock) {
    const tags = [...tagBlock[1].matchAll(/>([^<>]{1,16})<\/a>/g)].map(m => stripTags(m[1])).filter(t => t && t !== '全部');
    if (tags.length) out.tags = [...new Set(tags)].slice(0, 10);
  }
  return (out.title || item.title) ? out : null;
}

async function douban(keyword, query, opts) {
  const cands = await doubanSearch(keyword, opts);
  if (!cands.length) return [];
  // 用已知书名/作者先粗排，再抓前 3 个详情
  for (const c of cands) c._s = score(c, query);
  cands.sort((a, b) => b._s - a._s);
  const out = [];
  for (const c of cands.slice(0, 3)) {
    const d = await doubanDetail(c, opts);
    if (!d) continue;
    d.title = d.title || c.title;
    d.author = d.author || c.author;
    d.score = score(d, query);
    out.push(d);
    if (d.score > 0.9) break;
  }
  return out;
}

// ---------------- 当当 ----------------
async function dangdang(keyword, query, opts) {
  const url = `http://search.dangdang.com/?key=${encodeURIComponent(keyword)}&act=input&sort_type=sort_score_desc`;
  const html = await getText(url, { headers: { 'Referer': 'http://search.dangdang.com/' }, timeout: opts.timeout });
  if (!html) return [];
  const items = [];
  // 以「书名节点」为锚点，向前后各取一段作为条目上下文（当当 DOM 结构变动频繁，锚点法更稳）
  const nameRe = /<p class="name"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = nameRe.exec(html)) && items.length < 20) {
    let title = stripTags(m[1]).replace(/\s+/g, ' ').trim();
    if (!title || title.length > 46) continue;
    const b = html.slice(Math.max(0, m.index - 1200), m.index + 1800);
    const ab = (b.match(/<p class="search_book_author">([\s\S]*?)<\/p>/i) || [])[1] || '';
    const spans = [...ab.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
      .map(x => stripTags(x[1])).filter(s => s && s !== '/');
    let author = (spans[0] || '').replace(/^著$/, '').replace(/[\[\]【】]/g, '').trim();
    if (!author) {
      const links = [...ab.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(x => stripTags(x[1])).filter(Boolean);
      author = (links[0] || '').replace(/^著$/, '').trim();
    }
    const date = (spans.find(s => /^\d{4}-\d{2}-\d{2}$/.test(s)) || '');
    const publisher = (spans.find(s => s !== spans[0] && !/^\d{4}-\d{2}-\d{2}$/.test(s) && s.length <= 20) || '');
    const coverUrl = ((b.match(/data-original="([^"]+)"/i) || b.match(/<img[^>]*src=["']([^"']+)["']/i) || [])[1] || '');
    const purl = (b.match(/href="(\/\/product\.dangdang\.com\/[^"]+)"/i) || [])[1] || '';
    items.push({
      provider: 'dangdang', title, author, publisher, date,
      coverUrl: /^https?:/.test(coverUrl) || coverUrl.startsWith('//') ? (coverUrl.startsWith('//') ? 'https:' + coverUrl : coverUrl) : '',
      url: purl ? (purl.startsWith('//') ? 'https:' + purl : purl) : '',
      score: 0
    });
  }
  for (const it of items) it.score = score(it, query);
  items.sort((a, b) => b.score - a.score);
  const best = items.slice(0, 2);
  for (const it of best) {
    if (it.url) {
      const detail = await getText(it.url, { headers: { 'Referer': 'http://search.dangdang.com/' }, timeout: opts.timeout });
      if (detail) {
        const desc = stripTags((detail.match(/<div class="descrip">([\s\S]*?)<\/div>/i) || [])[1] || '');
        if (desc) it.description = desc.slice(0, 1200);
        const isbn = (detail.match(/国际标准书号ISBN[：:]?\s*([\d-]{10,20})/i) || detail.match(/ISBN[：:]?\s*([\d-]{10,20})/i) || [])[1];
        if (isbn) it.isbn = isbn.replace(/[^\dXx]/g, '');
        const pub = stripTags((detail.match(/作\s*者[：:]?([\s\S]{0,120}?)出\s*版\s*社/i) || [])[1] || '').replace(/\s+/g, ' ');
        if (!it.author && pub) it.author = pub.split(/[\/、,，]/)[0].trim().slice(0, 40);
      }
    }
  }
  return best;
}

// ---------------- ISBN 直达（豆瓣条目页，命中率高于关键词搜索） ----------------
function cleanIsbn(s) {
  const v = String(s || '').replace(/[^\dXx]/g, '').toUpperCase();
  return (v.length === 10 || v.length === 13) ? v : '';
}

async function isbnDirect(keyword, query, opts) {
  const isbn = cleanIsbn(query.isbn) || cleanIsbn(keyword);
  if (!isbn) return [];
  // book.douban.com/isbn/<isbn>/ 会 302 到对应条目页，doubanDetail 内部会跟随跳转
  const d = await doubanDetail({ url: `https://book.douban.com/isbn/${isbn}/` }, opts);
  if (!d) return [];
  d.provider = 'isbn';
  d.isbn = d.isbn || isbn;
  d.score = score(d, Object.assign({}, query, { isbn }));
  return [d];
}

// ---------------- SaltyLeo 的书架（tstrs.me） ----------------
// 结构：搜索页 `/search/<关键词>[?scope=title|author|press|isbn]`（不带 query 参数会 302 到该形式），
//       条目页 `/b/<slug>`，页面内嵌 schema.org 的 Book JSON-LD，书名/作者/出版社/ISBN/页数/简介都齐。
// 封面在 la-img.tstrs.me，需要带 Referer。
const TSTRS = 'https://tstrs.me';
const TSTRS_HEADERS = { 'Referer': TSTRS + '/', 'Accept': 'text/html,*/*' };

/** 解析一条搜索结果行（标题/作者/出版社·年份/封面/详情链接） */
function tstrsParseRows(html) {
  const out = [];
  // 以每个条目链接为切分点，逐块取字段（DOM 改动时最多丢字段，不会整页解析崩）
  const blocks = String(html || '').split(/<a[^>]+class="search-row/).slice(1);
  for (const b of blocks) {
    if (out.length >= 12) break;
    const href = (b.match(/href="([^"]+)"/) || [])[1] || '';
    if (!/^\/b\//.test(href)) continue;
    const pick = re => {
      const m = b.match(re);
      return m ? stripTags(m[1]) : '';
    };
    const title = pick(/<span class="search-row-title"[^>]*>([\s\S]*?)<\/span>/);
    if (!title) continue;
    const author = pick(/<span class="search-row-author"[^>]*>([\s\S]*?)<\/span>/)
      .replace(/\s*\/\s*/g, '/');
    const pressRaw = pick(/<span class="search-row-press"[^>]*>([\s\S]*?)<\/span>/);
    const pm = pressRaw.match(/^(.*?)\s*·\s*(\d{4})$/);
    const coverUrl = (b.match(/data-cover-src="([^"]+)"/) || [])[1] || '';
    out.push({
      provider: 'tstrs', title, author,
      publisher: pm ? pm[1].trim() : pressRaw,
      date: pm ? pm[2] : '',
      coverUrl: /^https?:/.test(coverUrl) ? coverUrl : '',
      url: TSTRS + href,
      description: pick(/<span class="search-row-summary"[^>]*>([\s\S]*?)<\/span>/).slice(0, 400)
    });
  }
  return out;
}

async function tstrsSearch(keyword, opts) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const seen = new Set();
  const collect = (html) => {
    const out = [];
    for (const it of tstrsParseRows(html)) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      out.push(it);
    }
    return out;
  };
  // ISBN 走 scope=isbn，比按书名搜准得多；命中就不再按书名搜
  const isbn = cleanIsbn(kw);
  if (isbn) {
    const html = await getText(`${TSTRS}/search/${encodeURIComponent(isbn)}?scope=isbn`,
      { headers: TSTRS_HEADERS, timeout: opts.timeout });
    const list = html ? collect(html) : [];
    if (list.length) return list;
  }
  const html = await getText(`${TSTRS}/search/${encodeURIComponent(kw)}`,
    { headers: TSTRS_HEADERS, timeout: opts.timeout });
  return html ? collect(html) : [];
}

async function tstrsDetail(item, opts) {
  if (!item || !item.url) return null;
  const html = await getText(item.url, { headers: TSTRS_HEADERS, timeout: opts.timeout });
  if (!html) return null;
  const out = { provider: 'tstrs', url: item.url, coverUrl: item.coverUrl || '' };
  let ld = null;
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const blk of blocks) {
    const raw = blk.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').trim();
    try {
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : [j];
      const bk = arr.find(x => x && String(x['@type'] || '') === 'Book');
      if (bk) { ld = bk; break; }
    } catch (_) {}
  }
  if (ld) {
    out.title = stripTags(ld.name || ld.alternateName || '');
    if (!out.title && ld.alternateName) out.title = stripTags(ld.alternateName);
    const au = ld.author;
    if (Array.isArray(au)) out.author = au.map(a => (a && typeof a === 'object' ? a.name : a)).filter(Boolean).join('/');
    else if (au) out.author = typeof au === 'object' ? (au.name || '') : String(au);
    if (ld.publisher) out.publisher = typeof ld.publisher === 'object' ? (ld.publisher.name || '') : String(ld.publisher);
    if (ld.datePublished) out.date = String(ld.datePublished).slice(0, 10);
    if (ld.isbn) out.isbn = String(ld.isbn).replace(/[^\dXx]/g, '');
    if (ld.numberOfPages) out.pages = Number(ld.numberOfPages) || 0;
    if (ld.image) out.coverUrl = typeof ld.image === 'string' ? ld.image : ((ld.image && ld.image.url) || out.coverUrl);
    if (ld.description) out.description = stripTags(ld.description).slice(0, 1600);
    // 分类页名（如「精品小说」）当标签，仅内部留存，不写库
    if (ld.genre) out.tags = [].concat(ld.genre).map(t => stripTags(t)).filter(Boolean).slice(0, 6);
    if (ld.bookFormat) out.binding = stripTags(ld.bookFormat);
  }
  // JSON-LD 缺失时退回搜索结果字段，至少把书名/作者补上
  out.title = out.title || item.title || '';
  out.author = out.author || item.author || '';
  out.publisher = out.publisher || item.publisher || '';
  out.date = out.date || item.date || '';
  if (!out.description) out.description = item.description || '';
  if (!out.coverUrl) out.coverUrl = item.coverUrl || '';
  return out.title ? out : null;
}

async function tstrs(keyword, query, opts) {
  const cands = await tstrsSearch(keyword, opts);
  if (!cands.length) return [];
  for (const c of cands) c._s = score(c, query);
  cands.sort((a, b) => b._s - a._s);
  const out = [];
  for (const c of cands.slice(0, 3)) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const d = await tstrsDetail(c, opts);
    if (!d) continue;
    d.score = score(d, query);
    out.push(d);
    if (d.score > 0.9) break;
  }
  return out;
}

const RUNNERS = { douban, isbn: isbnDirect, dangdang, tstrs };

/** 目录名里挑一个可以当检索词的（文件名没信息量时它就是书名线索） */
function pickDirKeyword(query) {
  const nt = norm(query.title);
  for (const d of Array.isArray(query.dirs) ? query.dirs : []) {
    const nd = norm(d);
    if (nd.length < 2 || nd.length > 30) continue;
    if (/^\d+$/.test(nd)) continue;
    if (nd === nt) continue;
    return String(d).trim();
  }
  return '';
}

/**
 * 多源刮削：按供应商优先级依次尝试，返回全库最佳候选
 * 1.8.1：除书名外，还会拿「存储目录的文件夹名」当检索线索与加分依据。
 * 1.8.2：检索依据的先后顺序由调用方（scanner）决定——文件名 → 文件信息 → 路径 → 正文；
 *         传 opts.dirFallback === false 时不再内部拿目录名兜底（避免打乱优先级）。
 * @returns {{ok:boolean, data?:object, provider?:string, score:number, tried:string[], candidates:Array}}
 */
async function scrapeBook(query, providers, opts) {
  opts = Object.assign({ timeout: 12000 }, opts || {});
  ACTIVE_DEADLINE = opts.deadline || 0;
  const tried = [];
  const all = [];
  // 检索词：书名为主体；书名是「001」「(NEW)」这种没信息量的，先用目录名
  const primary = String(query.keyword || query.title || '').trim();
  const dirKw = opts.dirFallback === false ? '' : pickDirKeyword(query);
  const passes = [];
  if (!primary || /^[\d\s._\-()]+$/.test(primary)) {
    if (dirKw) passes.push(dirKw);
    if (primary) passes.push(primary);
  } else {
    passes.push(primary);
    if (dirKw) passes.push(dirKw);       // 书名搜不到时退一步用目录名
  }
  // 只有 ISBN、没有任何书名线索时，直接用 ISBN 当检索词（SaltyLeo 支持 scope=isbn）
  if (!passes.length && cleanIsbn(query.isbn)) passes.push(cleanIsbn(query.isbn));
  try {
  for (let pi = 0; pi < passes.length; pi++) {
    const kw = passes[pi];
    if (!kw) continue;
    // 第二轮（备用关键词）只在第一轮没结果时才跑，避免无谓的外网请求
    if (pi > 0) {
      all.sort((a, b) => b.score - a.score);
      if (all[0] && isAcceptable(all[0], query)) break;
      if (opts.deadline && Date.now() > opts.deadline) break;
    }
    for (const p of providers) {
      if (opts.deadline && Date.now() > opts.deadline) break; // 整次刮削预算用尽
      const fn = RUNNERS[p];
      if (!fn) continue;
      if (isDown(p)) continue;  // 30 分钟内不可达的源直接跳过
      if (!tried.includes(p)) tried.push(p);
      try {
        const meta = PROVIDERS[p] || {};
        const popts = meta.experimental
          ? Object.assign({}, opts, { timeout: Math.min(6000, opts.timeout || 6000) })
          : opts;
        const list = await fn(kw, query, popts);
        for (const it of list) if (it && it.title) all.push(it);
      } catch (e) {
        // 实验源（国图/读秀）一旦不可达就冷却，避免拖慢整批刮削
        if (PROVIDERS[p] && PROVIDERS[p].experimental) markDown(p);
      }
      // 已经有高置信结果就不再打扰后面的源（豆瓣优先级最高）
      const bestSoFar = all.slice().sort((a, b) => b.score - a.score)[0];
      if (bestSoFar && bestSoFar.score >= 0.92) break;
    }
  }
  all.sort((a, b) => b.score - a.score);
  const best = all[0];
  if (!best || !isAcceptable(best, query)) return { ok: false, score: best ? best.score : 0, tried, candidates: all.slice(0, 6), keywords: passes };
  return { ok: true, data: best, provider: best.provider, score: best.score, tried, candidates: all.slice(0, 6), keywords: passes };
  } finally { ACTIVE_DEADLINE = 0; }
}

/** 是否可信：ISBN 一致 / 书名高度相似且作者对得上 / 作者高度一致 + 书名相似 */
function isAcceptable(best, query) {
  if (!best || !best.title) return false;
  if (query.isbn && best.isbn && norm(query.isbn) === norm(best.isbn)) return true;
  const st = similarity(best.title, query.title);
  const sa = query.author ? similarity(best.author, query.author) : 1;
  if (best.score >= 0.9 && st >= 0.75) return true;
  if (st >= 0.9 && (!query.author || !best.author || sa >= 0.5)) return true;
  if (st >= 0.72 && (query.author ? sa >= 0.6 : true)) return true;
  return false;
}

// ---------------- 封面下载 ----------------
async function downloadCover(url, coversDir, bookId, timeout, opts) {
  if (!url) return null;
  // 各家图床的防盗链域名不同：SaltyLeo 的图在 la-img.tstrs.me，Referer 必须是 tstrs.me
  const referer = /tstrs\.me/.test(String(url)) ? 'https://tstrs.me/' : 'https://book.douban.com/';
  const r = await request(url, Object.assign({
    timeout: timeout || 15000,
    headers: { 'Referer': referer, 'Accept': 'image/*,*/*' }
  }, opts || {}));
  if (!r || r.status !== 200 || !r.body || r.body.length < 800) return null;
  const buf = r.body;
  // 识别真实格式（豆瓣图片常带 .jpg 后缀但内容是 webp）
  let ext = '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') ext = '.webp';
  else if (buf[0] === 0xFF && buf[1] === 0xD8) ext = '.jpg';
  else if (buf.slice(0, 3).toString('ascii') === 'GIF') ext = '.gif';
  else return null;
  try {
    for (const old of ['.jpg', '.png', '.webp', '.gif']) {
      try { fs.unlinkSync(path.join(coversDir, bookId + old)); } catch (_) {}
    }
    fs.writeFileSync(path.join(coversDir, bookId + ext), buf);
    return ext;
  } catch (_) { return null; }
}

module.exports = { PROVIDERS, scrapeBook, downloadCover, score, similarity, request, getText, getJson, norm, pickDirKeyword };
