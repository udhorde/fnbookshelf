// 飞牛书屋 服务入口：HTTPS + 静态前端 + API
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { execFile } = require('child_process');
const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const { Scanner } = require('./lib/scanner');
const { ScrapeWorker } = require('./lib/scrapeworker');
const { ConvertManager } = require('./lib/slideconvert');
const logger = require('./lib/logger');
const scheduler = require('./lib/scheduler');
const buildApi = require('./routes/api');

// ---- 环境 ----
const PORT = parseInt(process.env.PORT) || 8096;
const APP_ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
// 数据目录：优先环境变量；其次应用目录下的位置文件（避免写到系统盘）
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const pointers = [
    path.join(__dirname, '..', '.datadir'),
    path.join(__dirname, '..', '..', 'var', '.datadir')
  ];
  for (const p of pointers) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v && path.isAbsolute(v)) return v;
    } catch (_) {}
  }
  return DEFAULT_DATA_DIR;
}
const DATA_DIR = resolveDataDir();
const WWW_DIR = path.join(__dirname, '..', 'www');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

const store = new Store(DATA_DIR);
const auth = new Auth(store, DATA_DIR);
const scanner = new Scanner(store);

// ---- 日志 / 崩溃取证 ----
const log = logger.init(DATA_DIR);
log.version = '1.9.6';
log.setContext('启动');
log.detectAbnormalExit();   // 上次是被 OOM / SIGKILL / 断电杀掉的？写进崩溃记录
log.install(store);         // uncaughtException / unhandledRejection / 事件循环阻塞监控
log.info('server', `进程启动 PID=${process.pid}，端口 ${PORT}，Node ${process.version}`);

// 后台刮削队列：与扫描解耦，只在空闲时逐本补全
const scraper = new ScrapeWorker({ store, scanner, log });

// 后台 PPT→PDF 转换队列（服务端逐页取图/合成，产物作为新版本入库）
const converter = new ConvertManager({ store, log });

// 运行时能力（延后赋值，供 API 路由调用）
const runtime = { schedule: null, scraper, converter };

// 首个管理员（来自安装向导）
if (ADMIN_EMAIL && !store.users.some(u => u.role === 'admin')) {
  const u = store.upsertUser(ADMIN_EMAIL, 'admin');
  u.status = 'active';
  console.log(`[init] 已创建管理员: ${ADMIN_EMAIL}`);
}
if (!store.users.some(u => u.role === 'admin')) {
  console.warn('[init] 警告：尚无管理员，首个通过邮箱验证的用户将自动成为管理员');
}

// 首次启动引导：若 SMTP 未配置，生成离线解锁码（管理员在 NAS 文件管理中读取，一次性）
(function ensureBootstrap() {
  const s = store.data.settings;
  const bootFile = path.join(store.dataDir, 'bootstrap.txt');
  if (s.setupComplete) { try { fs.unlinkSync(bootFile); } catch (_) {} return; }
  if (s.smtp && s.smtp.host && s.smtp.user) { return; } // SMTP 已配置，无需兜底
  try {
    if (!fs.existsSync(bootFile)) {
      const code = require('crypto').randomBytes(6).toString('hex').toUpperCase();
      fs.writeFileSync(bootFile,
        `${code}\n` +
        `这是飞牛书屋的离线解锁码（一次性）。\n` +
        `管理员首次登录时，在登录页输入管理员邮箱后，将此码填入验证码框即可登录。\n` +
        `登录成功后本文件自动删除，首次配置引导将永久锁定。\n`);
      console.log(`[setup] 已生成离线解锁码: ${bootFile}`);
      console.log(`[setup] 提示：配置 SMTP 后可改用邮箱验证码登录，引导页也可直接配置 SMTP`);
    }
  } catch (e) { console.error('[setup] 生成离线解锁码失败:', e.message); }
})();

// ---- HTTPS 证书 ----
function ensureSelfSignedCert() {
  const cert = path.join(store.certsDir, 'server.crt');
  const key = path.join(store.certsDir, 'server.key');
  if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  const openssl = process.platform === 'win32' ? 'openssl' : '/usr/bin/openssl';
  try {
    execFileSyncSafe(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '3650',
      '-subj', '/CN=fnbookshelf',
      '-addext', 'subjectAltName=DNS:fnbookshelf,DNS:localhost,IP:0.0.0.0']);
    return { cert, key };
  } catch (e) {
    console.error('[https] 生成自签名证书失败:', e.message);
    return null;
  }
}
function execFileSyncSafe(cmd, args) {
  const { execFileSync } = require('child_process');
  execFileSync(cmd, args, { stdio: 'ignore' });
}

// ---- Express ----
const app = express();
app.disable('x-powered-by');
// 只信任直连来源地址：不采信可伪造的 X-Forwarded-For（限流按 socket 地址计数）
app.set('trust proxy', false);

// ---- 1.9.0：二级路径访问（/fnbookshelf） ----
// 用户希望除了「直接访问端口」外，还能在飞牛的 5667 页面上以 /fnbookshelf 这种方式进来。
// 两种反向代理写法都要能跑：
//   ① nginx 把 /fnbookshelf/ 原样转给本服务（proxy_pass 不带尾斜杠）→ 这里剥掉前缀
//   ② nginx 剥掉前缀再转（proxy_pass http://127.0.0.1:8096/）→ 到这里本来就是 /css/...
// 剥前缀是幂等的，两种都不会出错。前端也按 location.pathname 自动算前缀，
// 所以 <img src>、fetch、下载链接在两种模式下都指向正确位置。
function normalizeBase(p) {
  const s = String(p || '').trim();
  if (!s || s === '/') return '';
  return '/' + s.replace(/^\/+/, '').replace(/\/+$/, '');
}
const BASE_PATH = normalizeBase(
  process.env.BASE_PATH ||
  ((store.data.settings.app && store.data.settings.app.basePath) || '')
);
app.use((req, res, next) => {
  if (!BASE_PATH) return next();
  const u = req.url || '';
  // 二级路径访问时，没带结尾斜杠要先跳一下：index.html 里的 css/js 都是相对路径，
  // 停在 /fnbookshelf 会按 /css/... 去取，资源全 404（页面白屏）。
  if (u === BASE_PATH || u === BASE_PATH + '?') {
    const q = u.length > BASE_PATH.length ? u.slice(BASE_PATH.length) : '';
    return res.redirect(302, BASE_PATH + '/' + q);
  }
  if (u.startsWith(BASE_PATH + '/') || u.startsWith(BASE_PATH + '?')) {
    const rest = u.slice(BASE_PATH.length);
    req.url = rest.startsWith('/') ? rest : '/' + rest;
  }
  next();
});
if (BASE_PATH) console.log(`[server] 额外支持二级路径访问：${BASE_PATH}/`);

// 二级路径兜底：前端若用绝对 /api 路径（少数字符串拼接点），请求仍会带上前缀，
// 这里再剥一次；剥前缀是幂等的，重复执行也不会出错。
app.use((req, res, next) => {
  if (!BASE_PATH) return next();
  const u = req.url || '';
  if (u.startsWith(BASE_PATH + '/')) {
    const rest = u.slice(BASE_PATH.length);
    req.url = rest.startsWith('/') ? rest : '/' + rest;
  }
  next();
});

// ---- 1.7.0 安全响应头 ----
// CSP 说明：
//   - script-src 只允许同源脚本（前端没有内联 <script>，因此不需要 'unsafe-inline'）
//   - style-src 允许 'unsafe-inline'：界面大量使用 style 属性（el(..., {style: ...})）
//   - img/media/font 放开 data: 与 blob:：书内图片、TTS 音频、PPT 内嵌图都是这两种协议
//   - frame-ancestors 精确放行「同一主机的任意端口」，以兼容飞牛桌面的 iframe，
//     另可用 settings.security.frameAncestors 追加其它来源（写 'none' 则完全禁止被嵌入）
function frameAncestorsFor(req) {
  const sec = store.data.settings.security || {};
  const extra = String(sec.frameAncestors || '').trim();
  if (extra.split(/\s+/).includes("'none'")) return "'none'";
  const list = ["'self'"];
  const raw = String(req.headers.host || '');
  const m = raw.match(/^([a-z0-9.\-]+|\[[0-9a-f:.]+\])(?::\d+)?$/i);
  if (m) {
    const host = m[1];
    // 飞牛桌面通常是同一台 NAS 的另一个端口，端口不同即不同源，只能用通配端口放行
    list.push(`https://${host}:*`, `http://${host}:*`);
  }
  if (extra) list.push(extra);
  return list.join(' ');
}

// 1.7.1：/api/* 默认不允许缓存（/me、/site、/books 等含用户私有数据，
// 局域网里的透明代理或共用浏览器缓存后可能被别人读到）。
// 例外是下面这些「浏览器自己发起的静态资源类」接口：它们自带 Cache-Control private，
// 逐页图片与封面缓存下来才能翻页流畅。
const CACHEABLE_API = new RegExp('^/api/(?:' +
  'cover/[^/]+$' +
  '|slidesmedia/' +
  '|media/' +
  '|books/[^/]+/(?:file|slides|slidepdf|cbz/\\d+|page-image|neighbor-image)$' +
  ')');

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && !CACHEABLE_API.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  const ancestors = frameAncestorsFor(req);
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// PPT 逐页截图与「书内某一页做封面」的 base64 体积较大，单独放开这些路由的解析上限。
// 关键：这些路由必须跳过全局 jsonSmall，否则请求体会被消费两次，路由级 parser 永远等不到流结束（请求挂起）。
const bigJsonPaths = /^\/api\/(?:books\/[^/]+\/(?:slides\/pdf|cover)|app\/upload|collections\/[^/]+\/cover)$/;
const jsonSmall = express.json({ limit: '4mb' });
// AI 接口在任何 body 解析之前拦截超大请求：整本书正文不可能只有几十 KB
app.use('/api/ai', (req, res, next) => {
  const len = Number(req.headers['content-length'] || 0);
  if (len > 64 * 1024) {
    log.warn('ai', `拦截超大 AI 请求 ${req.path}（${len} 字节）：禁止上传整本书内容`);
    return res.status(413).json({ error: '请求内容过大：AI 功能只接收当前页片段，禁止上传整本书内容' });
  }
  next();
});
app.use((req, res, next) => {
  if (req.method === 'POST' && bigJsonPaths.test(req.path)) return next();
  return jsonSmall(req, res, next);
});
// 请求日志：只记 5xx 与慢请求，避免日志膨胀
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - t0;
    if (res.statusCode >= 500) log.error('http', `${req.method} ${req.path} → ${res.statusCode}（${dur}ms）`);
    else if (dur > 3000) log.warn('http', `慢请求 ${req.method} ${req.path} → ${res.statusCode}（${dur}ms）`);
  });
  next();
});
app.use(auth.middleware());
app.use('/api', buildApi({ store, auth, scanner, log, runtime }));

// 静态资源 + SPA（HTML 不缓存，保证升级后浏览器立即拿到新前端）
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path.endsWith('.html'))) {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});
app.use(express.static(WWW_DIR, { index: 'index.html', maxAge: '1d' }));

// ---- 404：真实状态码，不再让任意路径都返回 200 + 首页 ----
// 前端用 hash 路由（#/book/xxx），不需要服务端兜底到 index.html；
// 只有「GET + 明确接受 HTML + 路径不含扩展名」才给一张友好的 404 页面，其余一律纯文本 404。
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});
app.use((req, res) => {
  const accept = String(req.headers.accept || '');
  if (req.method === 'GET' && accept.includes('text/html') && !path.extname(req.path)) {
    return res.status(404).type('html').send(
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>404 页面不存在</title><style>' +
      'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'font:15px/1.8 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
      'background:#f5f6f8;color:#1f2937}div{text-align:center;padding:24px}' +
      'b{display:block;font-size:56px;letter-spacing:2px;color:#9ca3af;margin-bottom:4px}' +
      'a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}' +
      '</style></head><body><div><b>404</b><p>这个地址没有对应的页面。</p>' +
      '<p><a href="' + (BASE_PATH || '') + '/">返回飞牛书屋</a></p></div></body></html>');
  }
  res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
});

// ---- 错误处理：统一 JSON / 纯文本，5xx 不回显内部信息与堆栈 ----
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const isApi = req.path.startsWith('/api');
  if (status >= 500) {
    console.error('[error]', err.message);
    log.error('http', `请求异常 ${req.method} ${req.path}: ${err.message}`, err.stack);
  }
  if (res.headersSent) return next(err);
  let msg = err.message || '请求有误';
  if (err.type === 'entity.too.large') msg = '请求内容过大';
  else if (err.type === 'entity.parse.failed') msg = '请求体不是合法的 JSON';
  if (status >= 500) msg = '服务器内部错误';   // 生产环境不把内部错误细节吐给前端
  if (isApi || (req.headers.accept || '').includes('application/json')) {
    return res.status(status).json({ error: msg });
  }
  res.status(status).type('text/plain; charset=utf-8').send(msg);
});

// ---- 启动 ----
const httpsCfg = store.data.settings.https || { mode: 'self' };
let server;
if (httpsCfg.mode === 'off') {
  server = http.createServer(app);
  console.log('[server] HTTPS 已关闭，使用 HTTP 模式');
} else {
  let opts = null;
  if (httpsCfg.mode === 'custom' && httpsCfg.cert && httpsCfg.key) {
    try { opts = { cert: httpsCfg.cert, key: httpsCfg.key }; console.log('[server] 使用自定义证书'); } catch (e) { console.error('[server] 自定义证书无效:', e.message); }
  }
  if (!opts) {
    const self = ensureSelfSignedCert();
    if (self) opts = { cert: fs.readFileSync(self.cert), key: fs.readFileSync(self.key) };
  }
  if (opts) {
    server = https.createServer(opts, app);
    console.log('[server] HTTPS 已启用（自签名证书可在首次访问时信任，或在设置中上传正式证书）');
  } else {
    server = http.createServer(app);
    console.log('[server] openssl 不可用，降级为 HTTP。建议安装 openssl 或在设置中上传证书');
  }
}

// 1.8.2.1：端口被占用必须给出可读的原因。
// 以前 server 没有 error 监听，EADDRINUSE 会走 uncaughtException，既记成「JavaScript 异常崩溃」
// （误导排查方向），又让 cmd/main 只能拿到一句「启动失败」。
// 1.8.2.2：光报错不够——升级时旧进程卡在退出流程里（停在 writeSync / exit 钩子），
// 它的监听套接字还挂着 8096，新进程起不来，用户只能重启 NAS。这里改为先自愈：
// 扫 /proc 找到本应用残留的 node 进程（命令行含 fnbookshelf 且是 server/app.js），
// SIGKILL 清掉后再重试监听。见 lib/procclean.js。
const { killStaleAppProcesses, findPortHolder } = require('./lib/procclean');

let listenAttempt = 0;
let staleKillTried = 0;   // 本次启动尝试清理过几个残留进程（用于把提示写准确）
server.on('error', e => {
  const code = (e && e.code) || '';
  // 端口被本应用残留进程占着 → 清掉它再试一次（最多 2 次）
  if (code === 'EADDRINUSE' && listenAttempt <= 2) {
    const killed = killStaleAppProcesses();
    if (killed.length) {
      staleKillTried += killed.length;
      console.warn(`[server] 端口 ${PORT} 被本应用残留进程占用（PID ${killed.join(',')}），已强制清理，稍后重试监听`);
      try { log.warn('server', `端口 ${PORT} 被本应用残留进程占用（PID ${killed.join(',')}），已强制清理并重试监听`); } catch (_) {}
      setTimeout(() => bindListen(), 1200);
      return;
    }
  }
  let msg;
  if (code === 'EADDRINUSE') {
    // 1.9.6：点名占用者，否则用户只知道「被占」却不知道去停哪个服务
    let holders = [];
    try { holders = findPortHolder(PORT); } catch (_) {}
    const who = holders.length
      ? holders.map(h => `${h.name}（PID ${h.pid}）`).join('、')
      : '无法识别占用进程（可能权限不足）';
    msg = staleKillTried
      ? `端口 ${PORT} 仍被占用（占用者：${who}）：已清理过 ${staleKillTried} 个残留进程但端口仍未释放，`
        + `说明那个进程卡在磁盘 IO 里（无法被信号终止）。请重启一次 NAS 释放端口，之后不会再出现。`
      : `端口 ${PORT} 已被占用，占用者：${who}。`
        + `请结束该进程，或在飞牛「应用中心 → 飞牛书屋 → 设置」里换一个空闲端口（改完会自动重启）。`
        + `若已在应用设置里改过端口、提示的仍是旧端口号，说明新端口没有写入配置文件，请在应用设置里重新保存一次。`;
  } else if (code === 'EACCES') {
    msg = `端口 ${PORT} 需要更高权限才能监听（1024 以下端口普通用户不可用），请在应用设置里换成 1024 以上的端口。`;
  } else {
    msg = `服务启动失败（${code || '未知错误'}）：${(e && e.message) || e}`;
  }
  console.error('[server] ' + msg);
  try { log.error('server', msg, e && e.stack); } catch (_) {}
  try { log.markNormalExit('启动失败：' + (code || 'error')); } catch (_) {}
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'startup-error.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
  // 退出码 2：让 cmd/main 明确知道是「端口/权限」问题，而不是崩溃
  process.exit(2);
});

function onListening() {
  listenAttempt = 0;
  console.log(`[server] 飞牛书屋已启动: 端口 ${PORT}`);
  console.log(`[server] 数据目录: ${DATA_DIR}`);
  log.setContext('空闲');
  const rssMB = Math.round(process.memoryUsage().rss / 1048576);
  let dataMB = 0, dataDesc = '待新建';
  try { dataMB = Math.round(fs.statSync(store.file).size / 1048576 * 10) / 10; dataDesc = dataMB + 'MB'; } catch (_) {}
  log.info('server', `服务已监听 0.0.0.0:${PORT}，日志目录 ${log.dir}（保留 ${logger.KEEP_DAYS} 天，仅本机保存不发送邮件）`);
  // 大书库排查用：一眼看出「多少本书 / 数据文件多大 / 刚起来占多少内存」
  log.info('server', `书库 ${store.books.length} 本，data.json ${dataDesc}，启动内存 RSS ${rssMB}MB`);
  if (rssMB > 320) {
    log.warn('memory', `启动内存已达 ${rssMB}MB，接近系统 OOM 保护线；建议在「系统日志」里确认是否有大库扫描在跑，或分批整理书库`);
  }
  runtime.schedule = scheduler.startDailyScan({ store, scanner, log, scraper });
  scraper.start();   // 后台刮削：扫描期间自动让路，空闲时逐本补全
}

function bindListen() {
  listenAttempt++;
  try { server.listen(PORT, '0.0.0.0', onListening); }
  catch (e) { server.emit('error', e); }
}

// 系统日志仅保存在本机，不通过邮件外发（1.4.1 起移除重启报告邮件）。
bindListen();

// 设置热更新 HTTPS 证书（管理员上传后无需重启进程）
let httpsRestartHandler = null;

// ---- 1.8.2.2 退出流程 ----
// 以前：SIGTERM → 同步全量写盘 → process.exit → 'exit' 钩子里又同步写一遍。
// 3 万本的库 data.json 有 50MB 以上，慢盘上单次同步写可能要几十秒；一旦卡在 writeSync，
// 进程就停在退出流程里：监听套接字没关（ss 仍显示 LISTEN），却再也不会 accept，
// 外面看到的现象正是「应用中心显示运行中，网页一直转圈」。
// 现在：先关闭监听（不再接新连接），再异步分块落盘，最多等 3 秒，到点强制退出。
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${sig}，正在停止服务`);
  try { log.info('process', `收到 ${sig}：停止监听 → 异步落盘（最多等 3 秒）→ 退出`); } catch (_) {}
  try { if (server) server.close(); } catch (_) {}
  try { scraper.stop(); } catch (_) {}
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { log.markNormalExit(sig); } catch (_) {}
    process.exit(0);
  };
  const hard = setTimeout(finish, 3000);
  if (hard.unref) hard.unref();
  Promise.resolve()
    .then(() => store.flushNow())
    .then(() => { try { log.flush(); } catch (_) {} })
    .catch(() => {})
    .finally(() => { clearTimeout(hard); finish(); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 'exit' 钩子只做内存里的事：这里再同步写 50MB，会把进程永远拖在退出流程里。
// 真要兜底也必须有预算，写不完就放弃（旧数据文件保持完整）。
process.on('exit', () => {
  try { log.flush(); } catch (_) {}
  try { if (store._dirty) store.flushSync(1500); } catch (_) {}
});

// 管理设置变更时的 HTTPS 重载（简单方式：收到 SIGHUP 重建 server）
process.on('SIGHUP', () => {
  const old = server;
  const cfg = store.data.settings.https;
  try {
    let opts = null;
    if (cfg.mode === 'custom' && cfg.cert && cfg.key) opts = { cert: cfg.cert, key: cfg.key };
    else if (cfg.mode !== 'off') { const self = ensureSelfSignedCert(); if (self) opts = { cert: fs.readFileSync(self.cert), key: fs.readFileSync(self.key) }; }
    if (cfg.mode === 'off') { server = http.createServer(app); }
    else if (opts) server = https.createServer(opts, app);
    else return;
    server.listen(PORT, '0.0.0.0');
    old.close(() => console.log('[server] HTTPS 配置已热更新'));
    console.log('[server] 新服务已监听');
  } catch (e) { console.error('[server] HTTPS 热更新失败:', e.message); }
});
