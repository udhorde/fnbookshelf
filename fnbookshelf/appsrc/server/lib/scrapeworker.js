// 后台刮削队列（1.5.0）
// 与扫描彻底解耦：扫描只做本地解析并立即入库；本模块在「系统空闲」时逐本补全在线信息。
// 设计要点：
//  · 扫描进行中一律让路（扫描优先，避免同时抢磁盘与外网）
//  · 每次只处理一本，本与本之间留间隔，避免大量并发请求与内存堆积
//  · 用户打开详情时 prioritize() 插队，并在极短预算内联尝试一次
//  · 内存超高时自动暂停，绝不为了元数据把进程推到 OOM
'use strict';
const logger = require('./logger');

const IDLE_GAP_MS = 6000;        // 两本之间的间隔
const TICK_MS = 4000;            // 轮询间隔
const RSS_PAUSE_MB = 300;        // 超过此内存暂停后台刮削
const HOT_KEEP = 200;            // 插队集合上限，避免无限增长

class ScrapeWorker {
  constructor({ store, scanner, log }) {
    this.store = store;
    this.scanner = scanner;
    this.log = log || logger.get();
    this.hot = [];                 // 用户正在看的书，优先处理（数组便于保持插入顺序）
    this._busy = false;
    this._nowBusy = new Set();
    this._activeId = '';          // 队列正在处理的书籍 id（避免与详情页的内联刮削重复跑）
    this._timer = null;
    this._lastAt = 0;
    this.state = {
      running: false, current: '', done: 0, failed: 0,
      lastAt: 0, lastResult: '', paused: '', pending: 0
    };
  }

  /** 这本书是否还需要联网补全 */
  needs(b) {
    if (!b || b.status === 'hidden') return false;
    const cfg = this.store.data.settings.scrape || {};
    if (!cfg.enabled) return false;
    if (b.manual && b.manual.title) return false;      // 管理员手工改过标题，不再覆盖
    if (b.scrapeState === 'done' || b.scrapeState === 'failed') return false;
    if (b.scrapeInfo && b.coverExt && b.description && b.isbn) return false;  // 信息已足够
    return true;
  }

  pendingList() { return this.store.books.filter(b => this.needs(b)); }

  status() {
    return Object.assign({}, this.state, {
      pending: this.pendingList().length,
      hot: this.hot.length,
      enabled: !!(this.store.data.settings.scrape || {}).enabled
    });
  }

  /** 用户打开详情时调用：把这本书排到最前 */
  prioritize(bookId) {
    if (!bookId) return;
    const i = this.hot.indexOf(bookId);
    if (i >= 0) this.hot.splice(i, 1);
    this.hot.unshift(bookId);
    if (this.hot.length > HOT_KEEP) this.hot.length = HOT_KEEP;
    setImmediate(() => this._tick());
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  /**
   * 1.9.0：管理员点了「开始刮削」——接下来一段时间加速跑。
   * 平时两本之间留 6 秒是为了不打扰正常使用；手动开跑时用户就是想快点补完，
   * 间隔缩到 1.2 秒（仍然串行，不并发抢外网）。
   */
  startCatchUp(ms) {
    this.fastUntil = Date.now() + (Number(ms) || 3600 * 1000);
    setImmediate(() => this._tick());
    return this.fastUntil;
  }

  get gapMs() {
    return Date.now() < (this.fastUntil || 0) ? 1200 : IDLE_GAP_MS;
  }

  _pick() {
    // 插队优先
    while (this.hot.length) {
      const id = this.hot.shift();
      const b = this.store.findBook(id);
      if (b && this.needs(b) && !this._nowBusy.has(b.id)) return b;
    }
    const list = this.pendingList();
    if (!list.length) return null;
    // 新入库的优先（用户刚放进来的书更需要元数据），其次按入库时间倒序
    list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return list.find(b => !this._nowBusy.has(b.id)) || null;
  }

  _tick() {
    if (this._busy) return;
    const cfg = this.store.data.settings.scrape || {};
    if (!cfg.enabled) { this.state.paused = 'disabled'; return; }
    if (this.scanner.state.running) { this.state.paused = 'scanning'; return; }
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    if (rss > RSS_PAUSE_MB) { this.state.paused = 'memory'; return; }
    if (Date.now() - this._lastAt < this.gapMs) return;
    this.state.paused = '';
    this._busy = true;
    const b = this._pick();
    if (!b) { this.state.running = false; this.state.current = ''; this._busy = false; return; }
    this.state.running = true;
    this.state.current = b.title;
    this._activeId = b.id;
    this.state.lastResult = '';
    this.scanner.scrapeOne(b, { refine: true })
      .then(ok => {
        if (ok) { this.state.done++; this.state.lastResult = 'ok'; }
        else { this.state.failed++; this.state.lastResult = 'miss'; }
        this.state.lastAt = Date.now();
        this._lastAt = Date.now();
        this.log.info('scrape', `后台补全${ok ? '成功' : '未命中'}：《${b.title}》`);
      })
      .catch(e => {
        this.state.failed++;
        this.state.lastResult = 'error';
        this.log.warn('scrape', `后台补全异常《${b.title}》：${e.message}`);
      })
      .finally(() => {
        this.state.running = false;
        this.state.current = '';
        this._activeId = '';
        this._busy = false;
      });
  }

  /**
   * 打开详情时的「优先刮削」：最多等 budgetMs，超时就让它继续在后台跑
   * @returns {Promise<boolean>} 是否在预算内完成且成功
   */
  async scrapeNow(bookId, budgetMs) {
    const b = this.store.findBook(bookId);
    if (!b || !this.needs(b)) return false;
    if (this.scanner.state.running) return false;       // 扫描期间不抢资源，只排队
    if (this._nowBusy.has(bookId) || this._activeId === bookId) return false;
    if (process.memoryUsage().rss > RSS_PAUSE_MB * 1048576) return false;
    this._nowBusy.add(bookId);
    const job = this.scanner.scrapeOne(b, { refine: false })
      .catch(() => false)
      .finally(() => this._nowBusy.delete(bookId));
    const budget = Math.max(800, Number(budgetMs) || 2500);
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budget); });
    try {
      const r = await Promise.race([job, timeout]);
      return r === true;
    } finally { if (timer) clearTimeout(timer); }
  }
}

module.exports = { ScrapeWorker, IDLE_GAP_MS, RSS_PAUSE_MB };
