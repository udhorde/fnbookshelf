// 运行日志 / 崩溃取证
// 日志文件按「本地日期」分文件，只保留最近 2 天；崩溃原因写入 crash.json。
// 日志只保存在本机，绝不通过邮件外发（1.4.1 起已移除重启邮件报告）。
// running.json 同时充当「崩溃现场」：扫描时持续写入阶段/当前文件/内存，
// 进程被 OOM killer / SIGKILL 强杀后，重启时可直接还原上次死在哪里。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEP_DAYS = 2;          // 日志最多保存 2 天
const FLUSH_MS = 400;         // 批量落盘间隔
const MAX_MSG = 1800;         // 单条日志最大长度
const MAX_READ = 2 * 1024 * 1024; // 后台读取单个日志文件的最大字节数（只读尾部）

function localDay(d) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}
function clip(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s == null ? '' : s).slice(0, n);
}
function mem() {
  const m = process.memoryUsage();
  return { rss: Math.round(m.rss / 1048576), heap: Math.round(m.heapUsed / 1048576), external: Math.round(m.external / 1048576) };
}

/** 只读文件尾部 maxBytes（避免日志变大后整本读入内存） */
function readTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, maxBytes);
    const buf = Buffer.alloc(n);
    let read = 0;
    while (read < n) {
      const r = fs.readSync(fd, buf, read, n - read, size - n + read);
      if (!r) break;
      read += r;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

class Logger {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'logs');
    this.crashFile = path.join(this.dir, 'crash.json');
    this.runningFile = path.join(this.dir, 'running.json');
    this.queue = [];
    this.context = '启动';
    this.bootAt = Date.now();
    this.version = '1.6.2';
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  dayFile(day) { return path.join(this.dir, day + '.log'); }
  setContext(c) { this.context = String(c || '空闲'); }
  getContext() { return this.context; }

  log(level, scope, msg, extra) {
    const rec = {
      t: new Date().toISOString(), level: String(level).toUpperCase(),
      scope: String(scope || 'app'), ctx: this.context, msg: clip(msg, MAX_MSG)
    };
    if (extra != null) rec.extra = clip(extra, 1200);
    const text = JSON.stringify(rec) + '\n';
    this.queue.push({ day: localDay(new Date()), text });
    if (level === 'FATAL' || level === 'ERROR' || level === 'WARN' || this.queue.length >= 60) this.flush();
    if (level === 'FATAL' || level === 'ERROR' || level === 'WARN') {
      console[level === 'FATAL' ? 'error' : level.toLowerCase()](`[${scope}] ${rec.msg}`);
    } else if (level === 'INFO') {
      console.log(`[${scope}] ${rec.msg}`);
    }
    return rec;
  }
  info(scope, msg, extra) { return this.log('INFO', scope, msg, extra); }
  warn(scope, msg, extra) { return this.log('WARN', scope, msg, extra); }
  error(scope, msg, extra) { return this.log('ERROR', scope, msg, extra); }
  fatal(scope, msg, extra) { return this.log('FATAL', scope, msg, extra); }

  /** 批量异步落盘：把内存队列按日期分组追加，避免高频同步写阻塞事件循环 */
  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    const groups = new Map();
    for (const it of batch) {
      if (!groups.has(it.day)) groups.set(it.day, []);
      groups.get(it.day).push(it.text);
    }
    for (const [day, lines] of groups) {
      try { fs.appendFileSync(this.dayFile(day), lines.join(''), 'utf8'); }
      catch (e) { console.error('[logger] 写入日志失败:', e.message); }
    }
    const day = localDay(new Date());
    if (this._lastPruneDay !== day) { this._lastPruneDay = day; this.prune(); }
  }

  /** 只保留今天 + 昨天（共 2 天）的日志文件 */
  prune() {
    try {
      const keep = new Set();
      for (let i = 0; i < KEEP_DAYS; i++) keep.add(localDay(new Date(Date.now() - i * 86400000)));
      for (const f of fs.readdirSync(this.dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        if (!keep.has(f.slice(0, 10))) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) {} }
      }
    } catch (_) {}
  }

  listFiles() {
    try {
      return fs.readdirSync(this.dir).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse()
        .map(f => {
          const st = fs.statSync(path.join(this.dir, f));
          return { day: f.slice(0, 10), size: st.size, mtime: st.mtimeMs };
        });
    } catch (_) { return []; }
  }

  /** 结构化读取最近日志（供后台查看；只读尾部，日志再大也不会撑爆内存） */
  readLines(limit) {
    limit = Math.min(500, Math.max(1, Number(limit) || 150));
    const out = [];
    for (const f of this.listFiles().reverse()) {
      let txt = '';
      try { txt = readTail(this.dayFile(f.day), MAX_READ); } catch (_) { continue; }
      const lines = txt.trim().split('\n');
      if (lines.length && txt.length >= MAX_READ) lines.shift(); // 去掉可能被截断的首行
      for (const line of lines) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch (_) {}
      }
    }
    return out.slice(-limit).reverse();
  }

  errorSummary(maxLines) {
    maxLines = maxLines || 40;
    const lines = this.readLines(500).filter(l => l.level === 'ERROR' || l.level === 'FATAL');
    return lines.slice(0, maxLines).map(l => `[${l.t}] ${l.level} ${l.scope}: ${l.msg}`);
  }

  readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
  writeJson(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj)); } catch (_) {} }
  readCrash() { return this.readJson(this.crashFile); }
  readProgress() { return this.readJson(this.runningFile); }

  /** 更新 running.json 里的「崩溃现场」，保留 pid/at/version 供异常退出检测 */
  noteProgress(fields) {
    const cur = this.readJson(this.runningFile) || {};
    cur.pid = process.pid;
    cur.at = cur.at || Date.now();
    cur.version = this.version;
    cur.updatedAt = Date.now();
    Object.assign(cur, fields || {});
    this.writeJson(this.runningFile, cur);
  }

  /** 记录一次崩溃/异常终止 */
  recordCrash(reason, err, extra, crashContext) {
    const rec = {
      at: Date.now(), time: new Date().toLocaleString('zh-CN'),
      reason, context: crashContext || this.context, pid: process.pid,
      uptimeSec: Math.round((Date.now() - this.bootAt) / 1000),
      memoryMB: mem(), host: os.hostname(), platform: process.platform,
      message: err && err.message ? String(err.message) : String(err || ''),
      stack: err && err.stack ? String(err.stack).slice(0, 4000) : '',
      extra: extra || null
    };
    this.writeJson(this.crashFile, rec);
    this.fatal('crash', `崩溃原因：${reason} — ${rec.message}`,
      JSON.stringify({ context: rec.context, memoryMB: rec.memoryMB, stack: rec.stack.slice(0, 800) }));
    this.flush();
    return rec;
  }

  /**
   * 启动时检测上次是否为异常终止。
   * running.json 由本进程启动时写入，正常退出时删除；残留 = 被 SIGKILL/OOM/断电杀掉。
   * 残留里带有扫描心跳（阶段、最后一个文件、RSS），据此还原崩溃现场。
   */
  detectAbnormalExit() {
    const prev = this.readJson(this.runningFile);
    this.writeJson(this.runningFile, {
      pid: process.pid, at: Date.now(), version: this.version,
      phase: '启动', lastBook: '', scanned: 0, total: 0, rssMB: 0, context: '启动'
    });
    if (prev && prev.pid !== process.pid) {
      const inWork = prev.phase && prev.phase !== '空闲' && prev.phase !== '启动';
      // 跨版本升级时 fnOS 会先停旧服务；旧版 running.json 没有扫描心跳，不应误报为崩溃
      const upgraded = prev.version && prev.version !== this.version;
      if (!inWork && upgraded) {
        this.warn('process', `检测到版本升级（${prev.version} → ${this.version}），上次进程未收到正常退出信号属停止/升级流程，未按崩溃记录`);
        return '';
      }
      let reason = inWork
        ? `上次进程（PID ${prev.pid}）在「${prev.phase}」期间被强制终止（多为内存不足 OOM，也可能是 NAS 看门狗、断电或强制重启）`
        : `上次进程（PID ${prev.pid}）未收到正常退出信号（可能是强制重启、断电或系统终止）`;
      const parts = [];
      if (inWork) parts.push(`阶段「${prev.phase}」`);
      if (prev.lastBook) parts.push(`最后处理《${prev.lastBook}》`);
      if (prev.scanned != null && prev.total) parts.push(`进度 ${prev.scanned}/${prev.total} 本`);
      if (prev.rssMB) parts.push(`内存 RSS 约 ${prev.rssMB}MB`);
      if (parts.length) reason += `；崩溃现场：${parts.join('、')}`;
      this.recordCrash(reason, null, {
        prevStartedAt: prev.at, phase: prev.phase || '', lastBook: prev.lastBook || '',
        scanned: prev.scanned || 0, total: prev.total || 0, rssMB: prev.rssMB || 0
      }, prev.context || '未知');
      return reason;
    }
    return '';
  }

  markNormalExit(reason) {
    this.info('process', `正常退出：${reason}`);
    this.flush();
    try { fs.unlinkSync(this.runningFile); } catch (_) {}
  }

  /** 安装全局异常钩子 + 事件循环阻塞 / 内存监控 */
  install(store) {
    // 1.6.3：文件系统 / 网络类的偶发异常只影响单次请求（比如某个封面文件属主是 root、
    // 读取时抛 EACCES），以前会直接 process.exit(1)，造成「开机就崩、崩了又重启」的死循环。
    // 这类错误改为记 ERROR 并继续服务，真正的逻辑异常仍然退出并留存崩溃现场。
    const SOFT = new Set([
      'EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'EBUSY', 'EMFILE', 'ENFILE',
      'EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT',
      'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'
    ]);
    process.on('uncaughtException', e => {
      const code = e && e.code;
      if (SOFT.has(code)) {
        this.error('process', `已拦截可恢复异常 ${code}：${(e && e.message) || e}（进程继续运行）`, e && e.stack);
        return;
      }
      this.recordCrash('未捕获的 JavaScript 异常（uncaughtException）', e);
      // 1.8.2.2：这里必须有预算。以前同步全量写 50MB+ 的 data.json，
      // 一旦写不完就卡在退出流程里，进程不退、端口不关，表现为「网页打不开」。
      try { store.flushSync(2000); } catch (_) {}
      process.exit(1);
    });
    process.on('unhandledRejection', e => {
      this.error('process', '未处理的 Promise 拒绝（unhandledRejection）', e && (e.stack || e.message || String(e)));
    });
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const lag = now - last - 1000;
      last = now;
      if (lag > 1500) {
        this.warn('event-loop', `事件循环阻塞约 ${lag}ms（网页可能短暂无响应）`,
          JSON.stringify({ context: this.context, memoryMB: mem(), load: os.loadavg() }));
      }
    }, 1000);
    if (t.unref) t.unref();

    // 内存预警：逼近系统 OOM 阈值时留下明确证据，而不是无声被杀
    const warnAt = 384;
    let warned = false;
    const mt = setInterval(() => {
      const m = mem();
      if (m.rss > warnAt && !warned) {
        warned = true;
        this.warn('memory', `进程内存 RSS 达到 ${m.rss}MB，已接近系统 OOM 保护线`,
          JSON.stringify({ context: this.context, memoryMB: m }));
      } else if (m.rss < warnAt * 0.75) warned = false;
    }, 5000);
    if (mt.unref) mt.unref();
  }
}

let instance = null;
function init(dataDir) { if (!instance) instance = new Logger(dataDir); return instance; }
function get() {
  if (!instance) instance = new Logger(path.join(os.tmpdir(), 'fnbookshelf-logs'));
  return instance;
}
module.exports = { init, get, Logger, localDay, KEEP_DAYS, readTail };
