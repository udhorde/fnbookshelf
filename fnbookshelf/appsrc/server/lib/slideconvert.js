// 1.6.0：PPT/PPTX 后台转 PDF 任务队列
// 思路（不装 LibreOffice / OnlyOffice / Chrome 等重型组件）：
//   ① NAS 上若「已经」自带 soffice（系统或别的应用装的），直接借它转，保真度最高 —— 只是检测，不安装；
//   ② 否则对图片型 PPTX 逐页从 OOXML 包里抽出整页图片（这类书的每页本来就是一张截图），
//      再按顺序流式合成图片版 PDF；纯文字页补白页保持页码；
//   ③ 产物作为「同一部作品的新版本」入库（不新建独立书籍、不覆盖源文件）。
// 所有重活走并发闸门，页面逐张处理并让出事件循环，避免上百 MB 的 PPT 把内存打满。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const taxonomy = require('./taxonomy');
const slideimages = require('./slideimages');
const pptbin = require('./pptbin');
const pdfwrite = require('./pdfwrite');
const { createGate } = require('./limits');

const MAX_PAGES = 400;
const MAX_PAGE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 160 * 1024 * 1024;
const OFFICE_TIMEOUT_MS = 120000;

/** 只检测系统里是否已经装了 LibreOffice，绝不安装 */
async function findSoffice() {
  try {
    const { stdout } = await execFileAsync('sh', ['-c', 'command -v soffice || command -v libreoffice || true'], { timeout: 4000 });
    const p = String(stdout || '').trim().split(/\r?\n/)[0];
    return p && fs.existsSync(p) ? p : '';
  } catch (_) { return ''; }
}

/** 借用系统已有的 LibreOffice 生成 PDF（输出到临时目录） */
async function systemOfficePdf(exe, src, tmpDir) {
  const profile = path.join(tmpDir, '.lo-profile-' + process.pid);
  const args = [
    `-env:UserInstallation=file://${profile}`,
    '--headless', '--nologo', '--nodefault', '--norestore',
    '--convert-to', 'pdf', '--outdir', tmpDir, src
  ];
  try { await execFileAsync(exe, args, { timeout: OFFICE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }); }
  catch (_) { /* 超时/失败都按「不可用」处理，回落到自带解析器 */ }
  const out = path.join(tmpDir, path.basename(src).replace(/\.[^.]+$/, '') + '.pdf');
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
  return '';
}

/**
 * 这本书是否已经「转换过一次」——返回仍存在于书库、且文件还在的转换产物。
 * 1.7.1：同一个 PPT 只允许转换一次；只有把该 PDF 版本删掉之后才允许重新转换。
 * 兼容 1.5.x 的老数据：那时只记在 book.convert / book.imagePdf 里，没有独立版本记录。
 */
function findConvertedPdf(store, book) {
  if (!book) return null;
  const alive = p => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
  const gen = store.books.find(x => x.id !== book.id && x.generatedFrom === book.id && x.status !== 'hidden' && alive(x.path));
  if (gen) return { id: gen.id, filename: gen.filename, path: gen.path };
  const c = book.convert;
  if (c && c.status === 'done' && alive(c.path)) return { id: c.versionId || '', filename: path.basename(c.path), path: c.path };
  const ip = book.imagePdf;
  if (ip && alive(ip.path)) return { id: '', filename: path.basename(ip.path), path: ip.path };
  return null;
}

/** 把生成好的 PDF 登记为同一部作品的新版本，并沿用源书的元数据与封面 */
function registerPdfVersion(store, book, pdfPath, pages, engine, opts) {
  opts = opts || {};
  const st = fs.statSync(pdfPath);
  const workKey = book.workKey || taxonomy.workKey(book.title, book.author);
  let versionId = book.convert && book.convert.versionId;
  let old = versionId ? store.findBook(versionId) : null;
  if (!old || old.generatedFrom !== book.id) { old = null; versionId = crypto.randomUUID(); }

  const rec = {
    id: versionId, path: pdfPath, filename: path.basename(pdfPath), ext: 'pdf',
    title: book.title, author: book.author,
    publisher: book.publisher || '', date: book.date || '', language: book.language || '',
    isbn: book.isbn || '', description: book.description || '', series: book.series || '',
    coverExt: '', size: st.size, mtime: st.mtimeMs, pages: pages,
    tocCount: 0, tocSource: '', tocAt: 0,
    workKey,
    scrapeInfo: book.scrapeInfo || null, scrapeState: 'off', scrapeTries: 0, scrapeAt: 0,
    manual: Object.assign({}, book.manual || {}),
    generatedFrom: book.id, generated: true,
    addedAt: old ? old.addedAt : Date.now(), updatedAt: Date.now()
  };
  store.upsertBook(rec);

  if (!book.workKey) book.workKey = workKey;
  book.convert = {
    status: 'done', at: Date.now(), versionId,
    path: pdfPath, pages, engine, fallback: !!opts.fallback,
    blanks: Number(opts.blanks) || 0
  };
  // 兼容旧链路：/books/:id/read 直接把源 PPT 当 PDF 打开
  book.imagePdf = { path: pdfPath, pages, at: Date.now(), fallback: !!opts.fallback, size: st.size };
  book.updatedAt = Date.now();
  store.upsertBook(book);

  // 封面沿用源书
  try {
    for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
      const src = path.join(store.coversDir, book.id + ext);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(store.coversDir, versionId + ext);
      fs.copyFileSync(src, dst);
      rec.coverExt = ext.slice(1);
      store.upsertBook(rec);
      break;
    }
  } catch (_) {}

  if (opts.userId) store.setDefaultVersion(opts.userId, workKey, versionId);
  return rec;
}

class ConvertManager {
  constructor(ctx) {
    this.store = ctx.store;
    this.log = ctx.log || console;
    this.gate = createGate(1);           // 同一时间只转一本，避免多台设备同时压满内存
    this.jobs = new Map();
    this.byBook = new Map();
  }

  public(j) {
    return {
      jobId: j.id, bookId: j.bookId, state: j.state,
      done: j.done, total: j.total, message: j.message, engine: j.engine,
      startedAt: j.startedAt, finishedAt: j.finishedAt,
      error: j.error, result: j.result
    };
  }

  status(jobId) { const j = this.jobs.get(jobId); return j ? this.public(j) : null; }
  forBook(bookId) { const id = this.byBook.get(bookId); return id ? this.status(id) : null; }
  list() { return [...this.jobs.values()].slice(-30).map(j => this.public(j)); }
  /** 任务只对发起人与管理员可见（复测 L-4：别拿到 jobId 就能读别人的转换进度/错误） */
  isOwner(jobId, user) {
    const j = this.jobs.get(jobId);
    if (!j || !user) return false;
    return user.role === 'admin' || j.userId === user.id;
  }

  start(book, opts) {
    opts = opts || {};
    const prev = this.forBook(book.id);
    if (prev && (prev.state === 'queued' || prev.state === 'running')) return prev;
    const job = {
      id: crypto.randomUUID(), bookId: book.id, userId: opts.userId || '',
      state: 'queued', done: 0, total: 0, message: '排队中（同一时间只转换一本）',
      engine: '', startedAt: Date.now(), finishedAt: 0, error: null, result: null
    };
    this.jobs.set(job.id, job);
    this.byBook.set(book.id, job.id);
    setImmediate(() => this._run(job).catch(e => {
      job.state = 'failed'; job.error = e.message; job.finishedAt = Date.now();
      this.log.error && this.log.error('convert', `转换任务异常：${e.message}`);
    }));
    return this.public(job);
  }

  async _run(job) {
    await this.gate.run(async () => {
      job.state = 'running'; job.startedAt = Date.now();
      job.message = '正在准备转换…';
      const book = this.store.findBook(job.bookId);
      if (!book || !fs.existsSync(book.path)) throw new Error('源文件不存在');
      if (book.ext !== 'ppt' && book.ext !== 'pptx') throw new Error('仅支持 PPT/PPTX');
      // 1.7.1：同一个文件只允许转换一次。接口层已拦，这里再查一次兜住并发 / 双标签页竞态。
      const existed = findConvertedPdf(this.store, book);
      if (existed) {
        job.state = 'done'; job.done = 1; job.total = 1; job.engine = 'cached';
        job.message = `这本书已经有转换生成的 PDF（${existed.filename}），不再重复转换`;
        job.finishedAt = Date.now();
        job.result = { versionId: existed.id, path: existed.path, pages: 0, engine: 'cached' };
        return;
      }

      const dir = path.dirname(book.path);
      const baseName = path.basename(book.path).replace(/\.[^.]+$/, '');
      const tmpDir = path.join(this.store.cacheDir, 'convert-' + job.id);
      fs.mkdirSync(tmpDir, { recursive: true });
      const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

      try {
        // ① 系统已有的 LibreOffice（零安装）
        job.message = '检测系统已有的文档引擎…';
        const exe = await findSoffice();
        let officeOut = '';
        if (exe) {
          job.engine = 'libreoffice';
          job.message = '借用系统已有的 LibreOffice 转换…';
          officeOut = await systemOfficePdf(exe, book.path, tmpDir);
        }

        let pdfPath = '';
        let pages = 0, blanks = 0, skipped = 0;
        if (officeOut) {
          pages = countPdfPages(officeOut);
          pdfPath = officeOut;
          job.message = '文档引擎转换完成，正在入库…';
        } else {
          // ② 逐页整图抽取：.pptx 从 OOXML 包取、.ppt 从 OLE 的 Pictures 流取（1.6.2 起支持）
          const isPpt = book.ext === 'ppt';
          job.engine = isPpt ? 'builtin-ole' : 'builtin-image';
          job.message = isPpt ? '正在从 .ppt 的图片流逐页取图…' : '正在逐页提取页面图片…';
          const ex = isPpt
            ? pptbin.extractPptImages(book.path, { maxPages: MAX_PAGES, maxPageBytes: MAX_PAGE_BYTES })
            : slideimages.extractSlideImages(book.path, { maxPages: MAX_PAGES, maxPageBytes: MAX_PAGE_BYTES });
          job.total = ex.pages.length;
          blanks = ex.blank || 0;
          skipped = ex.skipped || 0;
          if (!ex.pages.length) {
            throw new Error(isPpt
              ? (ex.reason || '这个 .ppt 里没有可直接提取的整页图片') + '。可在阅读器里改用「浏览器渲染（兼容模式）」。'
              : (ex.reason || '未找到可转换的页面'));
          }
          if (!isPpt && blanks === ex.pages.length) {
            throw new Error('这不是图片型 PPT（未检测到整页图片）。请在阅读器里使用「浏览器渲染（兼容模式）」，或在 NAS 上已有 LibreOffice 时重试后台转换。');
          }
          let totalBytes = 0;
          const images = [];
          for (let i = 0; i < ex.pages.length; i++) {
            const p = ex.pages[i];
            totalBytes += p.data.length;
            if (totalBytes > MAX_TOTAL_BYTES) throw new Error('页面图片总量超过 160MB，为保护内存已中止');
            images.push({ data: p.data, type: p.type });
            job.done = i + 1;
            job.message = `正在处理第 ${i + 1} / ${ex.pages.length} 页…`;
            if (i % 4 === 0) await new Promise(r => setImmediate(r));
          }
          job.message = '正在按顺序合成 PDF…';
          pdfPath = path.join(tmpDir, baseName + '.阅读版.pdf');
          pdfwrite.imagesToPdfFile(images, pdfPath);
          pages = images.length;
        }

        // ③ 落到书籍同目录；不可写则退到应用缓存目录
        let target = path.join(dir, baseName + '.阅读版.pdf');
        let fallback = false;
        try {
          fs.copyFileSync(pdfPath, target);
        } catch (e) {
          fallback = true;
          target = path.join(this.store.cacheDir, book.id + '.converted.pdf');
          fs.copyFileSync(pdfPath, target);
        }
        job.message = '正在把新 PDF 作为新版本加入书库…';
        const rec = registerPdfVersion(this.store, book, target, pages, job.engine, {
          fallback, blanks, userId: job.userId
        });
        job.state = 'done'; job.done = job.total || pages; job.total = job.total || pages;
        job.finishedAt = Date.now();
        job.message = `已完成：${pages} 页`
          + (skipped ? `（跳过 ${skipped} 页纯文字页）` : '')
          + (blanks ? `（${blanks} 页无整图，已补空白页）` : '')
          + '，新增为本书的新版本';
        job.result = { versionId: rec.id, path: target, pages, engine: job.engine, fallback, blanks, skipped };
      } finally {
        cleanup();
      }
    });
  }
}

/** 粗略数一下 PDF 页数（仅用于 LibreOffice 产物展示，失败返回 0） */
function countPdfPages(fp) {
  try {
    const buf = fs.readFileSync(fp);
    const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
    return m ? m.length : 0;
  } catch (_) { return 0; }
}

module.exports = { ConvertManager, registerPdfVersion, findConvertedPdf, MAX_PAGES, MAX_TOTAL_BYTES };
