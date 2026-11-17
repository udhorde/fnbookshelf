// 定时自动扫描 / 自动刮削（本地时间），1.9.1 起周期可自由设定
//   settings.autoScan = {
//     enabled: true,
//     every: 'day' | 'hour' | 'week' | 'month',   // 周期单位
//     interval: 1,                                // 每 N 个单位（1 小时 / 2 天 / 3 天 ...）
//     at: '00:00',                                // every=day 时的时刻（HH:MM）
//     hour: 3,                                    // every=hour 时的第几分钟之外，仅在每小时整点触发
//     minute: 0,                                  // 分钟偏移（0-59），hour/day 都以此为准
//     weekdays: [1,2,3,4,5,6,0],                  // every=week 时的星期（0=周日）
//     monthDay: 1,                                // every=month 时的日
//     lastDate, lastAt, lastResult, nextAt        // 运行时状态（自动维护）
//   }
// 兼容老数据：只有 enabled/lastDate 时按「每天 00:00」处理。
// 另带：分批续扫（大书库一次扫不完）、启动补扫、崩溃跳过。
'use strict';
const logger = require('./logger');

const CATCHUP_DELAY_MS = 5 * 60 * 1000;  // 启动补扫延后 5 分钟，避开启动瞬间的资源高峰
const BATCH_GAP_MS = 20 * 1000;           // 分批之间间隔 20 秒（落盘与 GC 都来得及收尾）
const BATCH_LIMIT = 500;                  // 续扫每轮最多 500 本
const MAX_BATCH_ROUNDS = 80;              // 自动续扫最多 80 轮（500 × 80 = 4 万本）
const TICK_MS = 30000;

function todayKey() { return logger.localDay(new Date()); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dayKeyOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function minuteKeyOf(d) { return `${dayKeyOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/** 把 settings.autoScan 归一化成完整配置（不改原对象） */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const every = ['hour', 'day', 'week', 'month'].indexOf(src.every) >= 0 ? src.every : 'day';
  let interval = Math.round(Number(src.interval));
  if (!isFinite(interval) || interval < 1) interval = 1;
  interval = Math.min(interval, every === 'hour' ? 168 : 90);
  let at = typeof src.at === 'string' && /^\d{1,2}:\d{2}$/.test(src.at) ? src.at : '';
  if (!at) at = `${pad(Math.min(23, Math.max(0, Number(src.hour) || 0)))}:${pad(Math.min(59, Math.max(0, Number(src.minute) || 0)))}`;
  const mm = at.split(':');
  const hour = Math.min(23, Math.max(0, Number(mm[0]) || 0));
  const minute = Math.min(59, Math.max(0, Number(mm[1]) || 0));
  let weekdays = Array.isArray(src.weekdays) ? src.weekdays.map(Number).filter(d => d >= 0 && d <= 6) : null;
  if (!weekdays || !weekdays.length) weekdays = [0, 1, 2, 3, 4, 5, 6];
  weekdays = Array.from(new Set(weekdays)).sort((a, b) => a - b);
  let monthDay = Math.round(Number(src.monthDay));
  if (!isFinite(monthDay) || monthDay < 1) monthDay = 1;
  monthDay = Math.min(31, monthDay);
  const scrape = src.scrape !== false;      // 自动扫描完成后是否顺带自动刮削
  return {
    enabled: src.enabled !== false,
    every, interval, at, hour, minute, weekdays, monthDay, scrape,
    lastDate: src.lastDate || '',
    lastAt: Number(src.lastAt) || 0,
    lastResult: src.lastResult || '',
    lastReason: src.lastReason || '',
    lastDay: src.lastDay || '',
    lastHour: src.lastHour || '',
    lastWeek: src.lastWeek || '',
    lastMonth: src.lastMonth || ''
  };
}

/** 计算下一次应触发的时刻（毫秒）。依据「上次触发时刻」推进，避免停机错乱。 */
function computeNext(cfg, fromMs) {
  const from = new Date(Number(fromMs) || Date.now());
  const base = new Date(from.getTime());
  // 从「上一次触发时刻 + 1 分钟」开始找，最多向前找 400 天
  base.setSeconds(0, 0);
  base.setMinutes(base.getMinutes() + 1);
  const step = cfg.every === 'hour' ? Math.max(1, cfg.interval) : 1;
  if (cfg.every === 'hour') {
    const c = new Date(base.getTime());
    c.setMinutes(cfg.minute, 0, 0);
    if (c.getTime() < base.getTime()) c.setHours(c.getHours() + 1, cfg.minute, 0, 0);
    // 每 N 小时：对齐到「上次触发时刻」的整 N 小时网格
    if (cfg.interval > 1 && Number(cfg.lastAt)) {
      const anchor = new Date(Number(cfg.lastAt)); anchor.setMinutes(cfg.minute, 0, 0);
      const ah = anchor.getHours();
      for (let i = 0; i < 24 * 8; i++) {
        if (c.getTime() > anchor.getTime() && ((c.getHours() - ah + 24) % cfg.interval) === 0) break;
        c.setHours(c.getHours() + 1, cfg.minute, 0, 0);
      }
    }
    return c.getTime();
  }
  if (cfg.every === 'day') {
    const c = new Date(base.getTime());
    c.setHours(cfg.hour, cfg.minute, 0, 0);
    if (c.getTime() < base.getTime()) c.setDate(c.getDate() + 1);
    if (cfg.interval > 1) {
      // 每 N 天：以 lastAt 那天为基准，向前推到间隔对齐的日期
      const anchor = Number(cfg.lastAt) || base.getTime();
      const a = new Date(anchor); a.setHours(0, 0, 0, 0);
      let days = 0;
      while (days < 400) {
        const t = new Date(a.getTime());
        t.setDate(a.getDate() + days);
        t.setHours(cfg.hour, cfg.minute, 0, 0);
        if (t.getTime() >= base.getTime() && days % cfg.interval === 0) { c.setTime(t.getTime()); break; }
        if (t.getTime() >= base.getTime()) { c.setTime(t.getTime()); break; }
        days++;
      }
    }
    return c.getTime();
  }
  if (cfg.every === 'week') {
    const c = new Date(base.getTime());
    c.setHours(cfg.hour, cfg.minute, 0, 0);
    for (let i = 0; i < 8; i++) {
      if (c.getTime() >= base.getTime() && cfg.weekdays.indexOf(c.getDay()) >= 0) break;
      c.setDate(c.getDate() + 1);
      c.setHours(cfg.hour, cfg.minute, 0, 0);
    }
    // 每 N 周：以 lastAt 所在周为第 0 周
    if (cfg.interval > 1 && Number(cfg.lastAt)) {
      const a = new Date(Number(cfg.lastAt)); a.setHours(0, 0, 0, 0);
      const aSun = new Date(a.getTime()); aSun.setDate(a.getDate() - a.getDay());
      let weeks = 0;
      while (weeks < 60) {
        const t = new Date(c.getTime());
        const tSun = new Date(t.getTime()); tSun.setHours(0, 0, 0, 0); tSun.setDate(t.getDate() - t.getDay());
        const diffW = Math.round((tSun.getTime() - aSun.getTime()) / (7 * 86400000));
        if (diffW % cfg.interval === 0) break;
        c.setDate(c.getDate() + 1);
        weeks++;
      }
    }
    return c.getTime();
  }
  // month
  const c = new Date(base.getTime());
  c.setHours(cfg.hour, cfg.minute, 0, 0);
  const setToDay = d => { d.setHours(cfg.hour, cfg.minute, 0, 0); d.setDate(cfg.monthDay); };
  setToDay(c);
  if (c.getTime() < base.getTime()) { c.setDate(1); c.setMonth(c.getMonth() + 1); setToDay(c); }
  if (cfg.interval > 1 && Number(cfg.lastAt)) {
    const anchor = new Date(Number(cfg.lastAt));
    let months = (c.getFullYear() - anchor.getFullYear()) * 12 + (c.getMonth() - anchor.getMonth());
    if (months <= 0) months = cfg.interval;
    const rem = months % cfg.interval;
    if (rem) { c.setDate(1); c.setMonth(c.getMonth() + (cfg.interval - rem)); setToDay(c); }
  }
  return c.getTime();
}

/** 是否到了该触发的时候 */
function isDue(cfg, now) {
  const d = new Date(now);
  const last = Number(cfg.lastAt) || 0;
  if (cfg.every === 'hour') {
    if (d.getMinutes() !== cfg.minute) return false;
    return now - last >= Math.max(cfg.interval * 3600000 - 120000, 60000);
  }
  if (d.getHours() !== cfg.hour || d.getMinutes() !== cfg.minute) return false;
  if (cfg.every === 'day') {
    if (cfg.interval <= 1) return cfg.lastDay !== dayKeyOf(d);
    if (!last) return true;
    const a = new Date(last); a.setHours(0, 0, 0, 0);
    const b = new Date(d.getTime()); b.setHours(0, 0, 0, 0);
    const days = Math.round((b.getTime() - a.getTime()) / 86400000);
    return days >= cfg.interval;
  }
  if (cfg.every === 'week') {
    if (cfg.weekdays.indexOf(d.getDay()) < 0) return false;
    if (!last) return true;
    const a = new Date(last); a.setHours(0, 0, 0, 0);
    const b = new Date(d.getTime()); b.setHours(0, 0, 0, 0);
    const days = Math.round((b.getTime() - a.getTime()) / 86400000);
    return days >= cfg.interval * 7 - 1;
  }
  // month
  if (cfg.monthDay !== d.getDate() && !(cfg.monthDay > 28 && d.getDate() === new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())) return false;
  if (!last) return true;
  const a = new Date(last);
  const months = (d.getFullYear() - a.getFullYear()) * 12 + (d.getMonth() - a.getMonth());
  return months >= cfg.interval;
}

/** 人话描述下一次时间 */
function describeNext(cfg, nextMs) {
  if (!nextMs) return '';
  const d = new Date(nextMs);
  const W = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (cfg.every === 'hour') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (cfg.every === 'week') return `${W[d.getDay()]} ${t}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

function startDailyScan({ store, scanner, log, scraper }) {
  const L = log || logger.get();
  const s = store.data.settings;
  if (!s.autoScan || typeof s.autoScan !== 'object') s.autoScan = { enabled: true };
  const cfg = s.autoScan;   // 一直用引用，config 变了能马上生效

  let running = false;
  let nextBatchAt = 0;
  let batchRounds = 0;

  function view() { return normalize(cfg); }

  async function run(reason, force, batched) {
    if (running) return { started: false, message: '已有自动任务在执行' };
    running = true;
    try {
      if (cfg.enabled === false && !force) { L.info('scheduler', '定时自动扫描已停用'); return { started: false, message: '已停用' }; }
      if (!force && cfg.lastDate === todayKey()) return { started: false, message: '今日已执行' };
      if (scanner.state.running) { L.warn('scheduler', '已有扫描正在进行，跳过本次定时扫描'); return { started: false, message: '扫描进行中' }; }
      if (!s.paths || !s.paths.some(p => p.enabled !== false)) {
        L.info('scheduler', '尚未配置书库路径，跳过自动扫描');
        return { started: false, message: '未配置书库路径' };
      }
      cfg.lastDate = todayKey();
      cfg.lastAt = Date.now();
      cfg.lastReason = reason;
      cfg.lastDay = dayKeyOf(new Date(cfg.lastAt));
      cfg.batched = !!batched;
      batchRounds = 0;
      nextBatchAt = 0;
      const r = scanner.scan({ force: false, source: 'auto', batched: !!batched, limit: batched ? BATCH_LIMIT : 0 });
      cfg.lastResult = r && r.started ? '已触发' : (r && r.message) || '未触发';
      L.info('scheduler', `定时自动扫描（${reason}）：${cfg.lastResult}${batched ? ' · 分批模式' : ''}`);
      // 自动刮削：扫描之后由后台 worker 顺带补全（它本来就在空闲时跑，这里只是放开限制）
      const n = normalize(cfg);
      if (n.scrape && scraper && typeof scraper.startCatchUp === 'function' && r && r.started) {
        try { scraper.startCatchUp(2 * 3600 * 1000); L.info('scheduler', '自动扫描已触发，随后启动自动刮削'); } catch (_) {}
      }
      store.save();
      return { started: !!(r && r.started), message: cfg.lastResult };
    } catch (e) {
      L.error('scheduler', '自动扫描失败：' + e.message, e.stack);
      return { started: false, message: e.message };
    } finally {
      running = false;
    }
  }

  // 每 30 秒检查：是否到了设定周期；以及上一轮分批是否还有剩余
  const timer = setInterval(() => {
    const n = normalize(cfg);
    if (n.enabled !== false && !running && isDue(n, Date.now())) {
      Object.assign(cfg, { hour: n.hour, minute: n.minute, every: n.every, interval: n.interval });
      run('定时触发', false, true).catch(() => {});
    }

    if (cfg.enabled === false || running || scanner.state.running) return;
    if (!scanner.state.more) { nextBatchAt = 0; return; }
    if (batchRounds >= MAX_BATCH_ROUNDS) {
      L.warn('scheduler', `分批扫描已连续 ${batchRounds} 轮仍未完成，已暂停自动续扫（可在「扫描与刮削」页手动扫描）`);
      scanner.state.more = false;
      return;
    }
    if (!nextBatchAt) nextBatchAt = Date.now() + BATCH_GAP_MS;
    if (Date.now() >= nextBatchAt) {
      nextBatchAt = 0;
      batchRounds++;
      L.info('scheduler', `继续上一轮未完成的分批扫描（第 ${batchRounds} 轮）`);
      scanner.scan({ force: false, source: 'auto-batch', batched: true, limit: BATCH_LIMIT });
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  // 启动补扫：若上次是异常退出（崩溃），本次直接跳过，避免「重启→补扫→再崩」
  let catchup = null;
  if (cfg.enabled !== false && cfg.lastDate !== todayKey()) {
    const crash = L.readCrash();
    const crashedRecently = crash && (Date.now() - (crash.at || 0)) < 30 * 60 * 1000;
    if (crashedRecently) {
      L.warn('scheduler', '检测到上次为异常退出，本次启动跳过自动补扫以避免再次触发崩溃；可等待下一个周期，或在「扫描与刮削」页手动扫描');
    } else {
      catchup = setTimeout(() => run('启动补扫', false, true).catch(() => {}), CATCHUP_DELAY_MS);
      if (catchup.unref) catchup.unref();
    }
  }

  return {
    status() {
      const n = normalize(cfg);
      const nextAt = n.enabled === false ? 0 : computeNext(n, n.lastAt || Date.now());
      return Object.assign({}, n, {
        interval: n.interval, every: n.every, at: n.at,
        nextAt: nextAt,
        nextText: describeNext(n, nextAt),
        batchRounds, catchupPending: !!catchup, running
      });
    },
    /** 保存配置（管理员从「扫描与刮削」页提交） */
    configure(patch) {
      const cur = normalize(cfg);
      const p = patch && typeof patch === 'object' ? patch : {};
      const merged = Object.assign({}, cur, p);
      // interval 变化要重置基准，否则「每 N 天」会按旧的 lastAt 对齐到很久以后
      if (p.interval !== undefined || p.every !== undefined) merged.lastAt = Date.now();
      Object.assign(cfg, normalize(merged));
      // 显式写回 hour/minute/at，避免老数据只有 hour 字段
      const n = normalize(cfg);
      cfg.hour = n.hour; cfg.minute = n.minute; cfg.at = n.at;
      store.save();
      return this.status();
    },
    trigger(reason) { return run(reason || '手动触发', true, false); }
  };
}

function nextRunAt(rawCfg) {
  const n = normalize(rawCfg);
  return computeNext(n, n.lastAt || Date.now());
}

module.exports = { startDailyScan, todayKey, nextRunAt, normalize, computeNext, describeNext };
