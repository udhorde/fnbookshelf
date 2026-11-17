// 作品归并键
// 1.8.0 规则：
//   · 默认只看书名——同名书扫描完就先合并在一起（用户要求：先并，确认不是同一本再分）
//   · grouping.regroup() 在扫描后做二次判定：同名组里出现两个不同的真实作者（刮削/元数据确认）
//     才拆开，拆开后的键带上作者，之后保持稳定
//   · 同一目录、文件名只差期号的一组书 → series: 键，书名统一成「XXX 系列」
'use strict';

const PLACEHOLDER = /^(未知作者|未知|佚名|无名|匿名|作者不详|不详|系统|管理员|anonymous|unknown|none|null|admin|administrator|administrators|root|user|system)$/i;

function normTitle(title) {
  return String(title || '')
    .replace(/[\(\[（【].*?[\)\]）】]/g, '')
    .replace(/[\s\-_·:：,，.。!！?？'"“”‘’《》<>]/g, '')
    .replace(/(第[\d一二三四五六七八九十百]+[卷册部集版]|全\d+[册卷]|插图|精校|校对|合集|套装|epub|mobi|pdf|azw3|txt|扫描版)/gi, '')
    .toLowerCase()
    .slice(0, 60);
}

function normAuthor(author) {
  return String(author || '')
    .replace(/[\[\(（【].*?[\)\]）】]/g, '')
    .replace(/[\s·,，、;；]/g, '')
    .replace(/著|编著|主编|译|等人?$/g, '')
    .toLowerCase()
    .slice(0, 30);
}

function isPlaceholderAuthor(author) {
  const s = String(author || '').trim();
  if (!s) return true;
  if (PLACEHOLDER.test(s)) return true;
  const n = normAuthor(s);
  return !n || PLACEHOLDER.test(n);
}

/** 基础归并键：只看书名（同名先合并） */
function workKey(title) {
  return (normTitle(title) || 'untitled') + '@*';
}

/** 拆分后的键：书名 + 作者 */
function authorKey(title, author) {
  return (normTitle(title) || 'untitled') + '@' + (normAuthor(author) || 'unknown');
}

/** 系列的归并键 */
function seriesKey(stem) {
  return 'series:' + ((normTitle(stem) || 'series').slice(0, 60));
}

/** 手动分离时用的唯一键（不会自动并回原作品） */
function uniqueKey(book) {
  return (normTitle(book && book.title) || 'untitled') + '@#' + String((book && book.id) || '').slice(0, 8);
}

/**
 * 1.9.3：把「同一部作品的不同卷/册」看成一组用的基名。
 * 只剥掉尾部的卷册编号（卷1 / 第2册 / Vol.3 / (3) / Ⅲ 等），其余原样保留。
 * 用在「合并候选」里：同一目录 + 基名相同 → 视为同一部作品，可以一次性全部合并。
 * 注意这里**不做** normTitle 的通用清理（它会把《1984》之类也抹掉），只针对明确的卷次后缀。
 */
function volumeBase(title) {
  let s = String(title || '')
    .replace(/[\(\[（【]\s*\d{1,3}\s*[\)\]）】]\s*$/, '')           // (3) [2]
    .replace(/\s*[Vv][Oo][Ll]\.?\s*\d{1,3}\s*$/, '')                 // Vol.3 / vol 3
    .replace(/\s*卷\s*\d{1,3}\s*$/, '')                              // 甲作品 卷1
    .replace(/\s*(第\s*)?\d{1,3}\s*[卷册部集辑篇]\s*$/i, '')         // 第3卷 / 3册
    .replace(/\s*[上中下]\s*[册卷部]?\s*$/, '')                       // 上/中/下（含 上册）
    .replace(/\s*[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*$/, '')                           // 罗马数字
    .trim();
  // 剥离后为空、或原书名本身就被 normTitle 吃掉（如整本就叫「第3卷」）时，
  // 用未清理的原字符串当基名，避免一堆书都变成 untitled 互相误并
  const nt = normTitle(s);
  if (nt) return nt;
  const raw = String(title || '').replace(/\s+/g, '').toLowerCase().slice(0, 60);
  return raw || 'untitled';
}

/** 同一部作品（同目录 + 同基名）的聚合键；dirKey 由调用方给出（如所在目录） */
function familyKey(title, dirKey) {
  return String(dirKey || '') + '|' + volumeBase(title);
}

/**
 * 1.9.3：更宽松的一层——「同目录 + 书名主干」。
 * 用户的多文件书常常是《戊作品-alpha / -beta / -gamma》《XXX (上)/(下)》《XXX 第一册/第二册》，
 * 主标题是中文/拉丁词，后面跟的编号写法五花八门，逐条列正则永远列不完。
 * 做法：剥掉卷册/分册/罗马数字/序号/(数字)/-字母 这些尾巴后，取前 4 个「词」当主干。
 * 中文没有空格，所以按「连续同类字符」切块（汉字块 / 拉丁块 / 数字块），
 * 只保留前面最长的 1~2 个汉字块（书名主体几乎都在开头）。
 * 注意：主干过短（< 2 字）时不返回，避免「上」「卷」之类被当成主干把无关书并到一起。
 */
function coreKey(title, dirKey) {
  const raw = String(title || '');
  let s = raw
    .replace(/[\(\[（【][^\)\]）】]{0,12}[\)\]）】]\s*$/, '')          // (上) [2] （新版）
    .replace(/[\s\-_·—]*(alpha|beta|gamma|delta|part|book|vol\.?)\s*[\dA-Za-z]*$/i, '')
    .replace(/[\s\-_·—]*[A-Za-z]{1,10}$/, '')
    .replace(/[\s\-_·—]*(第\s*)?[\d一二三四五六七八九十百零〇]{1,3}\s*[卷册部集辑篇册修订版]*$/g, '')
    .replace(/[\s\-_·—]*(第\s*)?[\d一二三四五六七八九十百零〇]{1,3}\s*$/g, '')
    .replace(/[\s\-_·—]*[上中下](册|卷|部|篇)?$/g, '')
    .replace(/[\s\-_·—]*[IVXLCDM]{1,6}$/, '')
    .trim();
  const blocks = s.match(/[\u4e00-\u9fa5]+|\d{2,}|[A-Za-z]{2,}/g) || [];
  if (!blocks.length) return '';
  // 中文书名主体几乎都在开头，取第一块；
  // 拉丁书名取前两块（A Game of Thrones → "a game"，避免只剩 "a"/"the" 这类冠词）
  let head = blocks[0];
  const isLatin = w => /^[A-Za-z]+$/.test(w);
  if (isLatin(blocks[0]) && blocks[1] && isLatin(blocks[1])) {
    head = blocks[0] + ' ' + blocks[1];
  }
  const core = head.replace(/\s+/g, ' ').toLowerCase().trim();
  // 全是冠词的拉丁主干不可用（The Hobbit → "the"）
  if (/^(the|a|an|of|and|to|in|on)(\s|$)/.test(core) && core.split(' ').length < 2) return '';
  if (core.replace(/\s/g, '').length < 2) return '';
  return String(dirKey || '') + '#core:' + core;
}

module.exports = {
  workKey, authorKey, seriesKey, uniqueKey, normTitle, normAuthor, isPlaceholderAuthor,
  volumeBase, familyKey, coreKey
};
