// 图书扫描器：遍历管理员配置的 NAS 路径，关联读取（不搬运、不重命名）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const meta = require('./meta');
const scrape = require('./scrape');
const sample = require('./sample');
const taxonomy = require('./taxonomy');
const tocLib = require('./toc');
const safeio = require('./safeio');
const grouping = require('./grouping');
const mojibake = require('./mojibake');
const pdfcover = require('./pdfcover');
const logger = require('./logger');

const SCAN_MAX_MS = 30 * 60 * 1000;      // 单次扫描整体上限 30 分钟
const BOOK_MAX_MS = 60 * 1000;           // 单本书处理上限 1 分钟
const SCRAPE_BUDGET_MS = 8 * 60 * 1000;  // 单次扫描刮削总预算 8 分钟
const ZIP_EXTS = ['epub', 'pptx', 'ppt', 'docx', 'cbz'];
const PROGRESS_EVERY = 10;               // 每处理 10 本写一次进度心跳（崩溃取证）
const SAVE_EVERY = 50;                   // 每 50 本落一次盘（大书库整份 JSON 写盘很重，别每 10 本就写）
// 内存护栏（1.8.2 下调）：3 万多本的书库光 books 数组就要 200MB+，
// 原来 384MB 的硬线经常是「刚判超限、还没来得及收尾就被系统 OOM 杀掉」。
const MEM_SOFT_MB = 240;                 // RSS 超过此值暂停片刻，让 GC 回收
const MEM_HARD_MB = 320;                 // RSS 超过此值提前结束本轮，避免被系统 OOM 杀掉
const BATCH_SIZE = 40;                   // 自动扫描单轮最多处理多少本（分批，缩短单次压力）

class Scanner {
  constructor(store) {
    this.store = store;
    this.state = {
      running: false, scanned: 0, added: 0, updated: 0, removed: 0, total: 0,
      scraped: 0, refined: 0, errors: [], log: [], finishedAt: null, phase: '',
      more: false, batch: 0, rssMB: 0, lastBook: ''
    };
  }

  /** 内存阈值可由后台设置覆盖（NAS 内存差异较大） */
  get memLimits() {
    const s = (this.store.data.settings && this.store.data.settings.scan) || {};
    return {
      soft: Math.max(128, Number(s.memSoftMB) || MEM_SOFT_MB),
      hard: Math.max(192, Number(s.memHardMB) || MEM_HARD_MB),
      batch: Math.max(10, Number(s.batchSize) || BATCH_SIZE)
    };
  }

  /** 把「当前正在处理什么」写进 running.json，进程被强杀后重启可直接读出崩溃现场 */
  _note(phase, scanned, total) {
    const m = process.memoryUsage();
    const rssMB = Math.round(m.rss / 1048576);
    this.state.rssMB = rssMB;
    this.log.noteProgress({
      phase, scanned, total,
      lastBook: this.state.lastBook || '',
      rssMB, heapMB: Math.round(m.heapUsed / 1048576),
      context: this.log.getContext()
    });
  }

  getStatus() { return Object.assign({}, this.state, { log: this.state.log.slice(-30) }); }

  get log() { return logger.get(); }

  _log(msg, level) {
    const line = `${new Date().toLocaleTimeString('zh-CN')} ${msg}`;
    this.state.log.push(line);
    if (this.state.log.length > 200) this.state.log.shift();
    if (level === 'warn') this.log.warn('scanner', msg);
    else if (level === 'error') this.log.error('scanner', msg);
    else this.log.info('scanner', msg);
  }

  get scrapeCfg() { return this.store.data.settings.scrape || {}; }

  /** 1.8.0：后台可配置「不入库的后缀」 */
  get excludedExts() {
    const l = (this.store.data.settings && this.store.data.settings.library) || {};
    const list = Array.isArray(l.excludeExts) ? l.excludeExts : [];
    return new Set(list.map(x => String(x || '').toLowerCase().replace(/^\./, '').trim()).filter(Boolean));
  }
  get providers() {
    const s = this.scrapeCfg;
    const list = Array.isArray(s.providers) && s.providers.length ? s.providers : [s.provider || 'douban'];
    return list.filter(p => scrape.PROVIDERS[p]);
  }

  scan(opts) {   // 注意：必须是同步函数，否则 res.json(Promise) 会变成 {}
    this.force = !!(opts && opts.force);
    this.source = (opts && opts.source) || 'manual';
    const lim = this.memLimits;
    this.batchLimit = Number(opts && opts.limit) || (opts && opts.batched ? lim.batch : 0);
    if (this.state.running) return { started: false, message: '扫描正在进行中' };
    this.state = {
      running: true, scanned: 0, added: 0, updated: 0, removed: 0, total: 0,
      scraped: 0, refined: 0, errors: [], log: [], finishedAt: null, phase: '收集文件',
      more: false, batch: 0, rssMB: 0, lastBook: ''
    };
    const startedAt = Date.now();
    const deadline = startedAt + SCAN_MAX_MS;
    this._scrapeDeadline = 0;   // 扫描不再联网刮削，由 scrapeworker 在后台闲时补全
    this._abort = false;
    this._excluded = this.excludedExts;
    this.log.setContext(`扫描(${this.source})`);
    this._log(`扫描开始（${this.source}${this.force ? ' · 强制重扫' : ''}${this.batchLimit ? ' · 本轮上限 ' + this.batchLimit + ' 本' : ''}），只做本地解析、扫完即入库；在线信息由后台闲时补全`);
    this._note('收集文件', 0, 0);
    this._watchdog = setTimeout(() => {
      if (!this.state.running) return;
      this._abort = true;
      this._log('扫描超过 30 分钟，已自动中止以免长期占用资源', 'error');
    }, SCAN_MAX_MS);
    if (this._watchdog.unref) this._watchdog.unref();

    (async () => {
      try {
        const paths = this.store.data.settings.paths.filter(p => p.enabled !== false);
        // 1. 收集文件
        const files = [];
        for (const p of paths) {
          if (this._abort) break;
          try { await this._walk(p.path, files); }
          catch (e) {
            this.state.errors.push(`无法访问路径 ${p.path}: ${e.message}`);
            this._log(`无法访问路径 ${p.path}: ${e.message}`, 'warn');
          }
        }
        this.state.total = files.length;
        this._log(`发现 ${files.length} 个图书文件`);
        this.log.flush();
        this.state.phase = '解析元数据';
        this._note('解析元数据', 0, files.length);
        // 2. 建立索引映射
        const existing = new Map(this.store.books.map(b => [b.path, b]));
        // 1.6.0：转换产物既是「可跳过的派生源文件」，又是书库里的一个版本记录，
        // 因此跳过解析的同时必须放进 seen，否则下一轮清理会把它从索引里删掉。
        const generated = new Set();
        for (const b of this.store.books) {
          if (b.imagePdf && b.imagePdf.path) generated.add(path.resolve(b.imagePdf.path));
          if (b.convert && b.convert.path) generated.add(path.resolve(b.convert.path));
          if (b.generated && b.path) generated.add(path.resolve(b.path));
        }
        const seen = new Set();
        let batch = 0;           // 本轮真正解析的文件数（跳过未变更的不计）
        let incomplete = false;  // 本轮未扫完（分批 / 内存保护 / 超时）
        for (const f of files) {
          if (this._abort || Date.now() > deadline) {
            if (!this._abort) this._log('扫描达到时间上限，提前结束', 'warn');
            this._abort = true;
            break;
          }
          if (this.batchLimit && batch >= this.batchLimit) {
            incomplete = true;
            this._log(`本轮已解析 ${batch} 本，达到分批上限，剩余文件下轮继续`, 'warn');
            break;
          }
          if (generated.has(path.resolve(f))) { seen.add(f); this.state.scanned++; continue; }
          if (meta.extOf(f) === 'pdf' && this._isGeneratedPdf(f)) { seen.add(f); this.state.scanned++; continue; }
          seen.add(f);
          // 每个文件处理前让出事件循环，避免长时间扫描阻塞网页请求
          await new Promise(r => setImmediate(r));
          const st = await fs.promises.stat(f).catch(() => null);
          if (!st) { this.state.scanned++; continue; }
          const old = existing.get(f);
          if (old && !this.force && old.mtime === st.mtimeMs && old.size === st.size) {
            this.state.scanned++;
            continue;
          }
          // 记录现场：万一进程被 OOM killer 强杀，重启后能直接读到「最后在处理哪本书」
          this.state.lastBook = path.basename(f);
          this._note('解析元数据', this.state.scanned, files.length);
          const t0 = Date.now();
          try {
            const book = await this._withTimeout(this._buildBook(f, st, old), BOOK_MAX_MS);
            if (book) {
              this.store.upsertBook(book);
              old ? this.state.updated++ : this.state.added++;
              this._log(`${old ? '更新' : '新增'}：${book.title}`);
            }
          } catch (e) {
            this.state.errors.push(`${path.basename(f)}: ${e.message}`);
            this._log(`处理失败 ${path.basename(f)}：${e.message}`, 'warn');
          }
          const spent = Date.now() - t0;
          if (spent > 8000) this._log(`单本解析耗时 ${Math.round(spent / 1000)} 秒：${this.state.lastBook}`, 'warn');
          this.state.scanned++;
          batch++;
          this.state.batch = batch;
          // 内存护栏：每本都看一眼（大 PDF / PPT 单本也可能瞬间拉高 RSS），
          // 但心跳与落盘按批做——3 万本的书库整份 JSON 有 50MB，每 10 本就写盘等于自己拖垮自己。
          const rssNow = Math.round(process.memoryUsage().rss / 1048576);
          if (rssNow > lim.hard) {
            this.state.rssMB = rssNow;
            this._log(`内存达到 ${rssNow}MB（保护上限 ${lim.hard}MB），本轮提前结束并落盘，剩余文件下轮继续`, 'warn');
            try { await this.store.flushNow(); } catch (_) {}
            this._note('解析元数据', this.state.scanned, files.length);
            incomplete = true;
            break;
          }
          if (batch % PROGRESS_EVERY === 0) {
            const rssMB = rssNow;
            this.state.rssMB = rssMB;
            this.log.info('scanner',
              `扫描进度 ${this.state.scanned}/${files.length} · 最近《${this.state.lastBook}》 · RSS ${rssMB}MB · 用时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
            this.log.flush();
            this._note('解析元数据', this.state.scanned, files.length);
            if (rssMB > lim.soft) {
              this._log(`内存偏高 ${rssMB}MB，短暂暂停以便回收`, 'warn');
              await new Promise(r => setTimeout(r, 800));
            }
            if (batch % SAVE_EVERY === 0) this.store.save();
          }
        }
        // 扫完所有文件（且未提前中止）才算完整一轮
        this.state.more = incomplete || this._abort;
        // 3. 清理已删除文件（分批未扫完 / 异常中止时不清，避免误删索引）
        if (!this._abort && !incomplete) {
          this.state.phase = '清理索引';
          for (const b of [...this.store.books]) {
            if (!seen.has(b.path)) { this.store.removeBook(b.id); this.state.removed++; }
          }
        }
        // 1.8.0：扫描完统一归并——同名书自动合并、同一系列聚合成「***系列」
        // 1.9.1：每次扫描都做一次「同名合并」（含上次因元数据差异没并上的）
        try {
          const gs = grouping.regroup(this.store);
          if (gs.series || gs.renamed || gs.sameTitleMerged) {
            this._log(`自动归并：${gs.series} 个系列（${gs.merged} 个文件），书名规范化 ${gs.renamed} 个`
              + (gs.sameTitleMerged ? `，同名合并 ${gs.sameTitleGroups} 组（${gs.sameTitleMerged} 个文件）` : ''));
          }
        } catch (e) { this._log('自动归并失败：' + e.message, 'warn'); }
        this.state.phase = '完成';
        this._log(`${incomplete || this._abort ? '本轮扫描结束' : '扫描完成'}：新增 ${this.state.added}，更新 ${this.state.updated}，移除 ${this.state.removed}，待补全信息 ${this.store.books.filter(b => b.scrapeState === 'pending').length} 本${this.state.more ? `；剩余约 ${Math.max(0, files.length - this.state.scanned)} 本下轮继续` : ''}`);
        this.log.flush();
        this.store.save();
      } catch (e) {
        this.state.more = true;
        this.state.errors.push('扫描中断: ' + e.message);
        this._log('扫描中断：' + e.message, 'error');
      } finally {
        if (this._watchdog) clearTimeout(this._watchdog);
        this.state.running = false;
        this.state.finishedAt = Date.now();
        this.state.lastBook = '';
        this.log.setContext('空闲');
        this._note('空闲', this.state.scanned, this.state.total);
        this._log(`扫描结束，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
        this.log.flush();
      }
    })();
    return { started: true };
  }

  /** 单本处理超时保护（网络刮削挂起时不再无限等待） */
  async _withTimeout(p, ms) {
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`单本处理超过 ${Math.round(ms / 1000)} 秒，已跳过`)), ms); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** 判断是否为「PPT/幻灯片转成的图片版 PDF」——这类派生文件不单独入库 */
  _isGeneratedPdf(fp) {
    try {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      return buf.slice(0, n).toString('latin1').includes('fnbookshelf-imagepdf');
    } catch (_) { return false; }
  }

  async _walk(dir, out, depth) {
    depth = depth || 0;
    if (depth > 20 || out.length > 200000 || this._abort) return;
    // 网络挂载目录无响应时不能无限等待，否则扫描会永远停在 running
    let entries, timer;
    try {
      entries = await Promise.race([
        fs.promises.readdir(dir, { withFileTypes: true }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('目录读取超时（15 秒，可能是网络盘不可达）')), 15000); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '@eaDir' || e.name.startsWith('#recycle')) continue;
        await this._walk(fp, out, depth + 1);
      } else if (e.isFile()) {
        const ext = meta.extOf(e.name);
        if (!meta.BOOK_EXTS.includes(ext)) continue;
        const ex = this._excluded || this.excludedExts;
        if (ex.has(ext)) continue;                 // 1.8.0：被排除的后缀不入库
        out.push(fp);
      }
    }
  }

  /** 离线元数据解析（不联网） */
  _parseLocal(filePath, ext, id, size) {
    // ZIP 类文件由 zipread.js 只读所需条目，不再整本载入；仅对极端大文件做兜底跳过
    if (ZIP_EXTS.includes(ext) && (size || safeio.sizeOf(filePath)) > safeio.MAX_ZIP_FILE) {
      this._log(`超大文件（${Math.round((size || 0) / 1048576)}MB）跳过深度解析：${path.basename(filePath)}`, 'warn');
      return { skipped: 'large-file' };
    }
    const coversDir = this.store.coversDir;
    let m = {};
    try {
      switch (ext) {
        case 'epub': m = meta.parseEpub(filePath, coversDir, id); break;
        case 'pdf': m = meta.parsePdf(filePath); break;
        case 'mobi': case 'azw3': case 'azw': case 'prc': m = meta.parseMobi(filePath); break;
        case 'pptx': case 'docx': m = meta.parseOoxml(filePath); break;
        case 'txt': case 'md': m = meta.parseTxtHead(filePath); break;
        case 'fb2': m = meta.parseFb2(filePath); break;
        case 'cbz': m = { coverExt: meta.extractCbzCover(filePath, coversDir, id) }; break;
        default: m = {};
      }
    } catch (e) { m = { parseError: e.message }; }
    return m;
  }

  /** 手动封面的字节快照（本地解析会重写封面文件，解析完要还原） */
  _coverSnapshot(id) {
    const snap = {};
    for (const e of ['.jpg', '.png', '.webp', '.gif']) {
      const f = path.join(this.store.coversDir, id + e);
      try { if (fs.existsSync(f)) snap[e] = fs.readFileSync(f); } catch (_) {}
    }
    return snap;
  }
  _coverRestore(id, snap) {
    for (const e of ['.jpg', '.png', '.webp', '.gif']) {
      try { fs.unlinkSync(path.join(this.store.coversDir, id + e)); } catch (_) {}
    }
    for (const [e, buf] of Object.entries(snap)) {
      try { fs.writeFileSync(path.join(this.store.coversDir, id + e), buf); } catch (_) {}
    }
  }

  async _buildBook(filePath, st, old) {
    const ext = meta.extOf(filePath);
    const id = old ? old.id : crypto.randomUUID();
    const fallback = meta.parseFilename(path.basename(filePath));
    const manualCover = !!(old && old.coverSource === 'manual');
    const snap = manualCover ? this._coverSnapshot(id) : null;
    const m = this._parseLocal(filePath, ext, id, st.size);
    if (snap) this._coverRestore(id, snap);
    const manual = Object.assign({}, (old && old.manual) || {});

    // ---- 书名来源（1.9.0：以原始文件名入库）----
    // 用户要求入库书名就是「原始文件名」（去掉扩展名与下载痕迹后的那一串）。
    // 文件名是用户整理 NAS 时亲手起的，最贴近他脑子里的书名；内嵌元数据经常是
    // 「Microsoft Word - 1234.doc」「未命名-1」这类导出残留。所以顺序是：
    //   文件名 → 内嵌元数据 → 目录名
    // 内嵌元数据书名不丢，存进 metaTitle 供刮削当线索用（刮削依据顺序不变）。
    const metaTitle = String(m.title || '').trim();
    const metaAuthor = String(m.author || '').trim();
    const fileTitle = String(fallback.title || '').trim();
    let title, titleSrc;
    if (manual.title) { title = old.title; titleSrc = 'manual'; }
    else if (fileTitle && !meta.looksJunkTitle(fileTitle)) { title = fileTitle; titleSrc = 'filename'; }
    else if (metaTitle && !meta.looksJunkTitle(metaTitle)) { title = metaTitle; titleSrc = 'meta'; }
    else { title = fileTitle || metaTitle; titleSrc = 'filename'; }
    let author = manual.author ? old.author : (metaAuthor || fallback.author || '未知作者');
    // 1.8.1：解析出来的书名可能是错的编码（PDF/EPUB 元数据里各种写法都有），
    // 判定为乱码时依次用「文件名 → 目录名」兜底——用户看到的是能读的书名，而不是一串方块。
    title = mojibake.repairTitle(String(title || ''), fallback.title || meta.bestDirTitle(filePath)).slice(0, 200);
    if (!manual.title && (!title || meta.looksJunkTitle(title))) {
      title = meta.bestDirTitle(filePath) || fallback.title || title;
      titleSrc = 'dir';
    }
    author = mojibake.fix(String(author || '')).slice(0, 120);

    let desc = manual.description ? old.description : (m.description || (old && old.description) || '');
    desc = mojibake.fix(String(desc || ''));
    let coverExt = manualCover ? (old.coverExt || null) : (m.coverExt || (old && old.coverExt) || null);
    // 1.9.0：本地/在线都拿不到封面时，直接拿 PDF 第一页的图当封面。
    // 家庭书库大量是扫描版 PDF，第一页本身就是一张 JPEG，取出来就是现成封面。
    if (!coverExt && ext === 'pdf') {
      const ce = pdfcover.extractToCover(filePath, this.store.coversDir, id);
      if (ce) coverExt = ce;
    }
    let publisher = manual.publisher ? old.publisher : (m.publisher || (old && old.publisher) || '');
    let isbn = manual.isbn ? old.isbn : (m.isbn || (old && old.isbn) || '');
    let date = manual.date ? old.date : String(m.date || (old && old.date) || '').slice(0, 12);
    let pages = m.pages || (old && old.pages) || 0;
    let scrapeInfo = (old && old.scrapeInfo) || null;

    // ---- 在线刮削已从扫描流程中剥离（1.5.0）----
    // 扫描只做本地解析并立即入库；联网刮削交给 scrapeworker 在后台闲时进行，
    // 用户打开详情时优先处理该本。这样扫描不再受外网超时拖累，也不会堆积内存。
    const sc = this.scrapeCfg;
    const needScrape = sc.enabled && !manual.title && (!desc || !coverExt || !isbn);
    const scrapeState = (old && old.scrapeState) || (needScrape ? 'pending' : 'off');

    // ---- 目录（在线阅读时若为空会再次尝试） ----
    let tocSource = (old && old.tocSource) || '';
    let tocCount = (old && old.tocCount) || 0;
    if (!tocCount) {
      try {
        await new Promise(r => setImmediate(r));
        const t = tocLib.buildToc(filePath, ext);
        if (t.toc && t.toc.length) { tocCount = t.toc.length; tocSource = t.source; this.store.setToc(id, t.toc); }
      } catch (_) {}
    }

    const book = {
      id, path: filePath, filename: path.basename(filePath), ext,
      title, author,
      // 1.8.2：书名来源与内嵌元数据书名分开记，刮削时按「文件名 → 文件信息 → 路径 → 正文」取用
      titleSrc,
      metaTitle: (titleSrc !== 'meta' && metaTitle && !meta.looksJunkTitle(metaTitle) && metaTitle !== title) ? metaTitle.slice(0, 200) : '',
      metaAuthor: (titleSrc !== 'meta' && metaAuthor && metaAuthor !== author) ? metaAuthor.slice(0, 120) : '',
      publisher, date,
      language: m.language || (old && old.language) || '',
      isbn,
      description: desc,
      series: fallback.series || (old && old.series) || '',
      coverExt, coverSource: manualCover ? 'manual' : (old && old.coverSource) || '',
      // 1.6.0：派生 PDF 版本标记与转换结果必须由旧记录继承，强制重扫也不能丢
      imagePdf: (old && old.imagePdf) || null,
      convert: (old && old.convert) || null,
      generatedFrom: (old && old.generatedFrom) || '',
      generated: !!(old && old.generated),
      size: st.size, mtime: st.mtimeMs,
      pages,
      tocCount, tocSource, tocAt: tocCount ? ((old && old.tocAt) || Date.now()) : 0,
      // 1.8.0：归并关系交给 grouping.regroup 统一计算；手动合并/分离过的书保持原键
      workKey: (old && old.groupLocked && old.workKey) ? old.workKey : taxonomy.workKey(title),
      groupLocked: !!(old && old.groupLocked),
      series: (old && old.series) || '',
      seriesAuto: !!(old && old.seriesAuto),
      titleBeforeSeries: '',
      scrapeInfo,
      scrapeState, scrapeTries: (old && old.scrapeTries) || 0, scrapeAt: (old && old.scrapeAt) || 0,
      manual,
      addedAt: old ? old.addedAt : Date.now(), updatedAt: Date.now()
    };
    return book;
  }

  /**
   * 刮削（1.8.2：按「文件名 → 文件信息 → 存储路径 → 正文抽样」逐级尝试）
   * 依据可信度的排序是用户定的：文件名是用户自己起的，最可信；内嵌元数据常是导出残留；
   * 目录名是人工分类留下的线索；正文抽样最费时也最容易跑偏，放最后。
   * @returns {{ok:boolean,data?:object,provider?:string,score:number,refined?:boolean,tried:string[],hints?:object,matchedBy?:string}}
   */
  async _scrapeBook(info) {
    const sc = this.scrapeCfg;
    const providers = this.providers;
    const timeout = Math.min(30000, Math.max(4000, Number(sc.timeout) || 12000));
    const deadline = this._scrapeDeadline || 0;
    const budget = { timeout, deadline };
    if (deadline && Date.now() > deadline) {
      this._log('本次扫描的在线刮削时间预算已用尽，剩余图书仅使用本地元数据', 'warn');
      return { ok: false, score: 0, tried: [], candidates: [] };
    }
    // 1.8.1：把「存储目录的文件夹名（全部层级）」一并交给刮削做线索与佐证
    const dirs = info.dirs || (info.filePath ? meta.dirNames(info.filePath) : []);
    const isbn = String(info.isbn || '');
    const seen = new Set();
    const variants = [];
    const add = (kind, title, author) => {
      const t = String(title || '').trim();
      const a = String(author || '').trim();
      if (!t || meta.looksJunkTitle(t)) return;          // 垃圾书名不拿来检索
      const k = scrape.norm(t) + '|' + scrape.norm(a);
      if (seen.has(k)) return;                            // 同一条线索不重复跑
      seen.add(k);
      variants.push({ kind, title: t, author: a });
    };
    // ① 文件名（最可信）
    if (info.fileName) add('filename', info.fileName.title, info.fileName.author);
    // ② 文件信息（内嵌元数据）
    if (info.meta) add('meta', info.meta.title, info.meta.author);
    // ③ 存储路径上的文件夹名
    const dirKw = scrape.pickDirKeyword({ title: (info.fileName && info.fileName.title) || '', dirs });
    if (dirKw) add('dir', dirKw, '');

    let best = null;
    for (const v of variants) {
      if (deadline && Date.now() > deadline) break;
      const res = await scrape.scrapeBook(
        { title: v.title, keyword: v.title, author: v.author, isbn, dirs },
        providers, Object.assign({}, budget, { dirFallback: false })
      );
      res.matchedBy = v.kind;
      if (res.ok) return res;
      if (!best || (res.score || 0) > (best.score || 0)) best = res;
    }
    if (!info.allowRefine) return best || { ok: false, score: 0, tried: [], candidates: [] };

    // ④ 正文抽样（前 10 页找书名/作者/ISBN）
    this.state.phase = '抽样前 10 页重刮';
    let text = '';
    // 1.8.2.3：抽样是同步解析，可能踩到畸形的 PDF/DOC。记录耗时，
    // 超过 3 秒就在日志里点名，避免下次再出现「看不出卡在哪」的情况。
    const __sampleT0 = Date.now();
    try { text = sample.sampleText(info.filePath, info.ext, 10); } catch (_) {}
    const __sampleMs = Date.now() - __sampleT0;
    if (__sampleMs > 3000) {
      this._log(`正文抽样耗时 ${(__sampleMs / 1000).toFixed(1)} 秒（${info.ext}）：${path.basename(info.filePath || '')}`, 'warn');
    }
    const hints = sample.extractHints(text, {
      title: (info.fileName && info.fileName.title) || (info.meta && info.meta.title) || '',
      author: (info.fileName && info.fileName.author) || (info.meta && info.meta.author) || ''
    });
    // 失败也把线索带回去，详情页「重新刮削」要把抽样结果展示给管理员
    const fail = best || { ok: false, score: 0, tried: [], candidates: [] };
    fail.hints = hints;
    if (!hints.queries.length) return fail;
    this._log(`前三级依据均未命中，抽样 ${hints.length} 字，尝试「${hints.queries[0]}」`);

    // 二次刮削最多再试 2 个候选词，防止一本书拖住整轮扫描
    for (const q of hints.queries.slice(0, 2)) {
      if (deadline && Date.now() > deadline) break;
      const r2 = await scrape.scrapeBook({
        keyword: q, title: hints.title || q,
        author: hints.author || '', isbn: hints.isbn || isbn, dirs
      }, providers, Object.assign({}, budget, { dirFallback: false }));
      if (r2.ok) { r2.refined = true; r2.hints = hints; r2.matchedBy = 'content'; return r2; }
    }
    return fail;
  }

  /** 组装一次刮削所需的四级线索（文件名 / 文件信息 / 路径 / 正文） */
  _scrapeInfoFor(b, allowRefine) {
    const fi = meta.parseFilename(b.filename || '');
    return {
      fileName: { title: fi.title, author: fi.author },
      // 文件信息：优先用扫描时记下的内嵌元数据书名；老数据退回当前书名
      meta: {
        title: b.metaTitle || (b.titleSrc && b.titleSrc !== 'meta' ? '' : b.title) || '',
        author: b.metaAuthor || (b.titleSrc === 'meta' ? b.author : '') || ''
      },
      isbn: b.isbn || '',
      ext: b.ext,
      filePath: b.path,
      dirs: b.path ? meta.dirNames(b.path) : [],
      allowRefine: allowRefine !== false
    };
  }

  /** 重新刮削单本（含二次刮削）；返回抓到的候选供管理员挑选 */
  async rescrape(bookId, opts) {
    opts = opts || {};
    const b = this.store.findBook(bookId);
    if (!b) { const e = new Error('图书不存在'); e.status = 404; throw e; }
    const providers = opts.providers && opts.providers.length ? opts.providers.filter(p => scrape.PROVIDERS[p]) : this.providers;
    if (!providers.length) { const e = new Error('未启用任何刮削源'); e.status = 400; throw e; }

    let res;
    if (opts.keyword) {
      // 1.9.2：用户明确指定了书名 → 只按这个书名刮，不走目录名与正文抽样（避免又偏到别的书上）
      const kw = String(opts.keyword).trim();
      res = await scrape.scrapeBook(
        { title: kw, keyword: kw, author: '', isbn: '', dirs: b.path ? meta.dirNames(b.path) : [] },
        providers, { timeout: Math.min(30000, Math.max(4000, Number(this.scrapeCfg.timeout) || 12000)), dirFallback: false }
      );
      res.matchedBy = 'user';
    } else {
      res = await this._scrapeBook(this._scrapeInfoFor(b, opts.refine !== false));
    }
    if (opts.dryRun) return res;
    if (!res.ok) { const e = new Error('未找到足够匹配的在线信息'); e.status = 404; e.candidates = res.candidates; throw e; }
    return this.applyScrape(b, res.data, res);
  }

  /**
   * 1.9.2：刮削结果的书名能否覆盖「文件名来源」的现有书名。
   * 文件名是用户自己起的，最可信；只有下列情况才认刮削名：
   *   · 用户明确按某个书名刮（matchedBy === 'user'）
   *   · 两条名字实质相同（只差副标题/标点/序号）
   *   · 现有书名是本地生成的派生版本，刮削名是它的母本
   *   · 现有文件名本身是垃圾名（001、未命名…）
   */
  _titleTrustworthy(b, nt, res) {
    const cur = String(b.title || '').trim();
    if (!cur) return true;
    if (res && res.matchedBy === 'user') return true;
    if (!b.filename) return true;
    const stem = String(b.filename).replace(/\.[^.]+$/, '');
    if (meta.looksJunkTitle(stem)) return true;
    const sim = scrape.similarity(nt, cur);
    if (sim >= 0.62) return true;
    // 「扫描版」「OCR」「转换」这类派生版本 → 允许换成正式书名
    if (/[（(【\[](扫描版|影印版|OCR|转换|压缩|修复)[)）】\]]/i.test(cur)) return true;
    // 现有书名只是文件名里的一小段、且刮削名包含它 → 说明刮削到了更完整的正式名
    const nc = scrape.norm(cur), nn = scrape.norm(nt);
    if (nc.length >= 2 && nc.length <= 8 && nn.includes(nc)) return true;
    return false;
  }

  /** 1.9.2：把书名改成「同目录另一本书已经叫这个名字」= 串号，拒绝 */
  _titleCollides(b, nt) {
    try {
      if (!b.path) return false;
      const dir = path.dirname(b.path);
      const k = taxonomy.workKey(nt);
      return this.store.books.some(x => x.id !== b.id && x.path && path.dirname(x.path) === dir &&
        x.title && taxonomy.workKey(x.title) === k && String(x.filename || '') !== String(b.filename || ''));
    } catch (_) { return false; }
  }

  /** 把刮削结果写回书籍 */
  async applyScrape(b, d, res) {
    const manual = b.manual || {};
    // 系列里的书名是「XXX 系列」，不被单本的刮削结果改掉
    // 1.8.1：刮削回来的书名如果本身是乱码，保留现有书名（repairTitle 会用兜底值）
    //
    // 1.9.2（用户反馈「明明是《小学数学-思维导图》，入库却叫《01初中数学1.1》」）：
    // 以前只要刮削成功就无条件覆盖书名，只要四级线索（尤其是路径/正文抽样）跑偏，
    // 就会把用户起好的文件名书名换成隔壁那本书的名字。现在加护栏：
    //   ① 文件名来源的书名，只有刮削结果和它「确实同一本书」时才允许改写；
    //   ② 改写后的名字若与同一目录下另一本书的书名完全一致 → 判定为串号，拒绝。
    if (d.title && !manual.title && !b.series) {
      const nt = mojibake.repairTitle(d.title, b.title);
      const trusted = b.titleSrc === 'filename' || b.titleSrc === 'manual';
      const okSame = trusted ? this._titleTrustworthy(b, nt, res) : true;
      const collide = okSame ? this._titleCollides(b, nt) : true;
      if (nt && nt !== b.title && okSame && !collide) {
        b.title = nt;
        if (nt === d.title) b.titleSrc = 'scrape';
      }
    }
    if (d.author && !manual.author) b.author = d.author;
    if (d.publisher && !manual.publisher) b.publisher = d.publisher;
    if (d.date && !manual.date) b.date = String(d.date).slice(0, 12);
    if (d.description && !manual.description) b.description = d.description;
    if (d.isbn && !manual.isbn) b.isbn = d.isbn;
    // 1.5.0：分类功能已下线，不再从刮削结果写入 categories / tags
    // 1.6.0：用户在详情页手动选过封面后，扫描/刮削都不再覆盖它
    if (d.coverUrl && b.coverSource !== 'manual') {
      const ce = await scrape.downloadCover(d.coverUrl, this.store.coversDir, b.id, this.scrapeCfg.timeout);
      if (ce) b.coverExt = ce;
    }
    // 1.9.0：在线也拿不到封面 → 用 PDF 首页图兜底
    if (!b.coverExt) {
      try { this.applyPdfCover(b); } catch (_) {}
    }
    if (!b.groupLocked) {
      b.workKey = b.series ? taxonomy.seriesKey(b.series) : taxonomy.workKey(b.title);
    }
    b.scrapeInfo = {
      provider: (res && res.provider) || d.provider || '',
      score: Math.round(((res && res.score) || d.score || 0) * 100) / 100,
      refined: !!(res && res.refined), at: Date.now(), url: d.url || ''
    };
    b.scrapeState = 'done';
    b.scrapeAt = Date.now();
    b.updatedAt = Date.now();
    this.store.upsertBook(b);
    // 1.9.1：刮削把书名改成了某个已有作品的名字 → 立刻并到一起（用户要求「刮削后同名的也自动合并」）
    try {
      const t = grouping.mergeAfterRename(this.store, b);
      if (t && t.id !== b.id) this._log(`刮削后书名与《${t.title}》相同，已自动合并`);
    } catch (_) {}
    return b;
  }

  /**
   * 后台闲时补全单本（供 scrapeworker 调用；与扫描流程完全解耦）
   * @returns {Promise<boolean>} 是否成功补全
   */
  async scrapeOne(book, opts) {
    opts = opts || {};
    if (!book) return false;
    const sc = this.scrapeCfg;
    if (!sc.enabled || !this.providers.length) return false;
    let res = null;
    try {
      res = await this._scrapeBook(this._scrapeInfoFor(book, opts.refine !== false));
    } catch (e) {
      this._log(`补全失败《${book.title}》：${e.message}`, 'warn');
    }
    book.scrapeTries = (book.scrapeTries || 0) + 1;
    book.scrapeAt = Date.now();
    if (res && res.ok) {
      await this.applyScrape(book, res.data, res);
      this._log(`后台补全《${book.title}》← ${res.provider}（匹配 ${Math.round((res.score || 0) * 100)}%）`);
      return true;
    }
    // 连续 3 次都刮不到就标记失败，不再反复占用外网请求
    book.scrapeState = book.scrapeTries >= 3 ? 'failed' : 'pending';
    // 1.9.0：刮削失败也顺手补一次封面（PDF 首页图），别让书卡一直空白
    if (!book.coverExt) { try { this.applyPdfCover(book); } catch (_) {} }
    this.store.upsertBook(book);
    return false;
  }

  /** 只做候选探查，不落库 */
  async probe(bookId, opts) {
    opts = Object.assign({}, opts, { dryRun: true });
    return this.rescrape(bookId, opts);
  }

  /**
   * 1.9.0：封面兜底——用 PDF 版本的首页图当封面。
   * 先看自己，再看同一部作品里的 PDF 版本；写好后整部作品共用同一张封面。
   * @returns {boolean} 是否写入了新封面
   */
  applyPdfCover(book) {
    if (!book || book.coverExt) return false;
    if (book.coverSource === 'manual') return false;
    const vers = book.workKey
      ? this.store.books.filter(x => x.workKey === book.workKey && x.status !== 'hidden')
      : [book];
    const pdf = vers.find(x => x.ext === 'pdf' && x.path && fs.existsSync(x.path));
    if (!pdf) return false;
    let wrote = false;
    for (const t of (vers.some(x => x.id === book.id) ? vers : [book, ...vers])) {
      if (t.coverExt || (t.coverSource === 'manual')) continue;
      const ce = pdfcover.extractToCover(pdf.path, this.store.coversDir, t.id);
      if (ce) { t.coverExt = ce; t.updatedAt = Date.now(); wrote = true; }
    }
    if (wrote) this.store.save();
    return wrote;
  }

  /**
   * 1.9.0：管理后台「开始刮削」——把还没刮过 / 之前失败的书重新排进队列。
   * 不重置已经成功的（用户要求是「对未刮削过的图书继续刮削」）。
   * @returns {{queued:number, total:number, enabled:boolean}}
   */
  startScrape() {
    const sw = this.store.data.settings.scrape || {};
    if (!sw.enabled) return { queued: 0, total: 0, enabled: false, error: '请先在下方开启「在线刮削」' };
    let queued = 0;
    for (const b of this.store.books) {
      if (b.status === 'hidden') continue;
      if (b.manual && b.manual.title && b.scrapeInfo) continue;
      if (b.scrapeState === 'done') continue;
      b.scrapeState = 'pending';
      b.scrapeTries = 0;
      queued++;
    }
    this.store.save();
    this._log(`管理员启动刮削：${queued} 本待补全`);
    return { queued, total: this.store.books.length, enabled: true };
  }

  /** 为单本补建目录 */
  buildToc(bookId) {
    const b = this.store.findBook(bookId);
    if (!b) throw new Error('图书不存在');
    const t = tocLib.buildToc(b.path, b.ext);
    if (t.toc && t.toc.length) {
      b.tocSource = t.source;
      b.tocAt = Date.now();
      this.store.setToc(b.id, t.toc);
      this.store.upsertBook(b);
    }
    return { toc: t.toc || [], source: t.source };
  }
}

module.exports = { Scanner };
