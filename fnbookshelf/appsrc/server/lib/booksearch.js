// 书库本地检索（1.8.1）
//
// 背景：原来的「AI 找书」把书库前 60 本塞给模型，2000 本的书库等于只有最近入库的
// 60 本参与检索，所以用户问什么都只能瞎猜。现在改成两段式：
//   ① 本地召回：对**整个书库**做中文二元组 + 英文词的加权检索，永远能出结果；
//   ② AI 重排（可选）：只把本地前 40 个候选交给模型挑并给理由。
// AI 不可用/超时/额度用尽时，直接返回本地结果——这才是「找书」该有的行为。
'use strict';

// 查询里的口水词（整词去掉，不参与召回）
const STOP_WORDS = new Set([
  '我想', '我想找', '想找', '想看', '想读', '帮我', '给我', '推荐', '找一本', '有没有',
  '类似', '类似的书', '关于', '一本', '一本关于', '的书', '书籍', '图书', '书', '小说',
  '那种', '这种', '比较', '偏', '一点', '一些', '可以', '能够', '适合', '什么', '哪些',
  '好看', '不错', '经典', '入门', '通俗', '易读', '轻松', '深度', '系统', '全面'
]);

const FIELD_WEIGHT = { title: 6, author: 3.2, series: 3, publisher: 2.2, dirs: 1.6, filename: 2, desc: 1 };

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const WORD = /[a-z0-9][a-z0-9+#.-]*/g;

/** 查询 / 文档 → 检索词（中文二元组 + 英文数字词） */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  for (const w of s.match(WORD) || []) if (w.length >= 2) out.push(w);
  return out;
}

/** 去掉查询里的口水词，避免「我想找一本讲…的书」被「的书」这类词带偏 */
function cleanQuery(q) {
  let s = String(q || '').toLowerCase().trim();
  for (const w of [...STOP_WORDS].sort((a, b) => b.length - a.length)) s = s.split(w).join(' ');
  return s.replace(/[，。、；：！？,.;:!?"'“”‘’《》()（）\[\]【】]/g, ' ').trim();
}

function bookFields(b, dirsOf) {
  return {
    title: b.title || '',
    author: b.author || '',
    series: b.series || '',
    publisher: b.publisher || '',
    filename: b.filename || '',
    dirs: dirsOf ? dirsOf(b.path).join(' ') : '',
    desc: String(b.description || '').slice(0, 300)
  };
}

/**
 * 建立检索索引（按「书数 + 标题总长」做签名，变了就重建；2000 本约 40ms）
 */
let CACHE = { sig: '', docs: [], df: new Map(), avgLen: 1 };

function buildIndex(books, dirsOf) {
  const sig = books.length + '|' + books.reduce((n, b) => n + String(b.title || '').length, 0);
  if (CACHE.sig === sig) return CACHE;
  const docs = [];
  const df = new Map();
  let totalLen = 0;
  for (const b of books) {
    const fields = bookFields(b, dirsOf);
    const tf = new Map();
    let len = 0;
    for (const [f, text] of Object.entries(fields)) {
      const toks = tokenize(text);
      len += toks.length;
      const w = FIELD_WEIGHT[f] || 1;
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + w);
    }
    totalLen += len || 1;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ book: b, tf, len: len || 1 });
  }
  CACHE = { sig, docs, df, avgLen: totalLen / Math.max(1, docs.length) };
  return CACHE;
}

/**
 * 全库检索
 * @returns {{items:Array<{book:object,score:number,hits:string[]}>, matched:number}}
 */
function search(books, query, limit, dirsOf) {
  const q = cleanQuery(query);
  const terms = [...new Set(tokenize(q))];
  if (!terms.length) return { items: [], matched: 0 };
  const idx = buildIndex(books, dirsOf);
  const N = idx.docs.length || 1;
  const scored = [];
  for (const d of idx.docs) {
    let s = 0;
    const hits = [];
    for (const t of terms) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      const df = idx.df.get(t) || 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = tf / (tf + 1.2 * (0.35 + 0.65 * d.len / idx.avgLen));
      s += idf * norm;
      hits.push(t);
    }
    if (s > 0) {
      // 整串出现在书名/简介里，权重再抬一档
      const nq = q.replace(/\s+/g, '');
      if (nq.length >= 2) {
        const t = String(d.book.title || '').toLowerCase();
        if (t.includes(nq)) s += 3.5;
        else if (String(d.book.description || '').toLowerCase().includes(nq)) s += 1.2;
      }
      scored.push({ book: d.book, score: s, hits });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { items: scored.slice(0, limit), matched: scored.length };
}

/** 把命中的二元组拼回人能看懂的关键词（相邻合并） */
function readKeywords(hits) {
  const out = [];
  for (const t of hits.slice(0, 8)) {
    if (!/^[\u4e00-\u9fff]{2}$/.test(t)) { out.push(t); continue; }
    const last = out[out.length - 1];
    if (last && /[\u4e00-\u9fff]/.test(last) && last.slice(-1) === t[0]) out[out.length - 1] = last + t[1];
    else out.push(t);
  }
  // 去重、丢掉被更长词包含的
  const uniq = [...new Set(out)];
  return uniq.filter(w => !uniq.some(o => o !== w && o.includes(w))).slice(0, 4);
}

module.exports = { search, tokenize, cleanQuery, readKeywords };
