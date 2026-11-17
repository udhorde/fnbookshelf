// 自动归并：把「同名书」和「同一系列（同一目录、文件名只差期号/年份）」合到同一部作品下。
//
// 1.8.0 用户现场：NAS 里一整批《人民日报》2015 年第 1…14 期各自成了一本书，
// 书名只差期号，作者又都是 Administrator。这里按「目录 + 去掉期号后的书名」聚合，
// 命名为「2015年《人民日报》系列」，各期作为版本出现在同一个详情页里。
//
// 规则：
//   ① 同一目录（或目录名只差数字/标点，即「相似路径」）+ 去掉期号后同名的书 → 系列
//   ② 系列里至少要有两种不同的原始书名（完全同名的交给「同名合并」，不必叫系列）
//   ③ 每个系列只改「书名 / 归并键 / series 字段」，不动源文件、不动手动改过的书名
//   ④ groupLocked（手动合并或分离过的书）永远不自动调整
'use strict';
const path = require('path');
const taxonomy = require('./taxonomy');

// 结尾的「第 5 期 / 卷三 / 2015 年 / Vol.2 / 上册」这类序号
const ISSUE_TAIL = /[\s\-_·:：,，]*[（(\[【]?\s*(?:第\s*[0-9０-９一二三四五六七八九十百千零〇两]+\s*(?:期|卷|册|部|集|版|话|回|章|节|篇|辑|季|号)|[0-9]{4}\s*年|[0-9]{1,3}\s*[期卷册部集话回章节篇辑]|vol\.?\s*[0-9]+|no\.?\s*[0-9]+|part\s*[0-9]+|ep\.?\s*[0-9]+|season\s*[0-9]+|全\s*[0-9]+\s*[册卷]|[上中下](?:册|部|卷)?)\s*[)）\]】]?\s*$/i;

/** 去掉书名/文件名结尾的期号、卷号、年份 */
function stripIssue(name) {
  let s = String(name || '').replace(/\.[^.]+$/, '').trim();
  let prev;
  do { prev = s; s = s.replace(ISSUE_TAIL, '').trim(); } while (s && s !== prev);
  return s.replace(/[\s\-_·:：,，.。]+$/, '').trim();
}

/** 归一化名称：去掉数字与标点，用于判断「相似」 */
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/[0-9０-９]+/g, '')
    .replace(/[\s\-_·:：,，.。!！?？'"“”‘’《》<>()（）\[\]【】]/g, '');
}

/**
 * 1.9.1：判断两个书名是否「就是同一本」。
 * 比 normName 宽松（保留数字，允许全/半角、空格、标点差异），用于扫描后的同名合并，
 * 也用于刮削回填书名后的一次性收口。
 */
function sameTitle(a, b) {
  const f = s => String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@\[-`{-~！-／：-＠［-｀｛-～、。，．·—－“”‘’《》〈〉()（）\[\]【】]/g, '')
    .toLowerCase();
  const x = f(a), y = f(b);
  if (!x || !y) return false;
  return x === y;
}

/** 归一化目录：逐级去掉数字与标点，路径只差期号/编号也算同一个目录 */
function normDir(dir) {
  return String(dir || '').replace(/[\\/]+/g, '/').split('/')
    .map(normName).filter(Boolean).join('/');
}

/** 去掉数字（用于给「年份不同但书名相同」的一组书取共同系列名） */
function stripDigits(s) {
  return String(s || '').replace(/[0-9０-９]+/g, '').replace(/[\s\-_·:：,，.。]+$/, '').trim();
}

function groupKeyOf(book) {
  const stem = stripIssue(book.title) || stripIssue(book.filename);
  if (!stem) return null;
  return normDir(path.dirname(book.path || '')) + '|' + normName(stem);
}

/**
 * 1.9.1：扫描后的「同名合并」。
 * 用户要求「同名书籍自动合并在一起，刮削后同名的也自动合并，每次扫描都检测」。
 * 这里不看作者（重名作者造成的误并，管理员可以在详情页「分离」还原），
 * 只跳过：已锁定分组的、手动分离过的（uniqueKey）、以及已经被判为不同作品的书。
 * @returns {{merged:number, groups:number}}
 */
function mergeSameTitle(store) {
  const books = (store.books || []).filter(b => b.status !== 'hidden');
  const buckets = new Map();
  for (const b of books) {
    if (b.groupLocked) continue;
    const k = taxonomy.normTitle(b.title);
    if (!k || k === 'untitled') continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  if (!buckets.size) return { merged: 0, groups: 0 };
  const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0) + (x.isbn ? 1 : 0) + (x.tocCount ? 1 : 0);
  let merged = 0, groups = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    // 同一部作品里已经有多本了才算「需要合并」——先按现有 workKey 分组
    const byKey = new Map();
    for (const b of list) {
      const k = b.workKey || ('id:' + b.id);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(b);
    }
    if (byKey.size < 2) continue;
    // 已经明确判为不同作品（键里带作者、且作者是真的不同）的，不再硬并
    const authorKeys = [...byKey.keys()].filter(k => /@(?!\*$)/.test(k));
    if (authorKeys.length >= 2) {
      const names = new Set(authorKeys.map(k => k.split('@')[1]));
      if (names.size >= 2) continue;
    }
    const target = list.slice().sort((a, b) => score(b) - score(a) || (a.addedAt || 0) - (b.addedAt || 0))[0];
    const key = target.workKey || taxonomy.workKey(target.title, target.author);
    target.workKey = key;
    let n = 0;
    for (const b of list) {
      if (b.id === target.id || b.workKey === key) continue;
      b.workKey = key;
      b.series = b.series || '';
      b.updatedAt = Date.now();
      b.sameTitleAuto = true;
      n++;
    }
    if (n) { merged += n; groups++; }
  }
  return { merged, groups };
}

/**
 * 刮削回填书名后调用：这本书的新书名如果和另一部作品的同名，
 * 把两边并起来（只动 workKey，不移动文件）。
 * @returns {object|null} 合并到的目标书
 */
function mergeAfterRename(store, book) {
  if (!book || book.status === 'hidden' || book.groupLocked) return null;
  const k = taxonomy.normTitle(book.title);
  if (!k || k === 'untitled') return null;
  const curKey = book.workKey || ('id:' + book.id);
  const others = (store.books || []).filter(x =>
    x.id !== book.id && x.status !== 'hidden' && taxonomy.normTitle(x.title) === k &&
    (x.workKey || ('id:' + x.id)) !== curKey);
  if (!others.length) return null;
  const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0) + (x.isbn ? 1 : 0) + (x.tocCount ? 1 : 0);
  const pool = [book, ...others];
  const target = pool.slice().sort((a, b) => score(b) - score(a))[0];
  const key = target.workKey || taxonomy.workKey(target.title, target.author);
  // 只并「同名的那一组」：其它同名作品的版本一起挪过来，不同名的（别的书名）不碰
  for (const b of pool) {
    if (b.groupLocked) continue;
    b.workKey = key;
    b.sameTitleAuto = true;
    b.updatedAt = Date.now();
  }
  store.save();
  return target;
}
function regroup(store) {
  const books = (store.books || []).filter(b => b.status !== 'hidden');
  const stat = { series: 0, merged: 0, renamed: 0 };

  // 1) 清掉上一轮自动标记的系列，重新判定（手动锁定 / 手动改名的保留原名）
  for (const b of books) {
    if (b.groupLocked) continue;
    if (b.seriesAuto) {
      b.series = '';
      b.seriesAuto = false;
      // 还原成加「 系列」之前的书名（存过就用存档，没存过才退化为去掉后缀）
      if (!(b.manual && b.manual.title)) {
        if (b.titleBeforeSeries) { b.title = b.titleBeforeSeries; b.titleBeforeSeries = ''; }
        else if (/ 系列$/.test(b.title || '')) b.title = b.title.replace(/ 系列$/, '');
      }
    }
  }

  // 2) 按「目录 + 去期号书名」聚合
  const groups = new Map();
  for (const b of books) {
    if (b.groupLocked) continue;
    const key = groupKeyOf(b);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const inSeries = new Set();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // 「是同一系列的不同分册」的证据（注意：这里不能用 normName，它会把数字抹掉，
    // 而期号/年份恰恰是各期唯一的区别）：
    //   a) 文件名里带期号/卷号/年份  → 《人民日报》第 1…8 期
    //   b) 去掉期号后的文件名归一化后相同、但其中的数字不同  → 2013/2014 人民日报社论
    // 同一本书的不同格式（.pdf/.epub）或副本（“xxx (1).txt”）没有以上证据，不进系列，
    // 交给后面的「同名合并」。
    const stemsRaw = list.map(b => String(stripIssue(b.filename) || String(b.filename || '').replace(/\.[^.]+$/, '')).trim());
    const hasIssue = list.some(b => stripIssue(b.filename) !== String(b.filename || '').replace(/\.[^.]+$/, '').trim());
    const normStems = new Set(stemsRaw.map(normName).filter(Boolean));
    const digests = new Set(stemsRaw.map(s => normName(s) + '#' + (String(s).match(/[0-9]+/g) || []).join(',')));
    // 文件名之间必须「只差数字」（gbk.txt / utf8.txt 这种完全不同名的不算系列）
    if (!hasIssue && (normStems.size !== 1 || digests.size < 2)) continue;
    // 书名可能已经被上一轮改成「XXX 系列」，所以优先从原始文件名取系列名
    const stems = [...new Set(stemsRaw.filter(Boolean)
      .concat(list.map(b => stripIssue(b.title)).filter(Boolean)))];
    // 只有一种写法（各期文件名只差期号）→ 直接用它；多种写法（2013/2014）→ 抹掉数字取公共名
    const stemSet = [...new Set(stemsRaw.filter(Boolean))];
    let name = stemSet.length <= 1 ? (stemSet[0] || stems[0] || '') : (stripDigits(stemSet[0]) || stems[0] || '');
    name = String(name).replace(/\s*系列$/, '').trim();
    if (!name) continue;
    for (const b of list) {
      b.series = name;
      b.seriesAuto = true;
      b.workKey = taxonomy.seriesKey(name);
      if (!(b.manual && b.manual.title)) {
        const want = name + ' 系列';
        if (b.title !== want) {
          if (!b.titleBeforeSeries) b.titleBeforeSeries = b.title;
          b.title = want;
          stat.renamed++;
        }
      }
      inSeries.add(b.id);
      stat.merged++;
    }
    stat.series++;
  }

  // 3) 其余按「书名」先合并，再在同名组里判断是否其实是不同的书
  const byTitle = new Map();
  for (const b of books) {
    if (b.groupLocked || inSeries.has(b.id)) continue;
    const k = taxonomy.workKey(b.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(b);
  }
  for (const [baseKey, list] of byTitle) {
    if (list.length === 1) { list[0].workKey = baseKey; continue; }
    // 同名组里出现两个不同的真实作者 → 刮削/元数据已确认不是同一本书，拆开
    const authors = new Map();
    for (const b of list) {
      if (taxonomy.isPlaceholderAuthor(b.author)) continue;
      const a = taxonomy.normAuthor(b.author);
      if (!authors.has(a)) authors.set(a, 0);
      authors.set(a, authors.get(a) + 1);
    }
    if (authors.size <= 1) {
      for (const b of list) b.workKey = baseKey;
      continue;
    }
    for (const b of list) {
      b.workKey = taxonomy.isPlaceholderAuthor(b.author)
        ? baseKey
        : taxonomy.authorKey(b.title, b.author);
    }
    stat.split = (stat.split || 0) + 1;
  }
  // 3) 1.9.1：同名合并（用户要求「同名书籍自动合并在一起」）
  //    在系列判定之后做一次，把书名完全一致、但归并键还不一致的书合到同一部作品。
  const st = mergeSameTitle(store);

  return Object.assign(stat, { sameTitleMerged: st.merged, sameTitleGroups: st.groups });
}

module.exports = { regroup, mergeSameTitle, mergeAfterRename, sameTitle, stripIssue, normName, normDir, groupKeyOf };
