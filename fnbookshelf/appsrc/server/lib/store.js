// 飞牛书屋 - 数据存储层（纯 JSON 持久化，无原生依赖）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const taxonomy = require('./taxonomy');
const mojibake = require('./mojibake');
const grouping = require('./grouping');

/** 1.9.1：回收站里的文件保留天数（超过后每日清理自动物理删除） */
const TRASH_KEEP_DAYS = 30;

/** 1.7.x 及更早版本的归并键算法（仅用于升级时识别「手动合并过」的书） */
function legacyWorkKey(title, author) {
  const t = String(title || '')
    .replace(/[\(\[（【].*?[\)\]）】]/g, '')
    .replace(/[\s\-_·:：,，.。!！?？'"“”‘’《》<>]/g, '')
    .replace(/(第[\d一二三四五六七八九十百]+[卷册部集版]|全\d+[册卷]|插图|精校|校对|合集|套装|epub|mobi|pdf|azw3|txt|扫描版)/gi, '')
    .toLowerCase()
    .slice(0, 60);
  const a = String(author || '未知作者')
    .replace(/[\[\(（【].*?[\)\]）】]/g, '')
    .replace(/[\s·,，、;；]/g, '')
    .replace(/著|编著|主编|译|等人?$/g, '')
    .toLowerCase()
    .slice(0, 30);
  return (t || 'untitled') + '@' + (a || 'unknown');
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.coversDir = path.join(dataDir, 'covers');
    this.cacheDir = path.join(dataDir, 'cache');
    this.certsDir = path.join(dataDir, 'certs');
    this.trashDir = path.join(dataDir, 'trash');
    this.tocDir = path.join(dataDir, 'toc');
    for (const d of [dataDir, this.coversDir, this.cacheDir, this.certsDir, this.trashDir, this.tocDir]) {
      try { fs.mkdirSync(d, { recursive: true }); }
      catch (e) { console.error(`[store] 目录不可创建 ${d}：${e.code || e.message}`); }
    }
    // 1.6.3：数据目录常被用户迁移/拷贝过，属主与权限可能不是本进程；
    // 先尽力把目录本身修到可读写（文件级修复见 repair()，需要管理员在后台触发）。
    for (const d of [dataDir, this.coversDir, this.cacheDir, this.trashDir, this.tocDir]) {
      try { fs.chmodSync(d, 0o775); } catch (_) {}
    }
    this.file = path.join(dataDir, 'data.json');
    this.data = this._load();
    this._saveTimer = null;
    this._dirty = false;
    this._writing = false;
    this._pendingWrite = false;
    this._migrate();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (e) {
      console.error('[store] 数据文件损坏，尝试备份后重建:', e.message);
      try { fs.copyFileSync(this.file, this.file + '.bak.' + Date.now()); } catch (_) {}
    }
    return this._empty();
  }

  _empty() {
    return {
      settings: {
        siteName: '飞牛书屋',
        setupComplete: false,   // 首次启动引导：管理员首次登录后置为 true
        registerMode: 'auto',   // auto | approve | closed
        smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
        https: { mode: 'self', cert: '', key: '' },
        // 刮削：providers 按优先级排序，refine=刮不到时抽样前 10 页重刮
        // 刮削：国内源优先（豆瓣 > 国图 > 读秀 > ISBN 直达 > 当当）；experimental 源默认不启用
        scrape: { enabled: false, provider: 'douban', providers: ['douban', 'isbn', 'dangdang', 'tstrs'], refine: true, timeout: 12000, cover: true },
        // TTS：browser=浏览器本地语音（离线）｜openai/azure=兼容接口；enabled=false 时全站关闭朗读
        tts: {
          enabled: true, engine: 'browser', rate: 1, autoNext: true,
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'tts-1', voice: 'alloy' },
          azure: { region: '', key: '', voice: 'zh-CN-XiaoxiaoNeural' }
        },
        // AI：仅用于书库内检索推荐、阅读上下文答疑、翻译
        ai: {
          enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini',
          dailyLimit: 40, maxTokens: 600, temperature: 0.3,
          recommend: true, ask: true, translate: true, strict: true
        },
        // 数据目录（空=应用自身 var/data，避免占用系统盘）
        storage: { dataDir: '' },
        reader: {},   // 管理员可下发默认阅读偏好（前端本地配置优先）
        // 安全（1.7.0）：令牌有效期、书库共同管理、允许嵌入的父页面来源
        security: {
          tokenTtlHours: 24,          // 登录令牌有效期（1–168 小时）
          collaborativeLibrary: false, // true=普通用户也可改封面/合并版本（默认仅管理员）
          frameAncestors: ''          // 额外允许 iframe 嵌入的来源，空格分隔（同主机任意端口已默认放行）
        },
        // 1.8.0 书库：excludeExts 里的后缀在扫描时直接跳过（不索引、不入库）
        library: { excludeExts: [] },
        // 1.9.0 客户端安装包：管理员在后台为「手机/平板」与「TV」分别上传 APK，
        // 页面左下角的下载入口与 APP 内的自动更新都读这里
        app: {
          basePath: '/fnbookshelf',   // 二级路径访问（反向代理用）
          phone: null,                 // {ver, code, size, name, at, md5}
          tv: null
        },
        paths: []
      },
      users: [],
      books: [],
      progress: {},
      finished: {},    // 1.6.0 userId -> { bookId: {at, pct} }（已读完）
      shelves: {},     // userId -> [bookId]
      annotations: {}, // userId -> { bookId -> [{id,type,cfi,page,pos,quote,note,color,createdAt}] }
      stats: {},       // userId -> { totalSec, byBook:{bookId:sec}, byDay:{'YYYY-MM-DD':sec}, opened:count }
      history: {},     // userId -> [{bookId, at}]（最近在前）
      deletions: [],   // [{id, bookId, title, filename, path, requestedBy, requestedAt, status, note, resolvedBy, resolvedAt}]
      // 1.8.2 专题：像文件夹一样把书归堆（管理员维护），keys 存「作品键」
      collections: [], // [{id, name, desc, keys:[workKey], order, createdBy, createdAt, updatedAt}]
      aiUsage: {},     // userId -> {'YYYY-MM-DD': count}
      works: {},        // workKey -> { title, author, updatedAt }（版本分组展示用，可选缓存）
      defaultVersion: {}, // userId -> { workKey: bookId }（用户为每部作品选择的默认版本）
      // 1.9.0：版本顺序（管理员可在版本管理里上下调整），workKey -> [bookId]
      versionOrder: {},
      // 1.9.0：搜索无结果时用户点「通知管理员」，管理员在后台看到原始搜索词
      notifications: [], // [{id, q, by, byEmail, at, readAt}]
      audit: []         // 1.7.0 敏感操作留痕：[{at, by, byEmail, action, target, detail}]
    };
  }

  _migrate() {
    const d = this.data;
    const empty = this._empty();
    d.settings = Object.assign(empty.settings, d.settings || {});
    if (d.settings.registerMode === undefined) d.settings.registerMode = 'auto';
    d.settings.smtp = Object.assign({ host: '', port: 465, secure: true, user: '', pass: '', from: '' }, d.settings.smtp || {});
    d.settings.https = Object.assign({ mode: 'self', cert: '', key: '' }, d.settings.https || {});
    d.settings.scrape = Object.assign({}, empty.settings.scrape, d.settings.scrape || {});
    // 1.5.0：移除境外源（google / openlibrary），只保留国内源
    // 1.9.0：按用户要求去掉「国家图书馆」与「读秀」（家庭网络基本不可达，白等超时）
    // 1.9.10：新增 SaltyLeo 的书架（tstrs.me），排在最后当补充源
    const KNOWN_SOURCES = ['douban', 'isbn', 'dangdang', 'tstrs'];
    if (Array.isArray(d.settings.scrape.providers)) {
      d.settings.scrape.providers = d.settings.scrape.providers.filter(p => KNOWN_SOURCES.includes(p));
    }
    if (!Array.isArray(d.settings.scrape.providers) || !d.settings.scrape.providers.length) {
      d.settings.scrape.providers = ['douban', 'isbn', 'dangdang', 'tstrs'];
    }
    // 老配置自动补上新源（排在最后，只在前面几个源都没结果时才会用到）
    if (!d.settings.scrape.providers.includes('tstrs')) d.settings.scrape.providers.push('tstrs');
    if (d.settings.scrape.provider && !KNOWN_SOURCES.includes(d.settings.scrape.provider)) {
      d.settings.scrape.provider = d.settings.scrape.providers[0];
    }
    // 老配置 provider=google/openlibrary 依然可用
    if (d.settings.scrape.provider && !d.settings.scrape.providers.includes(d.settings.scrape.provider)) {
      d.settings.scrape.providers.unshift(d.settings.scrape.provider);
    }
    d.settings.tts = Object.assign({}, empty.settings.tts, d.settings.tts || {});
    d.settings.tts.openai = Object.assign({}, empty.settings.tts.openai, d.settings.tts.openai || {});
    d.settings.tts.azure = Object.assign({}, empty.settings.tts.azure, d.settings.tts.azure || {});
    d.settings.ai = Object.assign({}, empty.settings.ai, d.settings.ai || {});
    d.settings.storage = Object.assign({ dataDir: '' }, d.settings.storage || {});
    d.settings.security = Object.assign({ tokenTtlHours: 24, collaborativeLibrary: false, frameAncestors: '' }, d.settings.security || {});
    d.settings.library = Object.assign({ excludeExts: [] }, d.settings.library || {});
    if (!Array.isArray(d.settings.library.excludeExts)) d.settings.library.excludeExts = [];
    d.settings.reader = d.settings.reader && typeof d.settings.reader === 'object' ? d.settings.reader : {};
    d.settings.app = Object.assign({ basePath: '/fnbookshelf', phone: null, tv: null }, d.settings.app || {});
    if (typeof d.settings.app.basePath !== 'string') d.settings.app.basePath = '/fnbookshelf';
    d.settings.paths = Array.isArray(d.settings.paths) ? d.settings.paths : [];
    d.users = Array.isArray(d.users) ? d.users : [];
    // 1.7.0：会话版本号（改角色/禁用/退出所有设备时自增，旧令牌立即失效）
    for (const u of d.users) {
      if (typeof u.tokenVer !== 'number') u.tokenVer = 0;
      if (typeof u.status !== 'string') u.status = 'active';
    }
    d.audit = Array.isArray(d.audit) ? d.audit : [];
    d.books = Array.isArray(d.books) ? d.books : [];
    d.progress = d.progress && typeof d.progress === 'object' ? d.progress : {};
    d.finished = d.finished && typeof d.finished === 'object' ? d.finished : {};
    d.shelves = d.shelves && typeof d.shelves === 'object' ? d.shelves : {};
    d.annotations = d.annotations && typeof d.annotations === 'object' ? d.annotations : {};
    d.stats = d.stats && typeof d.stats === 'object' ? d.stats : {};
    d.history = d.history && typeof d.history === 'object' ? d.history : {};
    d.deletions = Array.isArray(d.deletions) ? d.deletions : [];
    // 1.9.0：处理完（同意 / 拒绝）的删除申请只保留 1 天，避免 data.json 无限膨胀
    this._pruneDeletionsInPlace();
    // 1.9.0：版本顺序 / 搜索通知
    d.versionOrder = d.versionOrder && typeof d.versionOrder === 'object' ? d.versionOrder : {};
    d.notifications = Array.isArray(d.notifications) ? d.notifications : [];
    // 1.8.2：专题（collections）
    d.collections = Array.isArray(d.collections) ? d.collections.filter(c => c && typeof c.id === 'string') : [];
    for (const c of d.collections) {
      if (!Array.isArray(c.keys)) c.keys = [];
      c.keys = c.keys.filter(k => typeof k === 'string' && k);
      if (!c.name) c.name = '未命名专题';
      if (typeof c.order !== 'number') c.order = 0;
      if (typeof c.cover !== 'string') c.cover = '';   // 1.9.0：专题封面（covers/col_<id>.<ext>）
    }
    d.aiUsage = d.aiUsage && typeof d.aiUsage === 'object' ? d.aiUsage : {};
    d.works = d.works && typeof d.works === 'object' ? d.works : {};
    d.defaultVersion = d.defaultVersion && typeof d.defaultVersion === 'object' ? d.defaultVersion : {};
    // 书籍字段补齐（版本 / 目录）
    for (const b of d.books) {
      if (!b.workKey) b.workKey = '';
      if (b.manual === undefined) b.manual = {};
      // 目录（toc）外移为独立缓存文件，避免 data.json 膨胀拖慢落盘
      if (Array.isArray(b.toc)) {
        if (b.toc.length) {
          try { fs.writeFileSync(this._tocFile(b.id), JSON.stringify(b.toc)); } catch (_) {}
          b.tocCount = b.toc.length;
        }
        delete b.toc;
      }
      if (b.tocCount === undefined) b.tocCount = 0;
    }
    // ---------- 1.8.0 升级迁移 ----------
    // ① 先把「旧版自动算出来的 workKey」与记录里的对比：不一致说明是用户手动合并/分离过的，
    //    打上 groupLocked，避免升级后被新的归并规则自动并回去。
    for (const b of d.books) {
      if (b.groupLocked !== undefined) continue;
      const legacy = legacyWorkKey(b.title, b.author);
      if (b.workKey && legacy && b.workKey !== legacy) b.groupLocked = true;
    }
    // ② 修复历史乱码书名（PDF/EPUB 元数据按 latin1 误读留下的「æ□□□¨」）
    let fixedTitles = 0;
    for (const b of d.books) if (mojibake.fixBookMeta(b)) fixedTitles++;
    // ③ 按新规则重算归并关系（同名合并 + 系列聚合）
    let regroupStat = null;
    try { regroupStat = grouping.regroup(this); } catch (e) { console.error('[store] 归并计算失败:', e.message); }
    this._migrateInfo = { fixedTitles, regroupStat };
    this.save();
  }

  save() {
    // 防抖 + 脏标记 + 异步落盘（同步全量写会阻塞事件循环，是网页卡死的主因）
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 400);
  }

  /**
   * 1.8.2：分块序列化落盘。
   * 3 万多本的书库 data.json 有 50MB 以上，以前 `JSON.stringify(this.data)` 会一次性
   * 生成 50MB 字符串 + 50MB 写入缓冲，再叠加正在扫描的元数据，很容易冲到 400MB 被
   * NAS 的 OOM 保护杀掉（日志里的「解析元数据 23429/36526、RSS 406MB」就是这么来的）。
   * 现在逐个 key、逐本书产出字符串，峰值内存只有「一本书的 JSON」那么大。
   */
  * _chunks() {
    const d = this.data;
    const keys = Object.keys(d);
    yield '{';
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      yield (i ? ',' : '') + JSON.stringify(k) + ':';
      const v = d[k];
      if (Array.isArray(v) && v.length > 40) {
        // 大数组（books / audit / deletions）逐项写
        yield '[';
        for (let j = 0; j < v.length; j++) {
          const s = JSON.stringify(v[j]);
          yield (j ? ',' : '') + (s === undefined ? 'null' : s);
        }
        yield ']';
      } else {
        const s = JSON.stringify(v);
        yield s === undefined ? 'null' : s;
      }
    }
    yield '}';
  }

  /** 按 256KB 一批写入（带背压），避免 write() 调用过碎或缓冲过大 */
  async _writeFile(tmp) {
    const ws = fs.createWriteStream(tmp, { encoding: 'utf8', highWaterMark: 1 << 20 });
    const finished = new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
    let buf = [];
    let size = 0;
    const put = async force => {
      if (!size) return;
      const chunk = buf.join('');
      buf = []; size = 0;
      if (!ws.write(chunk) && !force) await new Promise(r => ws.once('drain', r));
    };
    for (const s of this._chunks()) {
      if (!s) continue;
      buf.push(s); size += s.length;
      if (size >= 256 * 1024) await put(false);
    }
    await put(true);
    ws.end();
    await finished;
  }

  _flush() {
    if (this._writing) { this._pendingWrite = true; return; }
    if (!this._dirty) return;
    this._writing = true;
    this._dirty = false;
    const tmp = this.file + '.tmp';
    this._writeFile(tmp)
      .then(() => fs.promises.rename(tmp, this.file))
      .catch(e => { console.error('[store] 保存失败:', e.message); this._dirty = true; })
      .finally(() => {
        this._writing = false;
        if (this._pendingWrite) { this._pendingWrite = false; this._flush(); }
      });
  }

  /** 立即异步落盘并等它写完（内存告急 / 本轮扫描收尾时用） */
  async flushNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    let guard = 0;
    while (this._writing && guard++ < 200) await new Promise(r => setTimeout(r, 25));
    if (!this._dirty) return;
    this._dirty = false;
    this._writing = true;
    const tmp = this.file + '.tmp';
    try {
      await this._writeFile(tmp);
      await fs.promises.rename(tmp, this.file);
    } catch (e) {
      this._dirty = true;
      throw e;
    } finally {
      this._writing = false;
      if (this._pendingWrite) { this._pendingWrite = false; this._flush(); }
    }
  }

  /**
   * 同步落盘（只在进程退出/崩溃兜底时用）。
   *
   * 1.8.2.2：加了时间预算。3 万本的库 data.json 有 50MB 以上，慢盘上一次同步写完
   * 可能要几十秒；而这段代码跑在退出流程里，写不完进程就退不掉、监听端口也不关，
   * 外面看到的就是「应用中心显示运行中，网页一直转圈」——正是 1.8.2 用户升级后的现象。
   * 超预算时立刻放弃本轮（删掉临时文件，不覆盖旧文件），宁可丢掉最后几百毫秒的改动。
   * @param {number} maxMs 预算毫秒；0/不传 = 不限
   * @returns {boolean} 是否真的写成功
   */
  flushSync(maxMs) {
    const budget = Math.max(0, Number(maxMs) || 0);
    const t0 = Date.now();
    const tmp = this.file + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      let aborted = false;
      try {
        let buf = [];
        let size = 0;
        const put = () => {
          if (!size) return;
          fs.writeSync(fd, buf.join(''));
          buf = []; size = 0;
        };
        for (const s of this._chunks()) {
          if (!s) continue;
          buf.push(s); size += s.length;
          if (size >= 512 * 1024) {
            put();
            if (budget && Date.now() - t0 > budget) { aborted = true; break; }
          }
        }
        if (!aborted) put();
      } finally { fs.closeSync(fd); }
      if (aborted) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        console.error(`[store] 退出落盘超过 ${budget}ms 预算，已放弃本次写入（数据文件保持上一版本）`);
        return false;
      }
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      return true;
    } catch (e) {
      console.error('[store] 保存失败:', e.message);
      try { fs.unlinkSync(tmp); } catch (_) {}
      return false;
    }
  }

  // ---------- 目录（独立缓存文件，不进 data.json） ----------
  _tocFile(bookId) { return path.join(this.tocDir, bookId + '.json'); }

  getToc(bookId) {
    try { return JSON.parse(fs.readFileSync(this._tocFile(bookId), 'utf8')); } catch (_) { return []; }
  }

  setToc(bookId, toc, meta) {
    const b = this.findBook(bookId);
    if (!b) return null;
    const clean = Array.isArray(toc) ? toc.slice(0, 800) : [];
    b.tocCount = clean.length;
    b.tocAt = Date.now();
    if (meta) b.tocMeta = meta;
    try { fs.writeFileSync(this._tocFile(bookId), JSON.stringify(clean)); } catch (e) { console.error('[store] 目录缓存写入失败:', e.message); }
    this.save();
    return clean;
  }

  // ---------- 默认版本（用户为每部作品选择的版本） ----------
  getDefaultVersion(userId, workKey) {
    return (this.data.defaultVersion[userId] || {})[workKey] || null;
  }

  setDefaultVersion(userId, workKey, bookId) {
    if (!this.data.defaultVersion[userId]) this.data.defaultVersion[userId] = {};
    this.data.defaultVersion[userId][workKey] = bookId;
    this.save();
  }

  // ---------- 版本合并（把 source 归入 target 的作品） ----------
  mergeVersions(sourceId, targetId) {
    const src = this.findBook(sourceId), dst = this.findBook(targetId);
    if (!src || !dst) return null;
    if (src.id === dst.id) return { ok: false, error: '不能与自身合并' };
    src.workKey = dst.workKey || taxonomy.workKey(dst.title, dst.author);
    // 1.8.0：手动合并过的书加锁，扫描/刮削后不会被自动归并再拆开
    src.groupLocked = true;
    dst.groupLocked = true;
    src.series = src.series || '';
    src.updatedAt = Date.now();
    this.save();
    return { ok: true, workKey: src.workKey };
  }

  // ---------- 专题（1.8.2）----------
  // 专题是一组「作品键」的集合：书目在书库里仍然只有一份，专题只是像文件夹一样归类。
  // workKey 与书库列表去重用的键一致；没有 workKey 的书用 'id:<bookId>' 当键。
  listCollections() {
    return (this.data.collections || []).slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  }

  findCollection(id) { return (this.data.collections || []).find(c => c.id === id) || null; }

  /** 找出某本书（作品）所属的全部专题 id */
  collectionsOfKey(key) {
    return (this.data.collections || []).filter(c => c.keys.includes(key)).map(c => c.id);
  }

  createCollection({ name, desc, keys, createdBy }) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) { const e = new Error('专题名称不能为空'); e.status = 400; throw e; }
    const c = {
      id: crypto.randomUUID(), name: clean,
      desc: String(desc || '').trim().slice(0, 300),
      keys: [...new Set((keys || []).filter(k => typeof k === 'string' && k))].slice(0, 20000),
      order: (this.data.collections || []).length,
      createdBy: createdBy || '', createdAt: Date.now(), updatedAt: Date.now()
    };
    this.data.collections.push(c);
    this.save();
    return c;
  }

  updateCollection(id, patch) {
    const c = this.findCollection(id);
    if (!c) return null;
    if (patch.name !== undefined) {
      const n = String(patch.name).trim().slice(0, 60);
      if (!n) { const e = new Error('专题名称不能为空'); e.status = 400; throw e; }
      c.name = n;
    }
    if (patch.desc !== undefined) c.desc = String(patch.desc).trim().slice(0, 300);
    if (patch.order !== undefined) c.order = Number(patch.order) || 0;
    if (patch.cover !== undefined) c.cover = String(patch.cover || '').slice(0, 20);
    c.updatedAt = Date.now();
    this.save();
    return c;
  }

  /** 专题封面文件（covers/col_<id>.<ext>）；没有就返回 null */
  collectionCoverFile(id) {
    const c = this.findCollection(id);
    if (!c || !c.cover) return null;
    const f = path.join(this.coversDir, 'col_' + id + c.cover);
    try { return fs.existsSync(f) ? f : null; } catch (_) { return null; }
  }

  /** 写入专题封面（png/jpeg 字节），返回扩展名 */
  setCollectionCover(id, buf, ext) {
    const c = this.findCollection(id);
    if (!c) return null;
    const e = ext === '.png' ? '.png' : '.jpg';
    for (const old of ['.jpg', '.png', '.webp', '.gif']) {
      try { fs.unlinkSync(path.join(this.coversDir, 'col_' + id + old)); } catch (_) {}
    }
    fs.writeFileSync(path.join(this.coversDir, 'col_' + id + e), buf);
    c.cover = e;
    c.updatedAt = Date.now();
    this.save();
    return e;
  }

  clearCollectionCover(id) {
    for (const old of ['.jpg', '.png', '.webp', '.gif']) {
      try { fs.unlinkSync(path.join(this.coversDir, 'col_' + id + old)); } catch (_) {}
    }
    return this.updateCollection(id, { cover: '' });
  }

  deleteCollection(id) {
    const i = (this.data.collections || []).findIndex(c => c.id === id);
    if (i < 0) return false;
    this.data.collections.splice(i, 1);
    this.save();
    return true;
  }

  addToCollection(id, keys) {
    const c = this.findCollection(id);
    if (!c) return null;
    let added = 0;
    for (const k of keys || []) {
      if (typeof k !== 'string' || !k) continue;
      if (c.keys.includes(k)) continue;
      c.keys.push(k); added++;
    }
    c.updatedAt = Date.now();
    this.save();
    return { added, total: c.keys.length };
  }

  removeFromCollection(id, keys) {
    const c = this.findCollection(id);
    if (!c) return null;
    const rm = new Set((keys || []).filter(k => typeof k === 'string'));
    const before = c.keys.length;
    c.keys = c.keys.filter(k => !rm.has(k));
    c.updatedAt = Date.now();
    this.save();
    return { removed: before - c.keys.length, total: c.keys.length };
  }

  /** 书库列表去重键（与 /books 的 dedupe 保持一致） */
  keyOf(b) { return (b && (b.workKey || ('id:' + b.id))) || ''; }

  // ---------- 注释统计 / 记录 ----------
  countAnnotations(userId, bookId) {
    const arr = (this.data.annotations[userId] || {})[bookId] || [];
    return {
      bookmarks: arr.filter(a => a.type === 'bookmark').length,
      notes: arr.filter(a => a.type !== 'bookmark').length
    };
  }

  countAnnotationsForBook(bookId) {
    // 该版本上所有用户的书签/笔记数（管理员删除前提醒用）
    const out = [];
    for (const [userId, byBook] of Object.entries(this.data.annotations || {})) {
      const arr = byBook[bookId] || [];
      if (!arr.length) continue;
      const u = this.data.users.find(x => x.id === userId);
      out.push({
        userId, email: u ? u.email : '未知用户',
        bookmarks: arr.filter(a => a.type === 'bookmark').length,
        notes: arr.filter(a => a.type !== 'bookmark').length
      });
    }
    return out;
  }

  listAnnotationsGrouped(userId) {
    // 按书籍分组返回当前用户全部书签/笔记
    const byBook = this.data.annotations[userId] || {};
    const groups = [];
    for (const [bookId, arr] of Object.entries(byBook)) {
      if (!arr || !arr.length) continue;
      const b = this.findBook(bookId);
      if (!b) continue;
      groups.push({
        bookId, title: b.title, author: b.author, ext: b.ext, workKey: b.workKey || '',
        annotations: arr.slice().sort((x, y) => y.createdAt - x.createdAt)
      });
    }
    groups.sort((a, c) => {
      const la = a.annotations[0] ? a.annotations[0].createdAt : 0;
      const lc = c.annotations[0] ? c.annotations[0].createdAt : 0;
      return lc - la;
    });
    return groups;
  }

  // ---------- 用户 ----------
  get users() { return this.data.users; }

  findUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return this.data.users.find(u => u.email === e) || null;
  }

  upsertUser(email, role) {
    let u = this.findUserByEmail(email);
    if (!u) {
      u = { id: crypto.randomUUID(), email: String(email).trim().toLowerCase(), role, status: 'active', createdAt: Date.now(), tokenVer: 0 };
      this.data.users.push(u);
    } else {
      u.role = role || u.role;
      if (typeof u.tokenVer !== 'number') u.tokenVer = 0;
    }
    this.save();
    return u;
  }

  // ---------- 1.7.0：敏感操作留痕 ----------
  /**
   * 记录一次会影响全局（或他人）的操作，便于事后追溯。
   * 只保留最近 500 条，避免 data.json 无限膨胀。
   */
  logAudit(req, action, target, detail) {
    if (!Array.isArray(this.data.audit)) this.data.audit = [];
    const u = req && req.user;
    this.data.audit.unshift({
      at: Date.now(),
      by: u ? u.id : '',
      byEmail: u ? u.email : '',
      action: String(action || ''),
      target: String(target || '').slice(0, 200),
      detail: detail === undefined ? '' : String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500),
      ip: (req && req.socket && req.socket.remoteAddress) || ''
    });
    if (this.data.audit.length > 500) this.data.audit.length = 500;
    this.save();
  }

  listAudit(limit = 200) {
    return (this.data.audit || []).slice(0, Math.max(1, Math.min(500, limit)));
  }

  // ---------- 验证码（内存，重启失效） ----------
  ensureCodes() { if (!this.data._codes) this.data._codes = {}; return this.data._codes; }

  // ---------- 图书 ----------
  get books() { return this.data.books; }

  findBook(id) { return this.data.books.find(b => b.id === id) || null; }

  upsertBook(b) {
    const i = this.data.books.findIndex(x => x.id === b.id);
    if (i >= 0) this.data.books[i] = b; else this.data.books.push(b);
    this.save();
  }

  removeBook(id) {
    this.data.books = this.data.books.filter(b => b.id !== id);
    for (const c of [path.join(this.coversDir, id + '.jpg'), path.join(this.coversDir, id + '.png'), this._tocFile(id)]) {
      try { fs.unlinkSync(c); } catch (_) {}
    }
    this.save();
  }

  // ---------- 1.6.3：存储自检 / 权限修复 ----------
  /** 检查数据目录可写、封面与书库文件可读；供后台「数据位置」面板展示 */
  audit() {
    const out = {
      dataDir: this.dataDir,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      writable: true, error: '',
      covers: { total: 0, unreadable: 0, sample: '' },
      books: { total: 0, unreadable: 0, sample: '' }
    };
    try {
      const probe = path.join(this.dataDir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (e) {
      out.writable = false;
      out.error = e.code || e.message;
    }
    try {
      const names = fs.readdirSync(this.coversDir);
      for (const n of names) {
        if (!/\.(jpe?g|png|webp|gif)$/i.test(n)) continue;
        out.covers.total++;
        const f = path.join(this.coversDir, n);
        try { fs.accessSync(f, fs.constants.R_OK); }
        catch (e) { out.covers.unreadable++; if (!out.covers.sample) out.covers.sample = f; }
      }
    } catch (_) {}
    for (const b of (this.data.books || []).slice(0, 2000)) {
      out.books.total++;
      try { fs.accessSync(b.path, fs.constants.R_OK); }
      catch (e) { out.books.unreadable++; if (!out.books.sample) out.books.sample = b.path; }
    }
    return out;
  }

  /** 尽力修正权限（chmod）；属主不是本进程时无法修复，会把失败原因返回给管理员 */
  repair() {
    const res = { chmodDirs: 0, chmodFiles: 0, failed: [] };
    const chmod = (f, mode, kind) => {
      try { fs.chmodSync(f, mode); res[kind]++; return true; }
      catch (e) {
        if (res.failed.length < 20) res.failed.push(`${f}（${e.code || e.message}）`);
        return false;
      }
    };
    for (const d of [this.dataDir, this.coversDir, this.cacheDir, this.trashDir, this.tocDir]) chmod(d, 0o775, 'chmodDirs');
    try {
      for (const n of fs.readdirSync(this.coversDir)) {
        if (/\.(jpe?g|png|webp|gif)$/i.test(n)) chmod(path.join(this.coversDir, n), 0o644, 'chmodFiles');
      }
    } catch (_) {}
    for (const b of (this.data.books || []).slice(0, 2000)) {
      try { fs.accessSync(b.path, fs.constants.R_OK); }
      catch (_) { chmod(b.path, 0o644, 'chmodFiles'); }
    }
    return res;
  }

  // ---------- 阅读进度 ----------
  getProgress(userId, bookId) {
    return (this.data.progress[userId] || {})[bookId] || null;
  }

  setProgress(userId, bookId, p) {
    if (!this.data.progress[userId]) this.data.progress[userId] = {};
    this.data.progress[userId][bookId] = Object.assign({ updatedAt: Date.now() }, this.data.progress[userId][bookId], p);
    this.save();
  }

  // ---------- 已读完（1.6.0） ----------
  getFinished(userId) { return this.data.finished[userId] || {}; }

  isFinished(userId, bookId) { return !!(this.data.finished[userId] || {})[bookId]; }

  setFinished(userId, bookId, done) {
    if (!this.data.finished[userId]) this.data.finished[userId] = {};
    if (done) {
      this.data.finished[userId][bookId] = { at: Date.now(), pct: 100 };
      // 同步把阅读进度推到 100%，统计页「已读完」按 pct>=100 或本表取并集
      this.setProgress(userId, bookId, { pct: 100 });
    } else {
      delete this.data.finished[userId][bookId];
      // 撤销「读过」时把进度从 100% 退到 99%（保留 cfi/页码），
      // 否则统计页会因为 pct>=100 又把它算回已读完
      const p = this.getProgress(userId, bookId);
      if (p && Number(p.pct) >= 100) this.setProgress(userId, bookId, { pct: 99 });
    }
    this.save();
    return !!done;
  }

  /** 已读完列表：手工标记 ∪ 阅读进度达到 100% 的书 */
  listFinished(userId) {
    const out = new Map();
    for (const [id, rec] of Object.entries(this.getFinished(userId))) {
      const b = this.findBook(id);
      if (b) out.set(id, { book: b, at: rec.at || 0, manual: true });
    }
    for (const [id, p] of Object.entries(this.data.progress[userId] || {})) {
      if (!p || Number(p.pct) < 100 || out.has(id)) continue;
      const b = this.findBook(id);
      if (b) out.set(id, { book: b, at: p.updatedAt || 0, manual: false });
    }
    return [...out.values()].sort((a, c) => c.at - a.at);
  }

  // ---------- 个人书架 ----------
  getShelf(userId) { return this.data.shelves[userId] || []; }

  toggleShelf(userId, bookId) {
    if (!this.data.shelves[userId]) this.data.shelves[userId] = [];
    const arr = this.data.shelves[userId];
    const i = arr.indexOf(bookId);
    if (i >= 0) arr.splice(i, 1); else arr.push(bookId);
    this.save();
    return i < 0; // 返回是否已加入
  }

  // ---------- 书签 / 高亮 / 笔记 ----------
  getAnnotations(userId, bookId) {
    return ((this.data.annotations[userId] || {})[bookId]) || [];
  }

  addAnnotation(userId, bookId, ann) {
    if (!this.data.annotations[userId]) this.data.annotations[userId] = {};
    if (!this.data.annotations[userId][bookId]) this.data.annotations[userId][bookId] = [];
    const a = Object.assign({ id: crypto.randomUUID(), createdAt: Date.now() }, ann);
    this.data.annotations[userId][bookId].push(a);
    this.save();
    return a;
  }

  removeAnnotation(userId, bookId, annId) {
    const arr = this.getAnnotations(userId, bookId);
    const i = arr.findIndex(a => a.id === annId);
    if (i >= 0) { arr.splice(i, 1); this.save(); return true; }
    return false;
  }

  // ---------- 阅读统计 ----------
  addReadingTime(userId, bookId, seconds) {
    seconds = Math.min(120, Math.max(0, Math.round(Number(seconds) || 0)));
    if (!seconds) return;
    if (!this.data.stats[userId]) this.data.stats[userId] = { totalSec: 0, byBook: {}, byDay: {}, opened: 0 };
    const s = this.data.stats[userId];
    s.totalSec += seconds;
    s.byBook[bookId] = (s.byBook[bookId] || 0) + seconds;
    const now = new Date();
    const day = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10); // 本地日期
    s.byDay[day] = (s.byDay[day] || 0) + seconds;
    // 只保留最近 60 天
    const days = Object.keys(s.byDay).sort();
    while (days.length > 60) delete s.byDay[days.shift()];
    this.save();
    return s;
  }

  markOpened(userId, bookId) {
    if (!this.data.stats[userId]) this.data.stats[userId] = { totalSec: 0, byBook: {}, byDay: {}, opened: 0 };
    this.data.stats[userId].opened = (this.data.stats[userId].opened || 0) + 1;
    if (!this.data.history[userId]) this.data.history[userId] = [];
    const h = this.data.history[userId];
    const i = h.findIndex(x => x.bookId === bookId);
    if (i >= 0) h.splice(i, 1);
    h.unshift({ bookId, at: Date.now() });
    if (h.length > 100) h.length = 100;
    this.save();
  }

  getStats(userId) {
    return this.data.stats[userId] || { totalSec: 0, byBook: {}, byDay: {}, opened: 0 };
  }

  getHistory(userId) { return this.data.history[userId] || []; }

  // ---------- 删除申请（所有删除都要管理员二次确认） ----------
  addDeletion(entry) {
    const d = Object.assign({
      id: crypto.randomUUID(), status: 'pending', note: '',
      requestedAt: Date.now()
    }, entry);
    this.data.deletions.unshift(d);
    if (this.data.deletions.length > 500) this.data.deletions.length = 500;
    this.save();
    return d;
  }

  listDeletions(status) {
    const list = this.data.deletions;
    return status ? list.filter(d => d.status === status) : list;
  }

  getDeletion(id) { return this.data.deletions.find(d => d.id === id) || null; }

  resolveDeletion(id, status, by) {
    const d = this.getDeletion(id);
    if (!d) return null;
    d.status = status;
    d.resolvedAt = Date.now();
    d.resolvedBy = by;
    this.save();
    return d;
  }

  countPendingDeletions() { return this.data.deletions.filter(d => d.status === 'pending').length; }

  /** 1.9.0：已处理（同意/拒绝）的申请只保留 1 天 */
  _pruneDeletionsInPlace() {
    const KEEP = 24 * 3600 * 1000;
    const now = Date.now();
    this.data.deletions = (this.data.deletions || []).filter(d => {
      if (!d || d.status === 'pending') return true;
      const at = Number(d.resolvedAt) || Number(d.requestedAt) || 0;
      return now - at < KEEP;
    });
  }

  /** 由启动 / 定时调用：真正删掉过期记录并落盘 */
  pruneDeletions() {
    const before = (this.data.deletions || []).length;
    this._pruneDeletionsInPlace();
    const removed = before - this.data.deletions.length;
    if (removed) this.save();
    return removed;
  }

  // ---------- 1.9.1：回收站 ----------
  // 文件名格式：<ISO时间戳>_<原始文件名>，时间戳里的 : 与 . 已替换成 -
  // 例：2026-11-13T12-30-00-000Z_三体.pdf
  static trashStampName(srcPath, at) {
    const d = new Date(at || Date.now());
    const stamp = d.toISOString().replace(/[:.]/g, '-');
    return `${stamp}_${path.basename(srcPath)}`;
  }

  /** 从回收站文件名还原原始文件名 */
  static trashOriginalName(name) {
    const m = String(name || '').match(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_(.+)$/);
    return m ? m[1] : String(name || '');
  }

  /** 回收站条目清单（含原始名、大小、移入时间、剩余保留天数） */
  listTrash() {
    let items = [];
    try {
      for (const f of fs.readdirSync(this.trashDir)) {
        const p = path.join(this.trashDir, f);
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (!st.isFile()) continue;
        const m = f.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
        const at = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : st.mtimeMs;
        items.push({
          name: f,
          original: Store.trashOriginalName(f),
          size: st.size,
          at,
          expireAt: at + TRASH_KEEP_DAYS * 86400000
        });
      }
    } catch (_) {}
    return items.sort((a, b) => b.at - a.at);
  }

  /** 把回收站里的文件放回原路径（默认回到「同名书所在的原始目录」，找不到就回数据目录下 restored/） */
  restoreFromTrash(name, targetPath) {
    const safe = String(name || '');
    if (!safe || safe !== path.basename(safe) || safe.includes('..')) {
      throw Object.assign(new Error('文件名不合法'), { status: 400 });
    }
    const src = path.join(this.trashDir, safe);
    if (!fs.existsSync(src)) throw Object.assign(new Error('回收站里找不到这个文件'), { status: 404 });
    const orig = Store.trashOriginalName(safe);
    let dest = String(targetPath || '').trim();
    if (!dest) {
      // 找同名的历史记录（data.deletions 里存过 path），否则放到数据目录 restored/
      const rec = (this.data.deletions || []).find(d => d.filename === orig && d.path);
      dest = rec ? rec.path : path.join(this.dataDir, 'restored', orig);
    }
    if (path.resolve(dest) === path.resolve(src)) throw Object.assign(new Error('目标路径不能是回收站本身'), { status: 400 });
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) {}
    if (fs.existsSync(dest)) {
      // 已有同名文件：加后缀，绝不覆盖
      const e = path.extname(dest), stem = dest.slice(0, dest.length - e.length);
      let i = 2;
      while (fs.existsSync(dest)) { dest = `${stem} (恢复${i})${e}`; i++; }
    }
    try { fs.renameSync(src, dest); }
    catch (e) {
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
      catch (e2) { throw Object.assign(new Error('恢复失败：' + e2.message), { status: 500 }); }
    }
    this.save();
    return { ok: true, restored: dest, original: orig };
  }

  /** 物理删除回收站单个文件 */
  purgeTrash(name) {
    const safe = String(name || '');
    if (!safe || safe !== path.basename(safe) || safe.includes('..')) {
      throw Object.assign(new Error('文件名不合法'), { status: 400 });
    }
    const p = path.join(this.trashDir, safe);
    if (!fs.existsSync(p)) throw Object.assign(new Error('回收站里找不到这个文件'), { status: 404 });
    fs.unlinkSync(p);
    return { ok: true };
  }

  /** 清空回收站：物理删除全部（或只删过期的） */
  emptyTrash(onlyExpired) {
    let n = 0;
    const cutoff = Date.now() - TRASH_KEEP_DAYS * 86400000;
    try {
      for (const f of fs.readdirSync(this.trashDir)) {
        const p = path.join(this.trashDir, f);
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (!st.isFile()) continue;
        if (onlyExpired) {
          const m = f.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
          const at = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : st.mtimeMs;
          if (at > cutoff) continue;
        }
        try { fs.unlinkSync(p); n++; } catch (_) {}
      }
    } catch (_) {}
    return { ok: true, removed: n };
  }

  /** 1.9.1：回收站里的文件保留 30 天后自动删除（启动与每日定时各跑一次） */
  pruneTrash() {
    return this.emptyTrash(true).removed || 0;
  }

  // ---------- 1.9.0：版本顺序 ----------
  getVersionOrder(workKey) {
    const arr = (this.data.versionOrder || {})[workKey];
    return Array.isArray(arr) ? arr : [];
  }

  /** 按管理员调整后的顺序排列版本（不在顺序表里的排在后面，保持原相对次序） */
  sortVersions(workKey, list) {
    const order = this.getVersionOrder(workKey);
    if (!order.length || !Array.isArray(list)) return list;
    const pos = new Map(order.map((id, i) => [id, i]));
    return list.slice().sort((a, b) => {
      const pa = pos.has(a.id) ? pos.get(a.id) : 1e6;
      const pb = pos.has(b.id) ? pos.get(b.id) : 1e6;
      return pa - pb;
    });
  }

  setVersionOrder(workKey, ids) {
    if (!this.data.versionOrder) this.data.versionOrder = {};
    this.data.versionOrder[workKey] = (ids || []).filter(x => typeof x === 'string' && x).slice(0, 500);
    this.save();
    return this.data.versionOrder[workKey];
  }

  // ---------- 1.9.0：搜索无结果通知 ----------
  addNotification(n) {
    if (!Array.isArray(this.data.notifications)) this.data.notifications = [];
    const item = {
      id: crypto.randomUUID(),
      q: String((n && n.q) || '').slice(0, 200),
      scope: String((n && n.scope) || 'library').slice(0, 20),
      by: (n && n.by) || '',
      byEmail: (n && n.byEmail) || '',
      at: Date.now(),
      readAt: 0
    };
    // 同一个词 10 分钟内只记一次，避免用户连点刷屏
    const dup = this.data.notifications.find(x =>
      !x.readAt && x.q === item.q && item.at - x.at < 10 * 60 * 1000);
    if (dup) return dup;
    this.data.notifications.unshift(item);
    if (this.data.notifications.length > 500) this.data.notifications.length = 500;
    this.save();
    return item;
  }

  listNotifications() { return (this.data.notifications || []).slice(); }

  clearNotifications(ids) {
    if (!Array.isArray(this.data.notifications)) return 0;
    const before = this.data.notifications.length;
    if (Array.isArray(ids) && ids.length) {
      const rm = new Set(ids.map(String));
      this.data.notifications = this.data.notifications.filter(n => !rm.has(n.id));
    } else {
      this.data.notifications = [];
    }
    this.save();
    return before - this.data.notifications.length;
  }

  countUnreadNotifications() { return (this.data.notifications || []).filter(n => !n.readAt).length; }

  // ---------- AI 调用配额 ----------
  aiQuota(userId, dailyLimit) {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.data.aiUsage[userId]) this.data.aiUsage[userId] = {};
    const used = this.data.aiUsage[userId][day] || 0;
    return { day, used, limit: dailyLimit, left: Math.max(0, dailyLimit - used) };
  }

  aiConsume(userId) {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.data.aiUsage[userId]) this.data.aiUsage[userId] = {};
    this.data.aiUsage[userId][day] = (this.data.aiUsage[userId][day] || 0) + 1;
    // 只保留最近 14 天
    const keys = Object.keys(this.data.aiUsage[userId]).sort();
    while (keys.length > 14) delete this.data.aiUsage[userId][keys.shift()];
    this.save();
    return this.data.aiUsage[userId][day];
  }

  aiTodayTotal() {
    const day = new Date().toISOString().slice(0, 10);
    return Object.values(this.data.aiUsage).reduce((n, m) => n + (m[day] || 0), 0);
  }
}

module.exports = { Store, TRASH_KEEP_DAYS };
