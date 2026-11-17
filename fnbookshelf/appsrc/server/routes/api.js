// API 路由
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const zipread = require('../lib/zipread');
const { createGate } = require('../lib/limits');
const { sendCode, sendTest } = require('../lib/mailer');
const meta = require('../lib/meta');
const scrape = require('../lib/scrape');
const taxonomy = require('../lib/taxonomy');
const sample = require('../lib/sample');
const tocLib = require('../lib/toc');
const textdoc = require('../lib/textdoc');
const pptx = require('../lib/pptx');
const pptbin = require('../lib/pptbin');
const pdfwrite = require('../lib/pdfwrite');
const { registerPdfVersion, findConvertedPdf } = require('../lib/slideconvert');
const coverpick = require('../lib/coverpick');
const ttsLib = require('../lib/tts');
const ai = require('../lib/ai');
const booksearch = require('../lib/booksearch');
const { RateLimiter, clientIp, tooMany } = require('../lib/ratelimit');
const { TRASH_KEEP_DAYS } = require('../lib/store');
const scheduler = require('../lib/scheduler');

module.exports = function buildApi(ctx) {
  const { store, auth, scanner, runtime } = ctx;
  const log = ctx.log || require('../lib/logger').get();
  const r = express.Router();
  // 重活并发闸门：最多同时 2 个（压缩包逐页解析 / PPT 渲染 / 图片 PDF 合成）
  const heavy = createGate(2);

  const wrap = fn => (req, res) => {
    Promise.resolve(fn(req, res)).catch(e => {
      log.error('api', `${req.method} ${req.path}: ${e.message}`, e.stack);
      res.status(e.status || 500).json({ error: e.message || '服务器错误', candidates: e.candidates });
    });
  };

  // ============ 首次启动引导 ============
  const setupRequired = () => !store.data.settings.setupComplete;
  const bootstrapFile = path.join(store.dataDir, 'bootstrap.txt');

  function readBootstrapCode() {
    try { return fs.readFileSync(bootstrapFile, 'utf8').trim().split(/\s+/)[0]; } catch (_) { return ''; }
  }
  function clearBootstrap() { try { fs.unlinkSync(bootstrapFile); } catch (_) {} }
  function completeSetup() {
    store.data.settings.setupComplete = true;
    clearBootstrap();
    // 1.8.2.2：不要同步全量写——大库一次 50MB+，同步写会把事件循环堵死几十秒
    store.save(); store.flushNow().catch(() => {});
  }

  r.get('/setup', (req, res) => {
    if (!setupRequired()) return res.json({ setupRequired: false });
    const s = store.data.settings;
    res.json({
      setupRequired: true,
      smtpConfigured: !!(s.smtp && s.smtp.host && s.smtp.user),
      adminEmail: (store.users.find(u => u.role === 'admin') || {}).email || '',
      hasUsers: store.users.length > 0,
      bootstrapHint: bootstrapFile
    });
  });

  r.post('/setup/smtp', wrap(async (req, res) => {
    if (!setupRequired()) return res.status(403).json({ error: '首次配置已完成，请登录后在管理后台修改' });
    const b = req.body || {};
    const s = store.data.settings.smtp;
    if (b.host !== undefined) s.host = String(b.host).trim();
    if (b.port !== undefined) s.port = Number(b.port) || 465;
    if (b.secure !== undefined) s.secure = !!b.secure;
    if (b.user !== undefined) s.user = String(b.user).trim();
    if (b.pass && b.pass !== '******') s.pass = String(b.pass);
    if (b.from !== undefined) s.from = String(b.from).trim();
    store.save(); store.flushNow().catch(() => {});
    res.json({ ok: true });
  }));

  r.post('/setup/smtp-test', wrap(async (req, res) => {
    if (!setupRequired()) return res.status(403).json({ error: '首次配置已完成' });
    const to = String(req.body.to || '').trim();
    if (!auth.isEmailValid(to)) return res.status(400).json({ error: '请先填写收件邮箱' });
    await sendTest(store.data.settings.smtp, to, store.data.settings.siteName);
    res.json({ ok: true });
  }));

  // ============ 认证 ============
  // 1.7.0：验证码 / 注册 / 登录校验共用一套进程内限流（按真实来源地址，不采信可伪造的 XFF）
  const rl = new RateLimiter();
  rl.start();
  const SEC = {
    codePerIp: 10,           // 每 IP 每小时最多请求 10 次验证码
    codeGlobal: 120,         // 全站每小时最多发出 120 封验证码邮件
    codeRecipients: 30,      // 全站每小时最多出现 30 个不同收件人（超过即熔断，防垃圾邮件放大）
    verifyPerIp: 40,         // 每 IP 每 15 分钟最多校验 40 次
    verifyWindow: 15 * 60 * 1000,
    bootstrapPerIp: 8        // 离线解锁码每 IP 每小时最多试 8 次
  };

  r.post('/auth/code', wrap(async (req, res) => {
    const raw = req.body && req.body.email;
    // 强类型校验：数组 / 对象一律拒绝，不做隐式 String() 强转
    if (typeof raw !== 'string') return res.status(400).json({ error: '邮箱格式不正确' });
    const email = raw.trim().toLowerCase();
    if (!auth.isEmailValid(email)) return res.status(400).json({ error: '邮箱格式不正确' });

    const ip = clientIp(req);
    let g = rl.hit('code:ip:' + ip, SEC.codePerIp, 3600 * 1000);
    if (!g.ok) return tooMany(res, g.retryAfter, '获取验证码过于频繁，请稍后再试');
    g = rl.hit('code:all', SEC.codeGlobal, 3600 * 1000);
    if (!g.ok) {
      log.warn('auth', `全站发信量达上限（${SEC.codeGlobal}/小时），已临时拒绝新的发信请求`);
      return tooMany(res, g.retryAfter, '全站发信量已达上限，请稍后再试');
    }
    const rc = rl.distinct('code:rcpt', email, SEC.codeRecipients, 3600 * 1000);
    if (!rc.ok) {
      log.warn('auth', `发信熔断：1 小时内不同收件人已达 ${rc.size} 个（来源 ${ip}）`);
      return tooMany(res, 600, '全站发信异常，已临时停用发信，请联系管理员');
    }

    const settings = store.data.settings;
    const existing = store.findUserByEmail(email);
    if (!existing && settings.registerMode === 'closed') return res.status(403).json({ error: '当前已关闭新用户注册' });

    let code;
    try { code = auth.issueCode(email); }
    catch (e) { return tooMany(res, e.retryAfter || 60, e.message); }

    try {
      await sendCode(settings.smtp, email, code, settings.siteName);
    } catch (e) {
      try { auth.codes.delete(email); } catch (_) {}
      if (setupRequired()) {
        const e2 = new Error('邮件发送失败（SMTP 未配置或配置错误）。若无法收发邮件，可在 NAS 上打开应用数据目录中的 bootstrap.txt 获取离线解锁码完成首次登录。');
        e2.status = e.status || 503;
        throw e2;
      }
      throw e;
    }
    // 一次性生成、无差别响应：不在 HTTP 层暴露「该邮箱是否已注册」，避免账号枚举
    res.json({ ok: true });
  }));

  r.post('/auth/verify', wrap(async (req, res) => {
    const rawEmail = req.body && req.body.email;
    const rawCode = req.body && req.body.code;
    if (typeof rawEmail !== 'string') return res.status(400).json({ error: '邮箱格式不正确' });
    if (typeof rawCode !== 'string' && typeof rawCode !== 'number') return res.status(400).json({ error: '请输入验证码' });
    const email = rawEmail.trim().toLowerCase();
    const code = String(rawCode).trim().slice(0, 64);
    if (!auth.isEmailValid(email)) return res.status(400).json({ error: '邮箱格式不正确' });

    const ip = clientIp(req);
    const g = rl.hit('verify:ip:' + ip, SEC.verifyPerIp, SEC.verifyWindow);
    if (!g.ok) return tooMany(res, g.retryAfter, '尝试过于频繁，请稍后再试');

    const settings = store.data.settings;
    const existing = store.findUserByEmail(email);

    // ① 首次启动的离线解锁码（仅 setupRequired 期间有效，且按 IP 限次防爆破）
    if (setupRequired()) {
      const boot = readBootstrapCode();
      if (boot && code === boot) {
        const bg = rl.hit('boot:ip:' + ip, SEC.bootstrapPerIp, 3600 * 1000);
        if (!bg.ok) return tooMany(res, bg.retryAfter, '尝试过于频繁，请稍后再试');
        let user = existing;
        if (!user) user = store.upsertUser(email, 'admin');
        if (!store.users.some(u => u.role === 'admin')) user.role = 'admin';
        if (user.status !== 'active') { user.status = 'active'; user.tokenVer = Number(user.tokenVer || 0) + 1; }
        store.save();
        clearBootstrap();
        completeSetup();
        store.logAudit(req, 'auth.bootstrap', email);
        console.log(`[setup] 管理员 ${user.email} 使用离线解锁码完成首次配置`);
        return res.json({ ok: true, token: auth.signToken(user), user: publicUser(user) });
      }
    }

    // ② 验证码是登录/注册的**前置硬条件**：没请求过、已过期、输错，一律拒绝，
    //    绝不落入「新建账号」分支（1.7.0 修复：此前任意邮箱+随机码即可注册）。
    if (!auth.hasChallenge(email)) {
      return res.status(400).json({ error: '请先获取验证码（有效期 10 分钟）' });
    }
    try {
      auth.checkCode(email, code);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    let user = existing;
    if (!user) {
      if (settings.registerMode === 'closed') return res.status(403).json({ error: '当前已关闭新用户注册' });
      const approve = settings.registerMode === 'approve';
      user = store.upsertUser(email, 'user');
      if (approve) user.status = 'pending';
      store.save();
      store.logAudit(req, 'user.register', email, { mode: settings.registerMode, status: user.status });
    }
    if (user.status === 'disabled') return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
    if (user.status === 'pending') {
      // 注册成功但待审核：语义是「成功」，状态码必须是 200（此前误用 403）
      return res.json({ ok: true, pending: true, message: '注册成功！账号待管理员审核通过后即可登录。' });
    }
    if (!store.users.some(u => u.role === 'admin')) { user.role = 'admin'; store.save(); }
    if (user.role === 'admin' && setupRequired()) {
      completeSetup();
      console.log(`[setup] 管理员 ${user.email} 首次登录，首次配置引导已锁定`);
    }
    user.lastLoginAt = Date.now();
    store.save();
    res.json({ ok: true, token: auth.signToken(user), user: publicUser(user), ttlHours: Math.round(auth.ttlMs / 3600000) });
  }));

  // 退出登录：吊销当前令牌（写入短期黑名单）
  r.post('/auth/logout', auth.requireAuth, (req, res) => {
    auth.revoke(req.authToken);
    res.json({ ok: true });
  });

  // 退出所有设备：自增会话版本号，全部已签发令牌立即失效
  r.post('/auth/logout-all', auth.requireAuth, (req, res) => {
    const ver = auth.revokeAllFor(req.user);
    store.logAudit(req, 'auth.logout-all', req.user.email, { ver });
    res.json({ ok: true, tokenVer: ver });
  });

  r.get('/me', auth.requireAuth, (req, res) => res.json({
    user: publicUser(req.user),
    canEdit: auth.isEditor(req.user),
    tokenTtlHours: Math.round(auth.ttlMs / 3600000)
  }));

  function publicUser(u) { return { id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt }; }

  // ============ 公共配置 ============
  // 未登录只给渲染登录页必需的两个字段；其余（抓取源、AI/TTS 开关、HTTPS 模式、阅读偏好）
  // 只在已登录时返回，避免给未授权访客画功能地图（1.7.0）。
  r.get('/site', (req, res) => {
    const s = store.data.settings;
    const base = { siteName: s.siteName, registerMode: s.registerMode || 'auto' };
    if (!req.user) return res.json(base);
    res.json(Object.assign(base, {
      canEdit: auth.isEditor(req.user),
      scrape: { enabled: !!s.scrape.enabled, provider: s.scrape.provider, providers: s.scrape.providers },
      ai: { enabled: !!(s.ai && s.ai.enabled) },
      tts: { enabled: !!(s.tts && s.tts.enabled !== false) },
      https: { mode: s.https.mode },
      // 1.9.0：侧栏左下角的「下载 APP」入口用它决定是否显示
      app: { phone: (s.app && s.app.phone) || null, tv: (s.app && s.app.tv) || null },
      reader: s.reader || {}
    }));
  });

  // ============ 1.9.0：客户端安装包（页面下载入口 + APP 自动更新） ============
  // 管理员在后台把「手机 / 平板」与「TV」两个 APK 传上来，存到数据目录 app/ 下；
  // 网页左下角提供下载入口，APP 启动时拿 /api/app/info 比对 versionCode 决定是否提示更新。
  const appApkDir = path.join(store.dataDir, 'app');
  function ensureAppDir() { try { fs.mkdirSync(appApkDir, { recursive: true }); } catch (_) {} }
  const APK_KINDS = { phone: '手机 / 平板版', tv: 'TV 版' };

  function appInfo() {
    const a = store.data.settings.app || {};
    const out = {};
    for (const k of Object.keys(APK_KINDS)) {
      const m = a[k];
      const file = m && m.file ? path.join(appApkDir, m.file) : '';
      out[k] = m && file && fs.existsSync(file)
        ? { kind: k, label: APK_KINDS[k], version: m.ver || '', code: Number(m.code) || 0, size: m.size || 0, at: m.at || 0, md5: m.md5 || '' }
        : null;
    }
    return out;
  }

  r.get('/app/info', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const a = store.data.settings.app || {};
    res.json({ ok: true, items: appInfo(), basePath: a.basePath || '/fnbookshelf' });
  });

  r.get('/app/download/:kind', (req, res) => {
    const kind = String(req.params.kind || '');
    if (!APK_KINDS[kind]) return res.status(404).json({ error: '未知的安装包类型' });
    const m = (store.data.settings.app || {})[kind];
    if (!m || !m.file) return res.status(404).json({ error: '管理员还没有上传安装包' });
    const f = path.join(appApkDir, m.file);
    if (!fs.existsSync(f)) return res.status(404).json({ error: '安装包文件不存在，请管理员重新上传' });
    const name = `fnbookshelf-${kind}-${m.ver || 'latest'}.apk`;
    log.info('http', `下载客户端安装包 ${name}`);
    sendRangeFile(req, res, f, name, 'application/vnd.android.package-archive');
  });

  r.post('/app/upload', ...adminOnly(), express.json({ limit: '96mb' }), (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!APK_KINDS[kind]) return res.status(400).json({ error: '请选择安装包类型（phone / tv）' });
    const m = String(b.data || '').match(/^data:application\/[^;]*;base64,(.+)$/) || String(b.data || '').match(/^([A-Za-z0-9+/=\s]+)$/);
    if (!m) return res.status(400).json({ error: '安装包内容不正确' });
    let buf;
    try { buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64'); }
    catch (e) { return res.status(400).json({ error: '安装包解码失败' }); }
    if (buf.length < 8192 || buf.slice(0, 2).toString('latin1') !== 'PK') {
      return res.status(400).json({ error: '这不是一个 APK 文件（应为 zip 结构）' });
    }
    if (buf.length > 120 * 1024 * 1024) return res.status(413).json({ error: '安装包太大（上限 120MB）' });
    const ver = String(b.version || '').trim().replace(/[^\d.]/g, '').slice(0, 20) || '0.0.0';
    ensureAppDir();
    const file = `${kind}-${Date.now()}.apk`;
    try { fs.writeFileSync(path.join(appApkDir, file), buf); }
    catch (e) { return res.status(500).json({ error: '保存失败：' + e.message }); }
    const old = (store.data.settings.app || {})[kind];
    // 覆盖前把旧文件删掉，避免数据目录里堆一摞 APK
    if (old && old.file && old.file !== file) {
      try { fs.unlinkSync(path.join(appApkDir, old.file)); } catch (_) {}
    }
    store.data.settings.app[kind] = {
      ver, code: Number(b.code) || 0, size: buf.length, at: Date.now(), file,
      name: String(b.name || '').slice(0, 120),
      md5: crypto.createHash('md5').update(buf).digest('hex')
    };
    store.save(); store.flushNow().catch(() => {});
    store.logAudit(req, 'app.upload', kind, { ver, size: buf.length });
    res.json({ ok: true, items: appInfo() });
  });

  r.delete('/app/:kind', ...adminOnly(), (req, res) => {
    const kind = String(req.params.kind || '');
    if (!APK_KINDS[kind]) return res.status(404).json({ error: '未知的安装包类型' });
    const m = (store.data.settings.app || {})[kind];
    if (m && m.file) { try { fs.unlinkSync(path.join(appApkDir, m.file)); } catch (_) {} }
    store.data.settings.app[kind] = null;
    store.save();
    store.logAudit(req, 'app.delete', kind);
    res.json({ ok: true, items: appInfo() });
  });

  // ============ 1.9.0：搜索无结果 → 通知管理员 ============
  r.post('/search-notify', auth.requireAuth, (req, res) => {
    const q = String((req.body && req.body.q) || '').trim().slice(0, 200);
    if (!q) return res.status(400).json({ error: '搜索词为空' });
    const last = (store.listNotifications()[0] || {});
    const item = store.addNotification({
      q, scope: String((req.body && req.body.scope) || 'library'),
      by: req.user.id, byEmail: req.user.email
    });
    // 顺便给所有管理员发一封邮件（配了 SMTP 才有用，失败不影响主流程）
    if (item.id !== last.id) {
      const cfg = store.data.settings.smtp;
      const admins = store.users.filter(u => u.role === 'admin' && u.status === 'active').map(u => u.email);
      if (cfg && cfg.host && admins.length) {
        const { sendTest } = require('../lib/mailer');
        sendTest(cfg, admins[0], `${store.data.settings.siteName} · 有人没搜到书：${q}`)
          .catch(() => {});
      }
      store.logAudit(req, 'search.notify', q);
    }
    res.json({ ok: true, item: { id: item.id, q: item.q, at: item.at } });
  });

  r.get('/notifications', ...adminOnly(), (req, res) => {
    const items = store.listNotifications().map(n => {
      if (!n.readAt) n.readAt = Date.now();
      return { id: n.id, q: n.q, scope: n.scope, byEmail: n.byEmail, at: n.at };
    });
    if (items.length) store.save();
    res.json({ items, unread: 0 });
  });

  r.delete('/notifications', ...adminOnly(), (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
    res.json({ ok: true, removed: store.clearNotifications(ids) });
  });

  // ============ 图书列表 ============
  // 书籍年份：优先出版日期，无则取文件年份
  function bookYear(b) {
    const m = String(b.date || '').match(/(\d{4})/);
    if (m) return m[1];
    try { return String(new Date(b.mtime || b.addedAt || 0).getFullYear()); } catch (_) { return ''; }
  }

  r.get('/books', auth.requireAuth, (req, res) => {
    const { q, format, series, work, year, col } = req.query;
    let sort = String(req.query.sort || 'added');
    let list = store.books.filter(b => b.status !== 'hidden');
    if (col) {
      // 专题（1.8.2）：按「作品键」过滤，专题里的书在书库里仍然只有一份
      const c = store.findCollection(String(col));
      if (!c) return res.status(404).json({ error: '专题不存在' });
      const keys = new Set(c.keys);
      list = list.filter(b => keys.has(store.keyOf(b)));
    }
    if (q) {
      const kw = String(q).toLowerCase();
      // 1.9.0：搜索同时命中「原始文件路径」——NAS 上的目录名往往就写着分类/作者/丛书名，
      // 用户按目录找书时直接搜那串字就能出来。
      list = list.filter(b => (
        (b.title || '') + ' ' + (b.author || '') + ' ' + (b.filename || '') +
        ' ' + (b.path || '') + ' ' + (b.series || '') + ' ' + (b.publisher || '')
      ).toLowerCase().includes(kw));
    }
    if (format) {
      const set = new Set(String(format).toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
      if (set.size) list = list.filter(b => set.has(String(b.ext || '').toLowerCase()));
    }
    if (series) list = list.filter(b => b.series === series);
    // 1.9.2：筛选面板——格式 / 出版社 / 作者，多选用逗号分隔（同一类内部是「或」，不同类之间是「且」）
    const pubs = String(req.query.publisher || '').split(',').map(s => s.trim()).filter(Boolean);
    if (pubs.length) {
      const set = new Set(pubs.map(s => s.toLowerCase()));
      list = list.filter(b => set.has(String(b.publisher || '').trim().toLowerCase()));
    }
    const auths = String(req.query.author || '').split(',').map(s => s.trim()).filter(Boolean);
    if (auths.length) {
      list = list.filter(b => {
        const raw = String(b.author || '');
        const parts = raw.split(/[\/、,，;；|]+/).map(s => s.replace(/\s*(著|编著|主编|译|等)\s*$/, '').trim());
        const pool = new Set([raw.trim(), ...parts]);
        return auths.some(a => pool.has(a) || raw.includes(a));
      });
    }
    if (work) list = list.filter(b => b.workKey === work);
    if (year) list = list.filter(b => bookYear(b) === String(year));
    const sorters = {
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'),
      author: (a, b) => String(a.author).localeCompare(String(b.author), 'zh-CN'),
      updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    };
    list.sort(sorters[sort] || sorters.added);
    // 同一作品（同名同作者）在书库中只显示一个代表条目，其余作为版本
    // 代表条目优先取当前用户设置的默认版本
    if (!work) {
      const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0) + (x.isbn ? 1 : 0) + (x.tocCount ? 1 : 0);
      const prefer = new Map();
      for (const uid of Object.keys(store.data.defaultVersion || {})) {
        const m = store.data.defaultVersion[uid];
        for (const [wk, bid] of Object.entries(m)) prefer.set(wk + '|' + uid, bid);
      }
      const seen = new Map();
      const deduped = [];
      for (const b of list) {
        const k = b.workKey || ('id:' + b.id);
        const prev = seen.get(k);
        if (!prev) { seen.set(k, b); deduped.push(b); continue; }
        // 用户默认版本优先，其次信息更全的
        const defId = prefer.get(k + '|' + req.user.id);
        const better = (defId && b.id === defId) || (!defId && score(b) > score(prev));
        if (better) {
          const idx = deduped.indexOf(prev);
          if (idx >= 0) deduped[idx] = b;
          seen.set(k, b);
        }
      }
      list = deduped;
    }
    // 一次性预计算版本数与当前用户的书签/笔记数（避免 O(n²)）
    const ctx = buildSummaryCtx(req.user.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    // 1.8.2：每页数量由前端下拉选择（24 / 48 / 96 / 200）
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 24));
    const total = list.length;
    const items = list.slice((page - 1) * limit, page * limit).map(b => bookSummary(b, ctx));
    res.json({ total, page, pages: Math.ceil(total / limit) || 1, items, pageSize: limit });
  });

  function versionList(workKey, self) {
    const list = workKey ? store.books.filter(x => x.workKey === workKey && x.status !== 'hidden') : [];
    if (self && !list.some(x => x.id === self.id)) list.push(self);
    return list;
  }

  // 1.9.0：书库「按格式筛选」用的数量统计（只返回有书的格式）
  r.get('/formats', auth.requireAuth, (req, res) => {
    const map = new Map();
    for (const b of store.books) {
      if (b.status === 'hidden') continue;
      const e = String(b.ext || '').toLowerCase();
      if (!e) continue;
      map.set(e, (map.get(e) || 0) + 1);
    }
    const items = [...map.entries()].map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ items, total: store.books.length });
  });

  /**
   * 1.9.2：书库「筛选」面板用的可选项（格式 / 出版社 / 作者）。
   * 传 col 时只统计该专题里的书，传 q 时只统计当前搜索结果里的书，
   * 这样筛选面板永远只列出「当前视野里真的有书」的选项。
   */
  r.get('/facets', auth.requireAuth, (req, res) => {
    const kw = String(req.query.q || '').trim().toLowerCase();
    const col = String(req.query.col || '');
    let list = store.books.filter(b => b.status !== 'hidden');
    if (col) {
      const c = store.findCollection(col);
      if (!c) return res.status(404).json({ error: '专题不存在' });
      const keys = new Set(c.keys || []);
      list = list.filter(b => keys.has(store.keyOf(b)));
    }
    if (kw) {
      list = list.filter(b => (
        (b.title || '') + ' ' + (b.author || '') + ' ' + (b.filename || '') +
        ' ' + (b.path || '') + ' ' + (b.series || '') + ' ' + (b.publisher || '')
      ).toLowerCase().includes(kw));
    }
    const tally = (key) => {
      const m = new Map();
      for (const b of list) {
        const v = String(b[key] || '').trim();
        if (!v) continue;
        m.set(v, (m.get(v) || 0) + 1);
      }
      // 作者字段常是「A/B」「A 著」这类复合串，按分隔符拆开分别计数
      return m;
    };
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-CN'))
      .slice(0, n).map(([value, count]) => ({ value, count }));
    const fmt = new Map();
    for (const b of list) {
      const e = String(b.ext || '').toLowerCase();
      if (e) fmt.set(e, (fmt.get(e) || 0) + 1);
    }
    const authorMap = new Map();
    for (const b of list) {
      const raw = String(b.author || '').trim();
      if (!raw) continue;
      const parts = raw.split(/[\/、,，;；|]+/).map(s => s.replace(/\s*(著|编著|主编|译|等)\s*$/, '').trim()).filter(Boolean);
      for (const p of new Set(parts.length ? parts : [raw])) {
        if (p.length > 24) continue;
        authorMap.set(p, (authorMap.get(p) || 0) + 1);
      }
    }
    res.json({
      total: list.length,
      formats: [...fmt.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })),
      publishers: top(tally('publisher'), 60),
      authors: top(authorMap, 60)
    });
  });

  function buildSummaryCtx(userId) {
    const verCount = new Map();
    for (const b of store.books) {
      if (b.status === 'hidden' || !b.workKey) continue;
      verCount.set(b.workKey, (verCount.get(b.workKey) || 0) + 1);
    }
    const annByWork = new Map();
    if (userId) {
      const myAnns = store.data.annotations[userId] || {};
      for (const [bookId, arr] of Object.entries(myAnns)) {
        if (!arr || !arr.length) continue;
        const b = store.findBook(bookId);
        if (!b || !b.workKey) continue;
        const cur = annByWork.get(b.workKey) || { bookmarks: 0, notes: 0 };
        for (const a of arr) { if (a.type === 'bookmark') cur.bookmarks++; else cur.notes++; }
        annByWork.set(b.workKey, cur);
      }
    }
    return { userId, verCount, annByWork };
  }

  function bookSummary(b, ctx) {
    if (!ctx) ctx = b.__sumCtx || buildSummaryCtx(null);
    const versions = b.workKey ? (ctx.verCount.get(b.workKey) || 1) : 1;
    const anns = b.workKey ? (ctx.annByWork.get(b.workKey) || { bookmarks: 0, notes: 0 }) : { bookmarks: 0, notes: 0 };
    return {
      id: b.id, title: b.title, author: b.author, ext: b.ext,
      cover: !!b.coverExt, year: bookYear(b),
      addedAt: b.addedAt, series: b.series, workKey: b.workKey || '',
      versions,
      anns,
      description: String(b.description || '').slice(0, 120)
    };
  }

  // ---------- 每日推荐（按「日期 + 用户」生成确定性随机，同一天不变、次日更换） ----------
  function localDay(d) {
    d = d || new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function dailyPicks(userId, n, exclude, ctx) {
    const pool = store.books.filter(b => b.status !== 'hidden' && !exclude.has(b.id));
    if (!pool.length) return [];
    const rnd = seededRandom(hashStr(localDay() + '|' + userId));
    // 部分洗牌：只取前 n 个，避免为整库排序
    const idx = pool.map((_, i) => i);
    const pick = [];
    const take = Math.min(n, idx.length);
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rnd() * (idx.length - i));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      pick.push(pool[idx[i]]);
    }
    return pick.map(b => bookSummary(b, ctx));
  }

  // ============ 书籍详情 ============
  r.get('/books/:id', auth.requireAuth, wrap(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    let b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    if (!fs.existsSync(b.path)) return res.status(410).json({ error: '源文件已不存在，请重新扫描书库' });
    // 打开详情 = 用户最关心这本书：插队优先刮削，最多等 1.5 秒，超时就让它在后台继续
    // （1.8.2：等待时间调短，剩下的结果由前端局部更新补上，不整页重渲染）
    const sw = runtime.scraper;
    if (sw && sw.needs(b)) {
      sw.prioritize(b.id);
      await sw.scrapeNow(b.id, 1500);
      b = store.findBook(b.id) || b;
    }
    const st = fs.statSync(b.path);
    // 1.9.0：版本顺序可由管理员调整（上移/下移），这里按保存的顺序输出
    const versions = store.sortVersions(b.workKey, store.books
      .filter(x => x.workKey && x.workKey === b.workKey))
      .map(x => ({
        id: x.id, ext: x.ext, filename: x.filename, size: x.size,
        // 绝对路径只给管理员（普通用户拿到 /vol1/1000/... 等于拿到 NAS 存储布局）
        ...(isAdmin ? { path: x.path } : {}),
        addedAt: x.addedAt, pages: x.pages || 0, current: x.id === b.id,
        generated: !!x.generated, generatedFrom: x.generatedFrom || '',
        isDefault: store.getDefaultVersion(req.user.id, x.workKey) === x.id,
        progress: store.getProgress(req.user.id, x.id)
      }));
    // 1.9.0：这本书属于哪些专题（详情页「专辑管理」用）
    const myKeys = new Set([store.keyOf(b)]);
    for (const v of versions) myKeys.add('id:' + v.id);
    const inCollections = store.listCollections()
      .filter(c => c.keys.some(k => myKeys.has(k)))
      .map(c => ({ id: c.id, name: c.name }));
    // 该作品全部版本的书签与笔记（当前用户）
    const anns = [];
    for (const v of versions) {
      for (const a of store.getAnnotations(req.user.id, v.id)) anns.push(Object.assign({ versionId: v.id, versionExt: v.ext, versionFile: v.filename }, a));
    }
    anns.sort((x, y) => y.createdAt - x.createdAt);
    res.json({
      id: b.id, title: b.title, author: b.author,
      publisher: b.publisher, date: b.date, language: b.language, isbn: b.isbn,
      year: bookYear(b),
      description: b.description, series: b.series,
      ext: b.ext, filename: b.filename, size: st.size,
      // 1.8.0：管理员需要核对文件到底存在哪（普通用户不返回，避免泄露 NAS 目录结构）
      path: isAdmin ? b.path : undefined,
      dir: isAdmin ? path.dirname(b.path) : undefined,
      mtime: isAdmin ? st.mtimeMs : undefined,
      cover: !!b.coverExt,
      coverSource: b.coverSource || '', generated: !!b.generated, generatedFrom: b.generatedFrom || '',
      addedAt: b.addedAt, updatedAt: b.updatedAt, workKey: b.workKey,
      manual: b.manual || {}, scrapeInfo: b.scrapeInfo || null,
      tocCount: b.tocCount || 0, tocSource: b.tocSource || '',
      imagePdf: b.imagePdf && b.imagePdf.path ? { pages: b.imagePdf.pages, at: b.imagePdf.at } : null,
      convert: b.convert || null,
      versions, annotations: anns,
      collections: inCollections,
      finished: store.isFinished(req.user.id, b.id),
      progress: store.getProgress(req.user.id, b.id),
      defaultVersion: versions.length ? (store.getDefaultVersion(req.user.id, b.workKey) || b.id) : b.id,
      pendingDeletion: store.listDeletions('pending').some(d => d.bookId === b.id),
      // 前端据此后台轮询补全结果（后台刮削与扫描解耦）
      scrapeState: b.scrapeState || (b.scrapeInfo ? 'done' : 'off'),
      scrapePending: !!(runtime.scraper && runtime.scraper.needs(b)),
      // 1.9.2：刮削这张卡按「作品」判断——同作品的任一版本刮到过就算这个作品刮到过
      workScrape: versions.some(v => v.scrapeInfo || v.scrapeState === 'done') ? 'done'
        : (versions.some(v => v.scrapeState === 'pending') || (runtime.scraper && versions.some(v => runtime.scraper.needs(v))))
          ? 'pending' : 'failed',
      workScrapeTries: versions.reduce((m, v) => Math.max(m, v.scrapeTries || 0), 0)
    });
  }));

  // 刮削进度轻量查询（1.8.2）：详情页用它做「局部更新」，不再整页重渲染打断用户操作
  r.get('/books/:id/scrape-status', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    res.json({
      id: b.id,
      scrapeState: b.scrapeState || (b.scrapeInfo ? 'done' : 'off'),
      scrapePending: !!(runtime.scraper && runtime.scraper.needs(b)),
      scrapeInfo: b.scrapeInfo || null,
      title: b.title, author: b.author,
      publisher: b.publisher || '', date: b.date || '', isbn: b.isbn || '',
      description: b.description || '', coverExt: b.coverExt || '',
      workKey: b.workKey || '', titleSrc: b.titleSrc || ''
    });
  });

  // 手动编辑元数据
  r.put('/books/:id/meta', ...adminOnly(), (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const body = req.body || {};
    const manual = Object.assign({}, b.manual || {});
    const set = (field, cast) => {
      if (body[field] === undefined) return;
      b[field] = cast ? cast(body[field]) : body[field];
      manual[field] = true;
    };
    set('title', v => String(v).trim().slice(0, 200) || b.title);
    set('author', v => String(v).trim().slice(0, 120) || '未知作者');
    set('publisher', v => String(v).trim().slice(0, 120));
    set('date', v => String(v).trim().slice(0, 20));
    set('isbn', v => String(v).replace(/[^\dXx]/g, '').slice(0, 13));
    set('description', v => String(v).slice(0, 4000));
    b.manual = manual;
    // 1.8.0：归并键按书名计算；手动合并/分离过的书保持原键
    if (!b.groupLocked) b.workKey = b.series ? taxonomy.seriesKey(b.series) : taxonomy.workKey(b.title);
    b.updatedAt = Date.now();
    store.upsertBook(b);
    res.json({ ok: true, book: { id: b.id, title: b.title, author: b.author, workKey: b.workKey } });
  });

  function adminOnly() {
    const mw = [auth.requireAuth, auth.requireAdmin];
    return mw;
  }

  // ============ 版本管理 ============
  r.get('/works/:workKey', auth.requireAuth, (req, res) => {
    const list = store.sortVersions(req.params.workKey,
      store.books.filter(b => b.workKey === req.params.workKey && b.status !== 'hidden'));
    if (!list.length) return res.status(404).json({ error: '未找到该作品' });
    res.json({
      workKey: req.params.workKey,
      title: list[0].title, author: list[0].author,
      versions: list.map(b => ({
        id: b.id, ext: b.ext, filename: b.filename, size: b.size, pages: b.pages || 0,
        addedAt: b.addedAt,
        ...(req.user.role === 'admin' ? { path: b.path } : {}),
        isDefault: store.getDefaultVersion(req.user.id, b.workKey) === b.id,
        progress: store.getProgress(req.user.id, b.id)
      }))
    });
  });

  // 拖拽合并：把 source 版本并入 target 所在作品
  r.post('/works/merge', auth.requireAuth, auth.requireEditor, (req, res) => {
    const { sourceId, targetId } = req.body || {};
    if (typeof sourceId !== 'string' || typeof targetId !== 'string') return res.status(400).json({ error: '缺少参数' });
    const r = store.mergeVersions(sourceId, targetId);
    if (!r) return res.status(404).json({ error: '图书不存在' });
    if (!r.ok) return res.status(400).json({ error: r.error });
    store.logAudit(req, 'work.merge', r.workKey, { sourceId, targetId });
    res.json({ ok: true, workKey: r.workKey });
  });

  /**
   * 1.9.0：批量合并——书库里多选几本（或版本管理里批量挑候选）后，一次并成一部作品。
   * 目标默认取「信息最全」的那本（有封面 + 有简介的优先），也可以显式指定 targetId。
   */
  r.post('/works/merge-batch', auth.requireAuth, auth.requireEditor, (req, res) => {
    const body = req.body || {};
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : (body.bookIds || []))
      .map(String).filter(Boolean))];
    if (ids.length < 2) return res.status(400).json({ error: '至少要选中两本书' });
    const books = ids.map(id => store.findBook(id)).filter(Boolean);
    if (books.length < 2) return res.status(400).json({ error: '选中的书籍不存在' });
    let target = body.targetId ? store.findBook(String(body.targetId)) : null;
    if (!target) {
      const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0) + (x.isbn ? 1 : 0) + (x.tocCount ? 1 : 0);
      target = books.slice().sort((a, b) => score(b) - score(a))[0];
    }
    let merged = 0;
    for (const b of books) {
      if (b.id === target.id) continue;
      const r = store.mergeVersions(b.id, target.id);
      if (r && r.ok) merged++;
    }
    // 合并后刷新一次作品内的封面/归并键，让整组看起来一致
    try { scanner.applyPdfCover(target); } catch (_) {}
    store.logAudit(req, 'work.merge-batch', target.workKey || target.id, { merged, target: target.id });
    res.json({ ok: true, merged, targetId: target.id, workKey: target.workKey || '' });
  });

  /**
   * 1.9.0：按路径批量合并。
   * NAS 上同一个文件夹里通常放的是同一部作品的不同格式/不同译本（《三体》pdf + epub + mobi），
   * 扫描时如果文件名差异太大没自动并起来，这里让管理员按目录一把并掉。
   */
  r.get('/path-groups', auth.requireAuth, auth.requireEditor, (req, res) => {
    const byDir = new Map();
    for (const b of store.books) {
      if (b.status === 'hidden') continue;
      const dir = path.dirname(b.path || '');
      if (!dir || dir === '.') continue;
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(b);
    }
    const items = [];
    let subDirs = 0, subBooks = 0;
    for (const [dir, list] of byDir) {
      subBooks += list.length;
      subDirs++;
      if (list.length < 2) continue;
      const works = new Set(list.map(b => store.keyOf(b)));
      if (works.size < 2) continue;   // 已经并成一部了，没什么可做的
      items.push({
        dir,
        parent: path.dirname(dir),
        name: path.basename(dir),
        count: list.length,
        works: works.size,
        books: list.slice(0, 12).map(b => ({ id: b.id, title: b.title, ext: b.ext, filename: b.filename }))
      });
    }
    items.sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }));
    res.json({ items: items.slice(0, 600), total: items.length, dirs: subDirs, books: subBooks });
  });

  r.post('/works/merge-by-path', auth.requireAuth, auth.requireEditor, (req, res) => {
    const body = req.body || {};
    const dirs = [...new Set((Array.isArray(body.dirs) ? body.dirs : (body.dir ? [body.dir] : []))
      .map(String).filter(Boolean))];
    if (!dirs.length) return res.status(400).json({ error: '请选择要合并的目录' });
    let groups = 0, merged = 0;
    const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0) + (x.isbn ? 1 : 0) + (x.tocCount ? 1 : 0);
    for (const dir of dirs) {
      const list = store.books.filter(b => b.status !== 'hidden' && path.dirname(b.path || '') === dir);
      if (list.length < 2) continue;
      const target = list.slice().sort((a, b) => score(b) - score(a))[0];
      let n = 0;
      for (const b of list) {
        if (b.id === target.id) continue;
        const r = store.mergeVersions(b.id, target.id);
        if (r && r.ok) n++;
      }
      if (n) { groups++; merged += n; }
    }
    try { store.flushNow(); } catch (_) {}
    store.logAudit(req, 'work.merge-path', dirs.join('|').slice(0, 200), { groups, merged });
    res.json({ ok: true, groups, merged });
  });

  /** 1.9.0：调整版本顺序（管理员在版本管理里上移/下移，或直接提交完整顺序） */
  r.put('/works/order', auth.requireAuth, auth.requireEditor, (req, res) => {
    const body = req.body || {};
    const workKey = String(body.workKey || '');
    if (!workKey) return res.status(400).json({ error: '缺少 workKey' });
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: '缺少版本顺序' });
    // 只接受确实属于这部作品的版本，避免写进无关 id
    const owned = new Set(store.books.filter(b => b.workKey === workKey).map(b => b.id));
    const clean = ids.filter(id => owned.has(id));
    if (!clean.length) return res.status(400).json({ error: '这些版本不属于该作品' });
    const out = store.setVersionOrder(workKey, clean);
    store.logAudit(req, 'work.order', workKey, { count: out.length });
    res.json({ ok: true, ids: out });
  });

  // 拆分：把版本移出作品（独立成单版本书）
  // 1.8.2：支持三种方式——单个 bookId、批量 bookIds、整个作品 all=<workKey> 全部打散
  r.post('/works/unmerge', auth.requireAuth, auth.requireEditor, (req, res) => {
    const body = req.body || {};
    let list = [];
    if (body.all) {
      list = store.books.filter(b => b.workKey === String(body.all) && b.status !== 'hidden');
    } else if (Array.isArray(body.bookIds) && body.bookIds.length) {
      list = body.bookIds.map(id => store.findBook(String(id))).filter(Boolean);
    } else if (body.bookId) {
      const b = store.findBook(String(body.bookId));
      if (b) list = [b];
    }
    if (!list.length) return res.status(404).json({ error: '图书不存在' });
    const from = list[0].workKey;
    for (const b of list) {
      b.workKey = taxonomy.uniqueKey(b);       // 唯一键，不会被自动归并并回去
      b.groupLocked = true;                     // 手动分离过的书不再自动调整
      b.series = '';
      b.seriesAuto = false;
      b.updatedAt = Date.now();
    }
    store.save();
    store.logAudit(req, 'work.unmerge', list.length === 1 ? list[0].id : from,
      { count: list.length, from });
    res.json({ ok: true, count: list.length, workKey: list[0].workKey });
  });

  // 用户为作品选择默认版本
  // 1.7.1（复测 M-1）：与封面 / 合并 / 分离同一条权限线——默认版本决定其他用户点开看到什么，
  // 属于书库级写操作，默认仅管理员（或开启「家人共同管理」时）可改。
  r.put('/works/:workKey/default', auth.requireAuth, auth.requireEditor, (req, res) => {
    const bookId = String((req.body || {}).bookId || '');
    const b = store.findBook(bookId);
    if (!b || b.workKey !== req.params.workKey) return res.status(400).json({ error: '该版本不属于这部作品' });
    store.setDefaultVersion(req.user.id, req.params.workKey, bookId);
    store.logAudit(req, 'work.default', req.params.workKey, { bookId });
    res.json({ ok: true, bookId });
  });

  // ============ 专题（1.8.2）：像文件夹一样把书归堆 ============
  // 专题只保存「作品键」，不动书库本身：一本书可以同时出现在多个专题，移除专题也不会删书。
  function collectionViews() {
    // 一次遍历建「键 → 代表书」，避免每个专题都全表扫一遍
    const byKey = new Map();
    for (const b of store.books) {
      if (b.status === 'hidden') continue;
      const k = store.keyOf(b);
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, b); continue; }
      const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0);
      if (score(b) > score(prev)) byKey.set(k, b);
    }
    return store.listCollections().map(c => {
      const books = c.keys.map(k => byKey.get(k)).filter(Boolean);
      const withCover = books.filter(b => b.coverExt);
      const covers = (withCover.length ? withCover : books).slice(0, 4).map(b => b.id);
      return {
        id: c.id, name: c.name, desc: c.desc || '',
        count: books.length,
        keys: c.keys.length,           // 含已失效的键（文件被删了但还没重扫）
        covers,
        // 1.9.0：专题可以单独设封面（.cover 存的是扩展名）
        cover: c.cover || '',
        coverUrl: c.cover ? `/api/collection-cover/${c.id}` : '',
        createdAt: c.createdAt || 0, updatedAt: c.updatedAt || 0
      };
    });
  }

  /** 请求里的书籍标识统一转成作品键 */
  function keysFromBody(body) {
    const out = [];
    for (const id of (body && Array.isArray(body.bookIds) ? body.bookIds : [])) {
      const b = store.findBook(String(id));
      if (b) out.push(store.keyOf(b));
    }
    for (const k of (body && Array.isArray(body.keys) ? body.keys : [])) {
      if (typeof k === 'string' && k) out.push(k);
    }
    return [...new Set(out)];
  }

  r.get('/collections', auth.requireAuth, (req, res) => {
    res.json({ items: collectionViews(), canEdit: auth.isEditor(req.user) });
  });

  r.get('/collections/:id', auth.requireAuth, (req, res) => {
    const c = store.findCollection(req.params.id);
    if (!c) return res.status(404).json({ error: '专题不存在' });
    const v = collectionViews().find(x => x.id === c.id) || { id: c.id, name: c.name, count: 0 };
    res.json(Object.assign(v, { canEdit: auth.isEditor(req.user) }));
  });

  r.post('/collections', auth.requireAuth, auth.requireEditor, (req, res) => {
    const body = req.body || {};
    const c = store.createCollection({
      name: body.name, desc: body.desc,
      keys: keysFromBody(body), createdBy: req.user.email
    });
    store.logAudit(req, 'collection.create', c.id, { name: c.name, keys: c.keys.length });
    res.json({ ok: true, collection: { id: c.id, name: c.name, keys: c.keys.length } });
  });

  r.put('/collections/:id', auth.requireAuth, auth.requireEditor, (req, res) => {
    const c = store.updateCollection(req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: '专题不存在' });
    store.logAudit(req, 'collection.update', c.id, { name: c.name });
    res.json({ ok: true, collection: { id: c.id, name: c.name } });
  });

  r.delete('/collections/:id', auth.requireAuth, auth.requireEditor, (req, res) => {
    const c = store.findCollection(req.params.id);
    if (!c) return res.status(404).json({ error: '专题不存在' });
    store.deleteCollection(c.id);
    store.logAudit(req, 'collection.delete', c.id, { name: c.name });
    res.json({ ok: true });
  });

  r.post('/collections/:id/items', auth.requireAuth, auth.requireEditor, (req, res) => {
    const keys = keysFromBody(req.body);
    if (!keys.length) return res.status(400).json({ error: '没有选中任何书' });
    const r = store.addToCollection(req.params.id, keys);
    if (!r) return res.status(404).json({ error: '专题不存在' });
    store.logAudit(req, 'collection.add', req.params.id, { added: r.added });
    res.json(Object.assign({ ok: true }, r));
  });

  r.delete('/collections/:id/items', auth.requireAuth, auth.requireEditor, (req, res) => {
    const keys = keysFromBody(req.body);
    const r = store.removeFromCollection(req.params.id, keys);
    if (!r) return res.status(404).json({ error: '专题不存在' });
    store.logAudit(req, 'collection.remove', req.params.id, { removed: r.removed });
    res.json(Object.assign({ ok: true }, r));
  });

  // ============ 1.9.0：专题封面 ============
  r.get('/collection-cover/:id', auth.requireAuth, (req, res) => {
    const f = store.collectionCoverFile(req.params.id);
    if (!f) return res.status(404).end();
    res.setHeader('Content-Type', MIME[path.extname(f).slice(1).toLowerCase()] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    streamFile(res, f);
  });

  r.post('/collections/:id/cover', express.json({ limit: '8mb' }), auth.requireAuth, auth.requireEditor, (req, res) => {
    const c = store.findCollection(req.params.id);
    if (!c) return res.status(404).json({ error: '专题不存在' });
    const body = req.body || {};
    if (body.source === 'reset') {
      store.clearCollectionCover(c.id);
      return res.json({ ok: true, cover: '' });
    }
    if (body.bookId) {
      // 用专题里某一本书的封面：直接复制那张图（不依赖原书后续是否被删）
      const b = store.findBook(String(body.bookId));
      if (!b) return res.status(404).json({ error: '图书不存在' });
      for (const e of ['.jpg', '.png', '.webp', '.gif']) {
        const f = path.join(store.coversDir, b.id + e);
        if (!fs.existsSync(f)) continue;
        try {
          const ext = store.setCollectionCover(c.id, fs.readFileSync(f), e === '.png' ? '.png' : '.jpg');
          return res.json({ ok: true, cover: ext });
        } catch (err) { return res.status(500).json({ error: '保存失败：' + err.message }); }
      }
      return res.status(400).json({ error: '这本书还没有封面' });
    }
    const m = String(body.dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: '图片格式不正确（支持 JPG / PNG / WebP）' });
    try {
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 500) return res.status(400).json({ error: '图片内容为空' });
      const ext = store.setCollectionCover(c.id, buf, m[1] === 'png' ? '.png' : '.jpg');
      store.logAudit(req, 'collection.cover', c.id, { size: buf.length });
      return res.json({ ok: true, cover: ext });
    } catch (e) { return res.status(500).json({ error: '保存失败：' + e.message }); }
  });

  /**
   * 1.9.0：批量编辑专题——把一批书一次性加进 / 移出多个专题。
   * action=add|remove|replace；ids 是专题 id 列表；bookIds 是书（版本）id 列表。
   * replace 语义：让这批书「只属于」这些专题里勾选的那些（其它专题里移除）。
   */
  r.post('/collections/batch', auth.requireAuth, auth.requireEditor, (req, res) => {
    const body = req.body || {};
    const action = ['add', 'remove', 'replace'].includes(body.action) ? body.action : 'add';
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(Boolean);
    const keys = keysFromBody(body);
    if (!keys.length) return res.status(400).json({ error: '没有选中任何书' });
    const cols = store.listCollections();
    if (!ids.length && action !== 'replace') return res.status(400).json({ error: '请选择要处理的专题' });
    let added = 0, removed = 0;
    if (action === 'remove' || action === 'replace') {
      for (const c of cols) {
        if (action === 'remove' && !ids.includes(c.id)) continue;
        if (action === 'replace' && ids.includes(c.id)) continue;   // 勾选的保留
        const r = store.removeFromCollection(c.id, keys);
        if (r) removed += r.removed;
      }
    }
    if (action === 'add' || action === 'replace') {
      for (const id of ids) {
        const r = store.addToCollection(id, keys);
        if (r) added += r.added;
      }
    }
    store.logAudit(req, 'collection.batch', ids.join(','), { action, added, removed, books: keys.length });
    res.json({ ok: true, action, added, removed, books: keys.length });
  });

  /**
   * 1.9.0：按路径批量合并——NAS 上同一个文件夹里的一堆同名书（不同格式/不同分册）
   * 一次并成一部作品。dryRun 时只返回会合并哪些，不动数据。
   */
  r.post('/admin/merge-by-path', ...adminOnly(), (req, res) => {
    const body = req.body || {};
    const dir = String(body.path || '').trim();
    if (!dir) return res.status(400).json({ error: '请输入目录路径' });
    const norm = p => String(p || '').replace(/[\\/]+$/, '');
    const deep = !!body.deep;
    const list = store.books.filter(b => {
      if (b.status === 'hidden') return false;
      const d = norm(path.dirname(b.path || ''));
      return deep ? (d === norm(dir) || d.startsWith(norm(dir) + '/')) : d === norm(dir);
    });
    if (!list.length) return res.status(404).json({ error: '这个目录下没有已入库的书（请先扫描）' });
    // 按「当前归并键」分组统计，让管理员知道会并成几部
    const groups = new Map();
    for (const b of list) {
      const k = b.workKey || ('id:' + b.id);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    if (body.dryRun) {
      return res.json({
        ok: true, dryRun: true, count: list.length,
        groups: [...groups.values()].map(g => ({
          workKey: g[0].workKey || '',
          title: g[0].title,
          books: g.map(b => ({ id: b.id, title: b.title, ext: b.ext, filename: b.filename }))
        }))
      });
    }
    // 真正合并：以整个目录为一组，target 取信息最全的一本
    const score = x => (x.coverExt ? 4 : 0) + (x.description ? 2 : 0) + (x.isbn ? 1 : 0) + (x.tocCount ? 1 : 0);
    const target = list.slice().sort((a, b) => score(b) - score(a))[0];
    const title = String(body.title || '').trim().slice(0, 200);
    if (title) { target.title = title; target.workKey = taxonomy.workKey(title); target.manual = Object.assign({}, target.manual, { title: true }); }
    let merged = 0;
    for (const b of list) {
      if (b.id === target.id) continue;
      const r = store.mergeVersions(b.id, target.id);
      if (r && r.ok) merged++;
    }
    store.save();
    try { scanner.applyPdfCover(target); } catch (_) {}
    store.logAudit(req, 'library.merge-by-path', dir, { merged, total: list.length });
    res.json({ ok: true, merged, total: list.length, targetId: target.id, workKey: target.workKey || '', title: target.title });
  });

  // ============ 记录模块：当前用户全部书签与笔记（按书籍分组） ============
  r.get('/records', auth.requireAuth, (req, res) => {
    res.json({ groups: store.listAnnotationsGrouped(req.user.id) });
  });

  // 查询版本上的书签/笔记占用（删除前提醒）
  r.get('/books/:id/usage', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    res.json({ usage: store.countAnnotationsForBook(b.id) });
  });

  // ============ 删除申请（所有删除都需管理员二次确认） ============
  r.post('/books/:id/delete-request', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    if (store.listDeletions('pending').some(d => d.bookId === b.id)) {
      return res.status(400).json({ error: '该版本已有待审核的删除申请，请等待管理员处理' });
    }
    const usage = store.countAnnotationsForBook(b.id);
    const d = store.addDeletion({
      bookId: b.id, title: b.title, filename: b.filename, path: b.path,
      requestedBy: req.user.id, requestedByEmail: req.user.email,
      note: String((req.body && req.body.note) || '').slice(0, 300),
      usage
    });
    // 回显给申请人的内容不含磁盘绝对路径（path 只留在服务端与管理员的审批详情里）
    const view = {
      id: d.id, bookId: d.bookId, title: d.title, filename: d.filename,
      status: d.status, requestedAt: d.requestedAt, note: d.note
    };
    store.logAudit(req, 'book.delete-request', b.id, { title: b.title });
    res.json({ ok: true, request: view, usage });
  });

  r.get('/deletions', ...adminOnly(), (req, res) => {
    // 1.9.0：已处理（同意/拒绝）的申请只保留 1 天
    store.pruneDeletions();
    const status = req.query.status ? String(req.query.status) : '';
    const list = store.listDeletions(status).map(d => ({
      ...d,
      usage: d.usage || store.countAnnotationsForBook(d.bookId),
      exists: d.path ? fs.existsSync(d.path) : false,
      size: d.path && fs.existsSync(d.path) ? fs.statSync(d.path).size : 0
    }));
    res.json({ items: list, pending: store.countPendingDeletions() });
  });

  r.post('/deletions/:id/approve', ...adminOnly(), (req, res) => {
    const d = store.getDeletion(req.params.id);
    if (!d) return res.status(404).json({ error: '申请不存在' });
    if (d.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
    const b = store.findBook(d.bookId);
    const srcPath = (b && b.path) || d.path;
    let moved = null;
    if (srcPath && fs.existsSync(srcPath)) {
      // 不直接物理删除：移入应用数据目录的回收站，管理员可事后清理
      // 1.9.1：文件名里带 ISO 时间戳，回收站可据此算出「还剩几天自动清理」，也能还原原始文件名
      const dest = path.join(store.trashDir, store.constructor.trashStampName(srcPath));
      try {
        fs.mkdirSync(store.trashDir, { recursive: true });
        fs.renameSync(srcPath, dest);
        moved = dest;
      } catch (e) {
        // 跨分区时退化为复制 + 删除
        try { fs.copyFileSync(srcPath, dest); fs.unlinkSync(srcPath); moved = dest; }
        catch (e2) { return res.status(500).json({ error: '删除失败：' + e2.message }); }
      }
    }
    if (b) store.removeBook(b.id);
    // 1.7.1：删掉的是「转换生成的 PDF」时，把源书上的转换记录一并清掉，
    // 这样「一个文件只转换一次」的锁才会真正解开（允许再转换一次）。
    if (b && b.generatedFrom) {
      const src = store.findBook(b.generatedFrom);
      if (src) {
        src.convert = null;
        if (!src.imagePdf || !b.path || src.imagePdf.path === b.path) src.imagePdf = null;
        src.updatedAt = Date.now();
        store.upsertBook(src);
      }
    }
    store.resolveDeletion(d.id, 'approved', req.user.email);
    d.movedTo = moved;
    if (moved) d.trashName = path.basename(moved);
    store.flushNow().catch(() => {});
    res.json({ ok: true, movedTo: moved });
  });

  r.post('/deletions/:id/reject', ...adminOnly(), (req, res) => {
    const d = store.getDeletion(req.params.id);
    if (!d) return res.status(404).json({ error: '申请不存在' });
    if (d.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
    store.resolveDeletion(d.id, 'rejected', req.user.email);
    store.flushNow().catch(() => {});
    res.json({ ok: true });
  });

  // ============ 1.9.1：回收站（恢复 / 清空 / 30 天自动清理） ============
  r.get('/trash', ...adminOnly(), (req, res) => {
    // 每次查看顺手清一次过期的（30 天），用户不必等每日定时
    try { store.pruneTrash(); } catch (_) {}
    const items = store.listTrash().map(t => Object.assign({}, t, {
      // 从历史删除申请里找回原路径，恢复时回到原位
      path: ((store.data.deletions || []).find(d => (d.trashName === t.name) || (d.movedTo && path.basename(d.movedTo) === t.name)) || {}).path || ''
    }));
    res.json({ items, dir: store.trashDir, keepDays: TRASH_KEEP_DAYS });
  });
  r.post('/trash/:name/restore', ...adminOnly(), (req, res) => {
    try {
      const r = store.restoreFromTrash(decodeURIComponent(req.params.name), (req.body && req.body.path) || '');
      store.logAudit(req, 'trash.restore', r.original, { to: r.restored });
      res.json(r);
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  r.delete('/trash/:name', ...adminOnly(), (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name);
      const r = store.purgeTrash(name);
      store.logAudit(req, 'trash.purge', store.constructor.trashOriginalName(name));
      res.json(r);
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  r.post('/trash/empty', ...adminOnly(), (req, res) => {
    const onlyExpired = !!(req.body && req.body.expired);
    const r = store.emptyTrash(onlyExpired);
    store.logAudit(req, 'trash.empty', onlyExpired ? 'expired' : 'all', { removed: r.removed });
    res.json(r);
  });

  // ============ 文件流 ============
  /**
   * 统一的安全流式发送：读文件出错（EACCES/ENOENT/EIO…）只影响本次响应，
   * 绝不冒泡成 uncaughtException 把整个进程打死（1.6.3）。
   */
  function streamFile(res, filePath, range) {
    let rs;
    try {
      rs = range ? fs.createReadStream(filePath, range) : fs.createReadStream(filePath);
    } catch (e) {
      try { res.status(500).json({ error: '文件读取失败：' + (e.code || e.message) }); } catch (_) {}
      return null;
    }
    rs.on('error', e => {
      log.warn('http', `文件读取失败（${e.code || e.message}）：${filePath}`);
      try { if (!res.headersSent) res.status(500).end(); else res.destroy(); } catch (_) {}
    });
    res.on('close', () => { try { rs.destroy(); } catch (_) {} });
    rs.pipe(res);
    return rs;
  }

  function sendRangeFile(req, res, filePath, filename, mime) {
    let st;
    try { st = fs.statSync(filePath); } catch (e) { return res.status(404).json({ error: '文件不存在或不可读' }); }
    try { fs.accessSync(filePath, fs.constants.R_OK); } catch (e) {
      log.warn('http', `文件不可读（${e.code || e.message}）：${filePath}`);
      return res.status(403).json({ error: '文件不可读（权限不足）：' + path.basename(filePath) });
    }
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename || path.basename(filePath))}`);
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename || path.basename(filePath))}`);
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m[1] ? parseInt(m[1]) : 0;
      let end = m[2] ? parseInt(m[2]) : st.size - 1;
      if (start >= st.size) return res.status(416).end();
      end = Math.min(end, st.size - 1);
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      res.setHeader('Content-Length', end - start + 1);
      streamFile(res, filePath, { start, end });
    } else {
      res.setHeader('Content-Length', st.size);
      streamFile(res, filePath);
    }
  }

  const MIME = {
    epub: 'application/epub+zip', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
    md: 'text/markdown', cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt: 'application/vnd.ms-powerpoint', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword', html: 'text/html', htm: 'text/html', mobi: 'application/x-mobipocket-ebook',
    azw3: 'application/x-mobi8-ebook', djvu: 'image/vnd.djvu', rtf: 'application/rtf', chm: 'application/vnd.ms-htmlhelp',
    fb2: 'application/x-fictionbook+xml', azw: 'application/x-mobipocket-ebook', prc: 'application/x-mobipocket-ebook',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'
  };

  r.get('/books/:id/file', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b || !fs.existsSync(b.path)) return res.status(404).json({ error: '文件不存在' });
    // 1.6.2：下载请求单独留痕，便于区分「服务端没收到」与「浏览器拦截了」（自签名 HTTPS 会被 Chrome 拦下载）
    if (req.query.download === '1') {
      try {
        const st = fs.statSync(b.path);
        log.info('http', `下载 ${b.filename}（${st.size} 字节）→ 已开始传输`);
        res.on('close', () => {
          if (!res.writableFinished) log.warn('http', `下载中断 ${b.filename}：客户端提前断开（浏览器侧拦截或网络中断）`);
        });
      } catch (_) {}
    }
    sendRangeFile(req, res, b.path, b.filename, MIME[b.ext] || 'application/octet-stream');
  });

  // 封面（支持 webp/gif，豆瓣图片常见格式）
  // 1.6.3：封面文件可能因为数据目录是从别处拷来的、属主是 root 而不可读（EACCES）。
  // 以前 createReadStream 的 error 事件没人接，直接变成 uncaughtException 把进程打死；
  // 现在先做可读性检查，出错一律回退到占位封面。
  function sendPlaceholderCover(res, b) {
    const title = (b.title || '?').slice(0, 12);
    const author = (b.author || '').slice(0, 16);
    const colors = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2'];
    const c = colors[[...b.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % colors.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="${c}"/><rect x="24" y="24" width="252" height="372" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2" rx="8"/><text x="150" y="200" text-anchor="middle" fill="#fff" font-size="26" font-family="sans-serif" font-weight="700">${esc(title)}</text><text x="150" y="240" text-anchor="middle" fill="rgba(255,255,255,.85)" font-size="15" font-family="sans-serif">${esc(author)}</text><text x="150" y="320" text-anchor="middle" fill="rgba(255,255,255,.6)" font-size="13" font-family="sans-serif">${b.ext.toUpperCase()}</text></svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(svg);
  }

  r.get('/cover/:id', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).end();
    for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
      const f = path.join(store.coversDir, b.id + ext);
      if (!fs.existsSync(f)) continue;
      try { fs.accessSync(f, fs.constants.R_OK); } catch (e) {
        log.warn('http', `封面不可读（${e.code || e.message}）：${f}，已用占位图代替`);
        continue;
      }
      res.setHeader('Content-Type', MIME[ext.slice(1)] || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const st = fs.createReadStream(f);
      st.on('error', e => {
        log.warn('http', `封面读取中断（${e.code || e.message}）：${f}`);
        if (!res.headersSent) { try { sendPlaceholderCover(res, b); } catch (_) {} }
        else { try { res.destroy(); } catch (_) {} }
      });
      return st.pipe(res);
    }
    sendPlaceholderCover(res, b);
  });

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  // ============ 阅读调度 ============
  r.get('/books/:id/read', auth.requireAuth, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b || !fs.existsSync(b.path)) return res.status(404).json({ error: '文件不存在' });
    const token = req.query.token || '';
    const base = {
      id: b.id, title: b.title, ext: b.ext, workKey: b.workKey,
      toc: store.getToc(b.id),
      progress: store.getProgress(req.user.id, b.id)
    };
    const fileUrl = `/api/books/${b.id}/file?token=${token}`;

    if (['txt', 'md', 'html', 'htm', 'rtf', 'doc', 'docx'].includes(b.ext)) {
      // 1.8.0：分块按需加载（chunked），url 仅用于「下载原文件」
      return res.json(Object.assign(base, { type: 'text', chunked: true, url: fileUrl }));
    }
    if (b.ext === 'epub') return res.json(Object.assign(base, { type: 'epub', url: fileUrl }));
    if (b.ext === 'pdf' || b.ext === 'djvu') return res.json(Object.assign(base, { type: 'pdf', url: fileUrl }));
    if (['mobi', 'azw3', 'azw', 'prc'].includes(b.ext)) return res.json(Object.assign(base, { type: 'mobi', url: fileUrl }));
    if (b.ext === 'cbz') {
      const zip = zipread.open(b.path);
      const imgs = zip.getEntries().filter(e => /\.(jpe?g|png|webp|gif)$/i.test(e.entryName))
        .sort((a, c) => a.entryName.localeCompare(c.entryName, undefined, { numeric: true }));
      return res.json(Object.assign(base, { type: 'cbz', pages: imgs.length, url: fileUrl }));
    }
    if (b.ext === 'ppt' || b.ext === 'pptx') {
      // 1.6.3：默认交给阅读器在浏览器里直接渲染（文字可选、缩放清晰、不依赖服务端转换）。
      // 若之前已生成过图片版 PDF 且比源文件新，则额外给出「PDF 版」入口，由用户自行切换。
      let imagePdfUrl = '';
      if (b.imagePdf && b.imagePdf.path && fs.existsSync(b.imagePdf.path)) {
        const fresh = !fs.existsSync(b.path) || fs.statSync(b.imagePdf.path).mtimeMs >= fs.statSync(b.path).mtimeMs;
        if (fresh) imagePdfUrl = `/api/books/${b.id}/slidepdf?token=${token}`;
      }
      // 1.7.1：已经转换过（且 PDF 未删除）就不再给「存为 PDF」入口；非管理员也没有这个入口
      const converted = findConvertedPdf(store, b);
      const canSave = !converted && auth.isEditor(req.user);
      return res.json(Object.assign(base, {
        type: 'ppt-convert',
        ext: b.ext,
        imagePdfUrl,
        message: b.ext === 'ppt'
          ? '旧版 .ppt 会由浏览器直接解析渲染（含图片页与文字页），不需要服务端转换。'
          : 'PPTX 会由浏览器直接渲染，不需要服务端转换。',
        slidesUrl: `/api/books/${b.id}/slides?token=${token}`,
        saveUrl: canSave ? `/api/books/${b.id}/slides/pdf?token=${token}` : '',
        convertedPdf: converted ? { id: converted.id, filename: converted.filename } : null
      }));
    }
    return res.json(Object.assign(base, { type: 'download', url: fileUrl }));
  }));

  // ============ 文本分块读取（1.8.0：大 TXT / DOCX 不一次性加载） ============
  r.get('/books/:id/text', auth.requireAuth, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b || !fs.existsSync(b.path)) return res.status(404).json({ error: '文件不存在' });
    if (!['txt', 'md', 'html', 'htm', 'rtf', 'doc', 'docx', 'fb2'].includes(b.ext)) {
      return res.status(400).json({ error: '该书不是文本类文档' });
    }
    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    const count = Math.min(300, Math.max(1, parseInt(req.query.count, 10) || 80));
    const doc = await heavy.run(() => textdoc.open(b.path, b.ext));
    const total = doc.total;
    const items = from >= total ? [] : await doc.read(from, count);
    res.json({
      kind: doc.kind, encoding: doc.encoding, total,
      from, count: items.length, items,
      hasMore: from + items.length < total
    });
  }));

  // CBZ 逐页（解压单页图片属于重活，走并发闸门）
  r.get('/books/:id/cbz/:index', auth.requireAuth, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b || b.ext !== 'cbz') return res.status(404).end();
    await heavy.run(async () => {
      try {
        const zip = zipread.open(b.path);
        const imgs = zip.getEntries().filter(e => /\.(jpe?g|png|webp|gif)$/i.test(e.entryName))
          .sort((a, c) => a.entryName.localeCompare(c.entryName, undefined, { numeric: true }));
        const idx = parseInt(req.params.index);
        if (isNaN(idx) || idx < 0 || idx >= imgs.length) return res.status(404).end();
        const ct = /\.png$/i.test(imgs[idx].entryName) ? 'image/png' : /\.webp$/i.test(imgs[idx].entryName) ? 'image/webp' : 'image/jpeg';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(zip.readFile(imgs[idx]));
      } catch (e) { res.status(500).end(); }
    });
  }));

  // ============ PPT 逐页渲染 ============
  function mediaDirFor(bookId) { return path.join(store.cacheDir, 'slides', bookId); }

  r.get('/books/:id/slides', auth.requireAuth, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    if (b.ext !== 'pptx' && b.ext !== 'ppt') return res.status(400).json({ error: '仅支持 PPT/PPTX' });
    const cacheFile = path.join(store.cacheDir, b.id + '.slides.json');
    let model = null;
    try {
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).mtimeMs >= fs.statSync(b.path).mtimeMs) {
        model = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        // 1.6.2：.ppt 的解析模型换了（图片 + 文字），旧缓存里没有 pictures 字段，必须重解析
        if (b.ext === 'ppt' && !model.pictures) model = null;
      }
    } catch (_) { model = null; }
    if (!model) {
      // 重解析前让出事件循环，避免大文件同步解析阻塞其它请求
      await new Promise(r => setImmediate(r));
      model = await heavy.run(async () => (b.ext === 'ppt'
        ? pptbin.parsePpt(b.path, {
            mediaDir: mediaDirFor(b.id),
            bookId: b.id,
            mediaUrlBase: `/api/slidesmedia/${b.id}`
          })
        : pptx.parsePptx(b.path, {
            mediaDir: mediaDirFor(b.id),
            bookId: b.id,
            mediaUrlBase: `/api/slidesmedia/${b.id}`,
            token: req.query.token || ''
          })));
      try { fs.writeFileSync(cacheFile, JSON.stringify(model)); } catch (_) {}
    }
    // 图片地址补上令牌，供 <img> 直接加载（浅拷贝，避免整树深拷贝阻塞）
    const tok = req.query.token || '';
    const slides = model.slides.map(s => ({
      no: s.no, bg: s.bg,
      items: s.items.map(it => it.type === 'image' && it.src && tok
        ? Object.assign({}, it, { src: it.src + (it.src.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok) })
        : it)
    }));
    res.json({
      width: model.width, height: model.height, count: slides.length,
      slides,
      token: tok
    });
  }));

  r.get('/slidesmedia/:id/:name', auth.requireAuth, (req, res) => {
    const f = path.join(mediaDirFor(req.params.id), path.basename(req.params.name));
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.setHeader('Content-Type', MIME[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream');
    streamFile(res, f);
  });

  // 浏览器把逐页截图回传，合成图片 PDF 落到书籍原目录
  // 1.5.0：请求体上限从 120MB 降到 48MB（多用户场景下 120MB 的 JSON 会直接撑爆内存）
  // 1.7.1：与后台转换同权限线（写入书库），并且同样受「一个文件只转换一次」约束
  r.post('/books/:id/slides/pdf', express.json({ limit: '48mb' }), auth.requireAuth, auth.requireEditor, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    if (rejectIfConverted(res, b)) return;
    const images = (req.body && req.body.images) || [];
    if (!images.length) return res.status(400).json({ error: '没有收到页面图片' });
    if (images.length > 400) return res.status(400).json({ error: '页数过多' });
    let totalChars = 0;
    for (const s of images) totalChars += String(s || '').length;
    if (totalChars > 46 * 1024 * 1024) return res.status(413).json({ error: '图片总量过大，请减少页数或降低分辨率后重试' });

    const bufs = [];
    for (let i = 0; i < images.length; i++) {
      const s = String(images[i] || '');
      const m = s.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: `第 ${i + 1} 页图片格式不正确` });
      const data = Buffer.from(m[2], 'base64');
      if (data.length < 200) return res.status(400).json({ error: `第 ${i + 1} 页图片为空` });
      bufs.push({ data, type: m[1] === 'png' ? 'png' : 'jpeg' });
    }
    let pdfBuf;
    try { pdfBuf = pdfwrite.imagesToPdf(bufs); }
    catch (e) { return res.status(500).json({ error: 'PDF 合成失败：' + e.message }); }

    // 优先写到书籍所在目录（与源文件同名 .pdf）
    const dir = path.dirname(b.path);
    const baseName = path.basename(b.path).replace(/\.[^.]+$/, '');
    let target = path.join(dir, baseName + '.pdf');
    let fallback = false;
    try {
      fs.writeFileSync(target, pdfBuf);
    } catch (e) {
      fallback = true;
      target = path.join(store.cacheDir, b.id + '.slides.pdf');
      fs.writeFileSync(target, pdfBuf);
    }
    // 1.6.0：浏览器兼容模式生成的 PDF 同样登记为「同一本书的新版本」
    const rec = registerPdfVersion(store, b, target, bufs.length, 'browser-canvas', {
      fallback, userId: req.user.id
    });
    store.logAudit(req, 'book.convert.browser', b.id, { pages: bufs.length, versionId: rec.id });
    res.json({
      ok: true, pages: bufs.length, path: target, fallback, versionId: rec.id,
      url: `/api/books/${b.id}/slidepdf?token=${req.query.token || ''}`
    });
  }));

  r.get('/books/:id/slidepdf', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b || !b.imagePdf || !b.imagePdf.path || !fs.existsSync(b.imagePdf.path)) return res.status(404).json({ error: '尚未生成图片版 PDF' });
    sendRangeFile(req, res, b.imagePdf.path, path.basename(b.imagePdf.path), 'application/pdf');
  });

  // ============ 1.6.0：后台 PPT→PDF 转换（服务端逐页取图/合成，产物作为新版本入库） ============
  // 1.7.1（复测 L-4）：转换是写操作（转换完成后会向书库写入一个新版本），
  // 与封面 / 合并 / 分离走同一条权限线；任务状态只对发起人（与管理员）可见。
  // 另按「一个文件只转换一次」收紧：已生成且未删除的 PDF 版本存在时一律拒绝。
  const conv = runtime.converter;

  /** 已由这本书转换生成、且文件仍在的 PDF（含 1.5.x 时期只记在 convert/imagePdf 里的老数据） */
  function rejectIfConverted(res, b) {
    const v = findConvertedPdf(store, b);
    if (!v) return false;
    res.status(409).json({
      error: `这本书已经转换过一次（${v.filename}），同一个文件只允许转换一次。`
        + '如需重新转换，请先在下方「版本管理」里删除那个 PDF 版本。',
      versionId: v.id, filename: v.filename
    });
    return true;
  }

  r.post('/books/:id/convert', auth.requireAuth, auth.requireEditor, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    if (b.ext !== 'ppt' && b.ext !== 'pptx') return res.status(400).json({ error: '仅 PPT/PPTX 需要转换' });
    if (!conv) return res.status(503).json({ error: '后台转换服务未就绪' });
    if (rejectIfConverted(res, b)) return;
    store.logAudit(req, 'book.convert', b.id, { title: b.title });
    res.json(conv.start(b, { userId: req.user.id }));
  });
  r.get('/convert/:jobId', auth.requireAuth, (req, res) => {
    if (!conv || !conv.isOwner(req.params.jobId, req.user)) return res.status(404).json({ error: '任务不存在或已过期' });
    const j = conv.status(req.params.jobId);
    if (!j) return res.status(404).json({ error: '任务不存在或已过期' });
    res.json(j);
  });
  r.get('/books/:id/convert', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const job = conv && conv.forBook(b.id);
    res.json({ job, convert: b.convert || null, imagePdf: b.imagePdf ? { pages: b.imagePdf.pages, at: b.imagePdf.at } : null });
  });

  // ============ 1.6.0：封面设置 ============
  /** 同一部作品的全部版本（设置封面时一起更新，避免卡片/详情不一致） */
  function sameWork(b) {
    const list = b.workKey ? store.books.filter(x => x.workKey === b.workKey && x.status !== 'hidden') : [];
    return list.some(x => x.id === b.id) ? list : [b, ...list];
  }
  r.get('/books/:id/cover-options', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const tok = req.authToken || req.query.token || '';
    const n = coverpick.neighbors(b).map(x => Object.assign({}, x, {
      url: `/api/books/${b.id}/neighbor-image?name=${encodeURIComponent(x.name)}&token=${encodeURIComponent(tok)}`
    }));
    // 1.9.1：同目录没有图时，把上级目录里的图也列出来（NAS 常见「封面放在系列目录」）
    let parentImages = [];
    let parentDir = '';
    if (!n.length) {
      try {
        const here = path.dirname(b.path || '');
        const up = path.dirname(here);
        if (up && up !== here) {
          parentDir = up;
          parentImages = fs.readdirSync(up)
            .filter(f => coverpick.IMG_EXT.test(f))
            .sort((a, c) => a.localeCompare(c, undefined, { numeric: true }))
            .slice(0, 40)
            .map(f => {
              const nm = '../' + f;
              return {
                name: nm, label: f,
                url: `/api/books/${b.id}/neighbor-image?name=${encodeURIComponent(nm)}&token=${encodeURIComponent(tok)}`
              };
            });
        }
      } catch (_) {}
    }
    // 书内选页：PDF / 图片型 CBZ / 已转换的 PPT 都可以在浏览器里直接渲染指定页
    const canPage = ['pdf', 'cbz'].includes(b.ext) || !!(b.imagePdf && b.imagePdf.path);
    res.json({
      scraped: !!b.coverExt, coverSource: b.coverSource || '',
      scrapedUrl: `/api/cover/${b.id}?token=${encodeURIComponent(tok)}`,
      neighbors: n,
      dir: path.dirname(b.path || ''),
      parentDir, parentImages,
      canUpload: true,
      maxUploadMB: Math.round(coverpick.MAX_UPLOAD_BYTES / 1048576),
      page: { supported: canPage, pages: b.pages || 0, ext: b.ext,
        pdfUrl: b.ext === 'pdf' ? `/api/books/${b.id}/file?token=${encodeURIComponent(tok)}`
          : (b.imagePdf && b.imagePdf.path ? `/api/books/${b.id}/slidepdf?token=${encodeURIComponent(tok)}` : ''),
        cbzUrl: `/api/books/${b.id}/page-image?token=${encodeURIComponent(tok)}&n=` }
    });
  });
  r.get('/books/:id/neighbor-image', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).end();
    const info = coverpick.resolveNeighborInfo(b, req.query.name);
    if (!info.ok) return res.status(400).end();
    const fp = info.path;
    res.setHeader('Content-Type', coverpick.MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    streamFile(res, fp);
  });
  // CBZ 书内某一页（PDF 由浏览器用 pdf.js 直接渲染，无需服务端解页）
  r.get('/books/:id/page-image', auth.requireAuth, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b || b.ext !== 'cbz') return res.status(404).end();
    await heavy.run(async () => {
      try {
        const zip = zipread.open(b.path);
        const imgs = zip.getEntries().filter(e => /\.(jpe?g|png|webp|gif)$/i.test(e.entryName))
          .sort((a, c) => a.entryName.localeCompare(c.entryName, undefined, { numeric: true }));
        const n = Math.max(1, Math.min(imgs.length, parseInt(req.query.n) || 1));
        if (!imgs.length) return res.status(404).end();
        const name = imgs[n - 1].entryName;
        const ct = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
        res.setHeader('Content-Type', ct);
        res.send(zip.readFile(imgs[n - 1]));
      } catch (_) { res.status(500).end(); }
    });
  }));
  r.post('/books/:id/cover', express.json({ limit: '16mb' }), auth.requireAuth, auth.requireEditor, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    try {
      const out = coverpick.applyCover(store, sameWork(b), req.body || {});
      res.json(out);
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // ============ 1.6.0：已读完 ============
  r.post('/books/:id/finished', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const done = !!(req.body && req.body.done);
    store.setFinished(req.user.id, b.id, done);
    res.json({ ok: true, done, progress: store.getProgress(req.user.id, b.id) });
  });

  // 版本管理栏「手动合并其他书籍」的候选（轻量搜索，不返回整库）
  r.get('/books/:id/merge-candidates', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const ctx2 = buildSummaryCtx(req.user.id);
    const pool = store.books.filter(x => x.id !== b.id && x.status !== 'hidden' &&
      (!q || String(x.title || '').toLowerCase().includes(q) || String(x.author || '').toLowerCase().includes(q)))
      .slice(0, 40);
    /**
     * 1.9.2：候选池按「作品」聚合。
     * 以前直接列 books，一个 3 个版本的作品会占 3 行；用户勾选「这本书」时其实只想把
     * 那一部作品的 3 个文件一起并进来，结果每点一次只挪走 1 个文件（用户反馈的
     * 「每次只挪一本书」就是这么来的）。现在每行 = 一部作品，带 books[] 与文件数，
     * 前端据此一次性提交全部文件 id。
     *
     * 1.9.3：光按 workKey 聚合不够——《甲作品 卷1/卷2/卷3》三本书的 workKey 分别是
     * 「甲作品卷1@*」「甲作品卷2@*」，永远聚不到一起，用户看到的还是「一本一本挪」。
     * 所以再加一层「同目录 + 去掉卷次后的基名」聚合（taxonomy.familyKey）。
     */
    const dirOf = x => {
      const p = String(x.path || x.filePath || '');
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
      return i > 0 ? p.slice(0, i) : '';
    };
    /**
     * 两阶段聚合：
     *  1) 先给每本书算出它属于的所有键（作品键 / 同族 / 同主干）；
     *  2) 用并查集把「共享任意一个键」的书连到一起。
     * 之前是一遍扫描 + 首次命中，结果依赖遍历顺序：《戊作品-alpha》先建组并占住
     * core 键，后面 beta/gamma 各自 workKey 不同、又没命中，就各建一组（还是「一本一本挪」）。
     */
    const rows = pool.map(x => {
      const dir = dirOf(x);
      const keys = ['k:' + (x.workKey || ('id:' + x.id))];
      // 没有文件路径时不做族/主干聚合，避免误并
      if (dir) {
        const fam = taxonomy.familyKey(x.title, dir);
        const core = taxonomy.coreKey(x.title, dir);
        if (fam) keys.push('f:' + fam);
        if (core) keys.push('c:' + core);
      }
      return { book: x, keys };
    });
    // 并查集
    const parent = rows.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const keyOwner = new Map();
    rows.forEach((row, i) => {
      for (const k of row.keys) {
        if (keyOwner.has(k)) union(keyOwner.get(k), i);
        else keyOwner.set(k, i);
      }
    });
    const groups = [];
    const groupByRoot = new Map();
    rows.forEach((row, i) => {
      const root = find(i);
      const x = row.book;
      const entry = { id: x.id, ext: x.ext, filename: x.filename, title: x.title };
      let g = groupByRoot.get(root);
      if (!g) {
        g = Object.assign(bookSummary(x, ctx2), {
          bookId: x.id, filename: x.filename, workKey: x.workKey || '',
          files: 0, books: []
        });
        groupByRoot.set(root, g);
        groups.push(g);
      }
      g.books.push(entry);
      g.files = g.books.length;
    });
    res.json({ items: groups });
  });

  // ============ 目录 ============
  r.get('/books/:id/toc', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    res.json({ toc: store.getToc(b.id), source: b.tocSource || '', at: b.tocAt || 0 });
  });

  r.post('/books/:id/toc', auth.requireAuth, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    // 前端上报（pdf.js outline / foliate toc）
    if (Array.isArray(req.body && req.body.toc) && req.body.toc.length) {
      const clean = req.body.toc.slice(0, 800).map(t => ({
        label: String(t.label || '').slice(0, 80),
        level: Math.max(1, Math.min(4, Number(t.level) || 1)),
        href: t.href ? String(t.href).slice(0, 300) : undefined,
        cfi: t.cfi ? String(t.cfi).slice(0, 300) : undefined,
        page: t.page ? Number(t.page) : 0,
        line: t.line != null ? Number(t.line) : undefined,
        idx: t.idx != null ? Number(t.idx) : undefined
      })).filter(t => t.label);
      store.setToc(b.id, clean, String((req.body && req.body.source) || 'client'));
      return res.json({ ok: true, toc: clean, source: req.body.source || 'client' });
    }
    const t = scanner.buildToc(b.id);
    res.json({ ok: true, toc: t.toc, source: t.source });
  }));

  // 媒体（旧版 PPTX 图片接口，保留兼容）
  r.get('/media/:name', auth.requireAuth, (req, res) => {
    const f = path.join(store.cacheDir, 'media', path.basename(req.params.name));
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Content-Type', MIME[path.extname(f).slice(1).toLowerCase()] || 'image/jpeg');
    streamFile(res, f);
  });

  // ============ 进度 / 书架 / 笔记 ============
  r.get('/progress/:bookId', auth.requireAuth, (req, res) => res.json({ progress: store.getProgress(req.user.id, req.params.bookId) }));
  r.post('/progress/:bookId', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.bookId);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const { cfi, page, pages, pct, pos, zoom } = req.body;
    store.setProgress(req.user.id, b.id, {
      cfi: cfi != null ? String(cfi) : undefined,
      page: page != null ? Number(page) : undefined,
      pages: pages != null ? Number(pages) : undefined,
      pct: pct != null ? Math.min(100, Math.max(0, Number(pct))) : undefined,
      pos: pos != null ? Number(pos) : undefined,
      zoom: zoom != null ? Number(zoom) : undefined
    });
    res.json({ ok: true });
  });

  r.get('/shelf', auth.requireAuth, (req, res) => {
    const ids = store.getShelf(req.user.id);
    const ctx2 = buildSummaryCtx(req.user.id);
    const items = ids.map(id => store.findBook(id)).filter(Boolean).map(b => bookSummary(b, ctx2));
    res.json({ ids, items });
  });

  // 书架首页三段数据：① 已加入书架 ② 近期阅读未加入书架 ③ 每日更换的随机推荐
  r.get('/shelf/home', auth.requireAuth, (req, res) => {
    const uid = req.user.id;
    const ctx2 = buildSummaryCtx(uid);
    const ids = store.getShelf(uid);
    const shelfSet = new Set(ids);
    const shelfItems = ids.map(id => store.findBook(id))
      .filter(b => b && b.status !== 'hidden');
    const shelfWorks = new Set(shelfItems.map(b => b.workKey).filter(Boolean));

    // ② 近期阅读但还没加入书架
    const recent = [];
    for (const h of store.getHistory(uid)) {
      if (recent.length >= 8) break;
      const b = store.findBook(h.bookId);
      if (!b || b.status === 'hidden') continue;
      if (shelfSet.has(b.id) || (b.workKey && shelfWorks.has(b.workKey))) continue;
      recent.push(Object.assign(bookSummary(b, ctx2), {
        lastReadAt: h.at,
        pct: (store.getProgress(uid, b.id) || {}).pct || 0
      }));
    }

    // ③ 每日随机推荐：同一天内容固定，次日自动更换
    const exclude = new Set([...shelfSet, ...recent.map(x => x.id),
      ...store.getHistory(uid).map(h => h.bookId)]);
    const recommend = dailyPicks(uid, 6, exclude, ctx2);

    res.json({
      date: localDay(),
      shelf: shelfItems.map(b => bookSummary(b, ctx2)),
      recent,
      recommend
    });
  });
  r.put('/shelf/:bookId', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.bookId);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const added = store.toggleShelf(req.user.id, b.id);
    res.json({ ok: true, added });
  });

  r.get('/books/:id/annotations', auth.requireAuth, (req, res) => {
    res.json({ annotations: store.getAnnotations(req.user.id, req.params.id) });
  });
  r.post('/books/:id/annotations', auth.requireAuth, (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const { type, cfi, page, pos, quote, note, color } = req.body;
    if (!['bookmark', 'highlight', 'note'].includes(type)) return res.status(400).json({ error: '类型不正确' });
    const a = store.addAnnotation(req.user.id, b.id, {
      type,
      cfi: cfi != null ? String(cfi) : undefined,
      page: page != null ? Number(page) : undefined,
      pos: pos != null ? Number(pos) : undefined,
      quote: quote != null ? String(quote).slice(0, 1000) : undefined,
      note: note != null ? String(note).slice(0, 2000) : undefined,
      color: color != null ? String(color) : undefined
    });
    res.json({ ok: true, annotation: a });
  });
  r.delete('/books/:id/annotations/:annId', auth.requireAuth, (req, res) => {
    res.json({ ok: store.removeAnnotation(req.user.id, req.params.id, req.params.annId) });
  });

  // ============ 统计 ============
  r.post('/reading/heartbeat', auth.requireAuth, (req, res) => {
    const bookId = String(req.body.bookId || '');
    if (!store.findBook(bookId)) return res.status(404).json({ error: '图书不存在' });
    if (req.body.opened) store.markOpened(req.user.id, bookId);
    const s = store.addReadingTime(req.user.id, bookId, req.body.seconds);
    res.json({ ok: true, totalSec: s ? s.totalSec : undefined });
  });

  r.get('/me/stats', auth.requireAuth, (req, res) => {
    const s = store.getStats(req.user.id);
    const history = store.getHistory(req.user.id).slice(0, 30).map(h => {
      const b = store.findBook(h.bookId);
      if (!b) return null;
      return { bookId: h.bookId, title: b.title, author: b.author, ext: b.ext, cover: !!b.coverExt, at: h.at, progress: store.getProgress(req.user.id, h.bookId) };
    }).filter(Boolean);
    const byBook = Object.entries(s.byBook || {}).map(([id, sec]) => {
      const b = store.findBook(id);
      return b ? { bookId: id, title: b.title, sec } : null;
    }).filter(Boolean).sort((a, c) => c.sec - a.sec).slice(0, 10);
    let annCount = 0;
    for (const arr2 of Object.values(store.data.annotations[req.user.id] || {})) annCount += arr2.length;
    const booksRead = new Set(store.getHistory(req.user.id).map(h => h.bookId)).size;
    // 1.6.0：已读完 = 手工点「读过」 ∪ 阅读进度达到 100%
    const finished = store.listFinished(req.user.id).map(f => ({
      bookId: f.book.id, title: f.book.title, author: f.book.author,
      ext: f.book.ext, cover: !!f.book.coverExt, at: f.at, manual: f.manual
    }));
    res.json({
      totalSec: s.totalSec || 0, opened: s.opened || 0, byDay: s.byDay || {},
      byBook, history, booksRead, finished,
      shelfCount: store.getShelf(req.user.id).length, annotationCount: annCount
    });
  });

  // 1.5.0：分类功能已下线（年份 / 格式筛选不再是「分类体系」的一部分），不再提供 /filters

  // ============ TTS ============
  r.get('/tts/config', auth.requireAuth, (req, res) => {
    const cfg = store.data.settings.tts || {};
    const enabled = cfg.enabled !== false;
    const en = enabled ? ttsLib.engines(cfg) : { list: [] };
    res.json({
      enabled,
      engine: cfg.engine || 'browser', rate: cfg.rate || 1, autoNext: cfg.autoNext !== false,
      engines: en.list,
      models: cfg.engine === 'openai' ? [cfg.openai.model || 'tts-1'] : (cfg.engine === 'azure' ? [cfg.azure.voice] : ['系统语音包']),
      serverSide: cfg.engine === 'openai' || cfg.engine === 'azure'
    });
  });

  r.post('/tts', auth.requireAuth, wrap(async (req, res) => {
    const cfg = JSON.parse(JSON.stringify(store.data.settings.tts || {}));
    if (cfg.enabled === false) return res.status(403).json({ error: '管理员已关闭语音朗读功能' });
    if (req.body && req.body.engine) cfg.engine = req.body.engine;
    if (cfg.engine === 'browser') return res.status(400).json({ error: '当前使用浏览器本地语音，无需服务端合成' });
    if (req.body && req.body.rate) cfg.rate = Number(req.body.rate);
    if (req.body && req.body.voice) {
      if (cfg.engine === 'openai') cfg.openai = Object.assign({}, cfg.openai, { voice: req.body.voice, model: req.body.model || cfg.openai.model });
      if (cfg.engine === 'azure') cfg.azure = Object.assign({}, cfg.azure, { voice: req.body.voice });
    }
    const out = await ttsLib.synthesize(String(req.body.text || ''), cfg, path.join(store.cacheDir, 'tts'));
    res.setHeader('Content-Type', out.type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    streamFile(res, out.file);
  }));

  // ============ AI ============
  function aiCfg() { return store.data.settings.ai || {}; }
  function requireAi() {
    const c = aiCfg();
    if (!c.enabled) { const e = new Error('管理员尚未开启 AI 功能'); e.status = 403; throw e; }
    if (!c.apiKey) { const e = new Error('管理员尚未配置 AI 接口'); e.status = 403; throw e; }
    return c;
  }

  // ============ AI（严格限制：只接收当前页片段，禁止上传整本书） ============
  const AI_LIMITS = { context: 1500, translate: 1500, historyItem: 400, historyTotal: 1200, question: 320, query: 200, body: 64 * 1024 };
  // HTTP 层：整本文本通常远超 64KB，直接挡在门外，连解析都不做
  r.use('/ai', (req, res, next) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > AI_LIMITS.body) return res.status(413).json({ error: '请求内容过大：AI 功能只接收当前页片段，禁止上传整本书内容', blocked: 'whole-book' });
    next();
  });
  function aiPayloadError(body, kind) {
    const b = body || {};
    if (kind === 'ask') {
      const ctx = String(b.context || '');
      if (ctx.length > AI_LIMITS.context) return `上下文 ${ctx.length} 字超过上限：AI 只允许使用当前页片段（≤${AI_LIMITS.context} 字），禁止上传整本书内容`;
      const hist = Array.isArray(b.history) ? b.history : [];
      const total = hist.reduce((n, h) => n + String((h && h.content) || '').length, 0);
      if (hist.some(h => String((h && h.content) || '').length > AI_LIMITS.historyItem) || total > AI_LIMITS.historyTotal) return '对话历史过长，AI 不接收整本书或长篇对话，请重新开始提问';
      if (String(b.question || '').length > AI_LIMITS.question) return `问题过长，请精简到 ${AI_LIMITS.question} 字以内`;
    }
    if (kind === 'translate') {
      const t = String(b.text || '');
      if (t.length > AI_LIMITS.translate) return `待翻译内容 ${t.length} 字超过上限：只允许翻译当前页片段（≤${AI_LIMITS.translate} 字），禁止上传整本书`;
    }
    if (kind === 'recommend' && String(b.query || '').length > AI_LIMITS.query) return `检索描述过长，请精简到 ${AI_LIMITS.query} 字以内`;
    return '';
  }

  r.get('/ai/config', auth.requireAuth, (req, res) => {
    const c = aiCfg();
    const q = store.aiQuota(req.user.id, Number(c.dailyLimit) || 40);
    res.json({
      enabled: !!c.enabled && !!c.apiKey,
      search: true,          // 1.8.1：本地全库检索始终可用，未配置 AI 也能找书
      features: { recommend: c.recommend !== false, ask: c.ask !== false, translate: c.translate !== false },
      quota: q, maxQuestionLength: ai.HARD_LIMIT, model: c.enabled ? c.model : ''
    });
  });

  r.post('/ai/ask', auth.requireAuth, wrap(async (req, res) => {
    const c = requireAi();
    const blocked = aiPayloadError(req.body, 'ask');
    if (blocked) return res.status(413).json({ error: blocked, blocked: 'whole-book' });
    if (c.ask === false) return res.status(403).json({ error: '管理员已关闭阅读问答功能' });
    const q = String((req.body && req.body.question) || '');
    const guard = ai.checkQuestion(q);
    // 越界/复杂问题直接拒绝，不消耗配额
    if (!guard.ok) return res.json({ refused: true, answer: guard.why, reason: guard.complex ? 'complex' : 'offtopic', quota: store.aiQuota(req.user.id, Number(c.dailyLimit) || 40) });

    const quota = store.aiQuota(req.user.id, Number(c.dailyLimit) || 40);
    if (quota.left <= 0) return res.status(429).json({ error: `今日 AI 额度已用完（${quota.limit} 次/天），明天再来吧`, quota });

    const book = req.body.bookId ? store.findBook(req.body.bookId) : null;
    if (!book) return res.status(404).json({ error: '请先打开一本书再提问' });
    const out = await ai.askAboutBook(c, {
      question: q, book,
      context: String((req.body && req.body.context) || '').slice(0, AI_LIMITS.context),
      history: (Array.isArray(req.body.history) ? req.body.history.slice(-4) : [])
        .map(h => ({ role: h.role, content: String(h.content || '').slice(0, AI_LIMITS.historyItem) }))
    });
    // 5 秒超时中断不扣配额
    const used = out.timeout ? Math.max(0, quota.limit - quota.left) : store.aiConsume(req.user.id);
    res.json(Object.assign({}, out, { quota: { used, limit: quota.limit, left: Math.max(0, quota.limit - used) } }));
  }));

  r.post('/ai/translate', auth.requireAuth, wrap(async (req, res) => {
    const c = requireAi();
    const blocked = aiPayloadError(req.body, 'translate');
    if (blocked) return res.status(413).json({ error: blocked, blocked: 'whole-book' });
    if (c.translate === false) return res.status(403).json({ error: '管理员已关闭翻译功能' });
    const quota = store.aiQuota(req.user.id, Number(c.dailyLimit) || 40);
    if (quota.left <= 0) return res.status(429).json({ error: '今日 AI 额度已用完', quota });
    const out = await ai.translate(c, { text: req.body.text, target: req.body.target });
    const used = store.aiConsume(req.user.id);
    res.json({ ok: true, text: out.text, quota: { used, limit: quota.limit, left: Math.max(0, quota.limit - used) } });
  }));

  r.post('/ai/recommend', auth.requireAuth, wrap(async (req, res) => {
    // 1.8.1：找书不再强依赖 AI —— 本地全库检索始终可用，AI 只做重排
    const c = aiCfg();
    const blocked = aiPayloadError(req.body, 'recommend');
    if (blocked) return res.status(413).json({ error: blocked, blocked: 'whole-book' });
    if (c.recommend === false) return res.status(403).json({ error: '管理员已关闭书库推荐功能' });
    const q = String((req.body && req.body.query) || '').trim();
    if (!q) return res.status(400).json({ error: '请输入你想找的内容' });
    const limit = Math.min(12, Math.max(1, Number(req.body.limit) || 8));
    const cfgLimit = Number(c.dailyLimit) || 40;
    let quota = store.aiQuota(req.user.id, cfgLimit);

    // ① 本地全库召回：不依赖 AI、不消耗额度，2000 本也一次搜完
    const pool = store.books.filter(b => b.status !== 'hidden');
    const local = booksearch.search(pool, q, 40, p => meta.dirNames(p));
    if (!local.items.length) {
      return res.json({
        items: [], mode: 'local', matched: 0, quota,
        hint: '书库里没有匹配的书。可以换个说法，或者只保留关键词（比如「近代史」而不是整句描述）。'
      });
    }
    const ctx = buildSummaryCtx(req.user.id);
    const localReason = it => {
      const kw = booksearch.readKeywords(it.hits);
      return kw.length ? '命中「' + kw.join('」「') + '」' : '书名或简介相关';
    };
    const localItems = () => local.items.slice(0, limit).map(it =>
      Object.assign(bookSummary(it.book, ctx), { reason: localReason(it) }));

    // ② AI 重排（只在配置了 AI 且还有额度时；失败/超时/挑不出就退回本地结果）
    const aiReady = !!(c.enabled && c.apiKey);
    if (!aiReady || quota.left <= 0) {
      return res.json({ items: localItems(), mode: 'local', matched: local.matched, quota });
    }
    try {
      const out = await ai.recommend(c, {
        query: q, limit,
        candidates: local.items.map(it => ({
          id: it.book.id, title: it.book.title, author: it.book.author,
          description: it.book.description, ext: it.book.ext
        }))
      });
      if (out.items && out.items.length) {
        const used = store.aiConsume(req.user.id);
        const byId = new Map(local.items.map(it => [it.book.id, it]));
        const items = out.items.map(x => {
          const b = store.findBook(x.id);
          if (!b) return null;
          const src = byId.get(x.id);
          return Object.assign(bookSummary(b, ctx), {
            reason: x.reason || (src ? localReason(src) : '与你的描述相关')
          });
        }).filter(Boolean);
        if (items.length) {
          quota = { used, limit: quota.limit, left: Math.max(0, quota.limit - used) };
          return res.json({ items, mode: 'ai', matched: local.matched, quota });
        }
      }
      return res.json({ items: localItems(), mode: 'local', matched: local.matched, quota, note: 'AI 没有给出更贴合的排序，已按本地检索结果返回' });
    } catch (e) {
      return res.json({
        items: localItems(), mode: 'local', matched: local.matched, quota,
        note: (e && e.timeout) ? 'AI 响应超时，已按本地检索结果返回' : ('AI 暂不可用（' + (e && e.message ? String(e.message).slice(0, 60) : '未知错误') + '），已按本地检索结果返回')
      });
    }
  }));

  // ============ 管理员 ============
  const admin = [auth.requireAuth, auth.requireAdmin];

  r.get('/settings', ...admin, (req, res) => {
    const s = JSON.parse(JSON.stringify(store.data.settings));
    if (s.smtp && s.smtp.pass) s.smtp.pass = '******';
    if (s.ai && s.ai.apiKey) s.ai.apiKey = '******';
    if (s.tts && s.tts.openai && s.tts.openai.apiKey) s.tts.openai.apiKey = '******';
    if (s.tts && s.tts.azure && s.tts.azure.key) s.tts.azure.key = '******';
    res.json({
      settings: s,
      storage: { dataDir: store.dataDir, appDir: process.env.APP_ROOT || '', cacheDir: store.cacheDir, trashDir: store.trashDir },
      exts: meta.BOOK_EXTS,          // 1.8.0：可选的后缀清单（后台用来勾选「不入库」）
      providers: Object.values(scrape.PROVIDERS),
      // 1.9.0：二级路径访问的反代配置参考（飞牛 5667 页面下以 /fnbookshelf 进入）
      proxy: {
        basePath: (s.app && s.app.basePath) || '',
        port: parseInt(process.env.PORT) || 8096,
        snippet: [
          '# 把下面这段放进飞牛自带 nginx 的 server { } 里（443 / 5667 那个），然后 nginx -s reload',
          '# 之后就能用 https://<NAS 地址>:5667' + ((s.app && s.app.basePath) || '/fnbookshelf') + '/ 打开书屋',
          'location ' + ((s.app && s.app.basePath) || '/fnbookshelf') + '/ {',
          '    proxy_pass https://127.0.0.1:' + (parseInt(process.env.PORT) || 8096) + '/;',
          '    proxy_http_version 1.1;',
          '    proxy_set_header Host $host;',
          '    proxy_set_header X-Forwarded-Proto $scheme;',
          '    proxy_set_header Upgrade $http_upgrade;',
          '    proxy_set_header Connection "upgrade";',
          '    proxy_ssl_verify off;      # 应用默认是自签名证书',
          '    proxy_read_timeout 3600s;  # 大文件下载 / 阅读长连接',
          '    client_max_body_size 512m; # 上传 APK、PPT 截图',
          '}'
        ].join('\n')
      }
    });
  });

  r.put('/settings', ...admin, (req, res) => {
    const s = store.data.settings;
    const b = req.body || {};
    if (b.siteName) s.siteName = String(b.siteName).slice(0, 30);
    if (b.registerMode !== undefined) s.registerMode = ['auto', 'approve', 'closed'].includes(b.registerMode) ? b.registerMode : 'auto';
    if (b.smtp) {
      for (const k of ['host', 'user', 'from']) if (b.smtp[k] !== undefined) s.smtp[k] = String(b.smtp[k]).trim();
      if (b.smtp.port !== undefined) s.smtp.port = Number(b.smtp.port) || 465;
      if (b.smtp.secure !== undefined) s.smtp.secure = !!b.smtp.secure;
      if (b.smtp.pass && b.smtp.pass !== '******') s.smtp.pass = String(b.smtp.pass);
    }
    if (b.scrape) {
      s.scrape.enabled = !!b.scrape.enabled;
      if (Array.isArray(b.scrape.providers)) {
        const ok = b.scrape.providers.filter(p => scrape.PROVIDERS[p]);
        s.scrape.providers = ok.length ? ok : ['douban'];
        s.scrape.provider = s.scrape.providers[0];
      } else if (b.scrape.provider && scrape.PROVIDERS[b.scrape.provider]) {
        s.scrape.provider = b.scrape.provider;
        if (!s.scrape.providers.includes(b.scrape.provider)) s.scrape.providers.unshift(b.scrape.provider);
      }
      if (b.scrape.refine !== undefined) s.scrape.refine = !!b.scrape.refine;
      if (b.scrape.cover !== undefined) s.scrape.cover = !!b.scrape.cover;
      if (b.scrape.timeout !== undefined) s.scrape.timeout = Math.max(4000, Math.min(30000, Number(b.scrape.timeout) || 12000));
    }
    if (b.tts) {
      const t = b.tts;
      if (t.enabled !== undefined) s.tts.enabled = !!t.enabled;
      if (['browser', 'openai', 'azure'].includes(t.engine)) s.tts.engine = t.engine;
      if (t.rate !== undefined) s.tts.rate = Math.max(0.5, Math.min(2.5, Number(t.rate) || 1));
      if (t.autoNext !== undefined) s.tts.autoNext = !!t.autoNext;
      if (t.openai) {
        for (const k of ['baseUrl', 'model', 'voice']) if (t.openai[k] !== undefined) s.tts.openai[k] = String(t.openai[k]).trim();
        if (t.openai.apiKey && t.openai.apiKey !== '******') s.tts.openai.apiKey = String(t.openai.apiKey);
      }
      if (t.azure) {
        for (const k of ['region', 'voice']) if (t.azure[k] !== undefined) s.tts.azure[k] = String(t.azure[k]).trim();
        if (t.azure.key && t.azure.key !== '******') s.tts.azure.key = String(t.azure.key);
      }
    }
    if (b.ai) {
      const a = b.ai;
      if (a.enabled !== undefined) s.ai.enabled = !!a.enabled;
      for (const k of ['baseUrl', 'model']) if (a[k] !== undefined) s.ai[k] = String(a[k]).trim();
      if (a.apiKey && a.apiKey !== '******') s.ai.apiKey = String(a.apiKey);
      if (a.dailyLimit !== undefined) s.ai.dailyLimit = Math.max(0, Math.min(2000, Number(a.dailyLimit) || 0));
      if (a.maxTokens !== undefined) s.ai.maxTokens = Math.max(100, Math.min(1200, Number(a.maxTokens) || 600));
      if (a.temperature !== undefined) s.ai.temperature = Math.max(0, Math.min(1.2, Number(a.temperature) || 0.3));
      for (const k of ['recommend', 'ask', 'translate', 'strict']) if (a[k] !== undefined) s.ai[k] = !!a[k];
    }
    if (b.reader && typeof b.reader === 'object') {
      s.reader = {};
      const keys = ['fontSize', 'lineHeight', 'theme', 'bg', 'texture', 'rate'];
      for (const k of keys) if (b.reader[k] !== undefined) s.reader[k] = b.reader[k];
    }
    // 1.8.0 书库：不入库的后缀
    if (b.library && typeof b.library === 'object') {
      const lib = s.library || (s.library = { excludeExts: [] });
      if (Array.isArray(b.library.excludeExts)) {
        const clean = [...new Set(b.library.excludeExts
          .map(x => String(x || '').toLowerCase().replace(/^\./, '').trim())
          .filter(x => /^[a-z0-9]{1,10}$/.test(x)))];
        lib.excludeExts = clean;
      }
      if (Array.isArray(b.library.includeExts)) {
        // 反向写法（前端传「要入库的后缀」）：转换成排除名单
        const inc = new Set(b.library.includeExts.map(x => String(x || '').toLowerCase().replace(/^\./, '')));
        lib.excludeExts = meta.BOOK_EXTS.filter(e => !inc.has(e));
      }
      store.logAudit(req, 'settings.library', lib.excludeExts.join(','));
    }
    // 1.7.0 安全选项
    if (b.security && typeof b.security === 'object') {
      const sec = s.security || (s.security = { tokenTtlHours: 24, collaborativeLibrary: false, frameAncestors: '' });
      if (b.security.tokenTtlHours !== undefined) {
        sec.tokenTtlHours = Math.max(1, Math.min(168, Number(b.security.tokenTtlHours) || 24));
      }
      if (b.security.collaborativeLibrary !== undefined) sec.collaborativeLibrary = !!b.security.collaborativeLibrary;
      if (b.security.frameAncestors !== undefined) {
        const list = String(b.security.frameAncestors || '').split(/\s+/)
          .filter(x => x && /^(?:https?:\/\/[a-z0-9.\-:\[\]*]+|'self'|'none')$/i.test(x));
        sec.frameAncestors = list.join(' ').slice(0, 300);
      }
      store.logAudit(req, 'settings.security', '', sec);
    }
    // 1.9.0：二级路径访问前缀（保存后需重启应用生效）
    if (b.app && typeof b.app === 'object') {
      const a = s.app || (s.app = { basePath: '/fnbookshelf', phone: null, tv: null });
      if (b.app.basePath !== undefined) {
        const raw = String(b.app.basePath || '').trim();
        const clean = raw && raw !== '/' ? '/' + raw.replace(/^\/+/, '').replace(/\/+$/, '') : '';
        if (clean && !/^\/[A-Za-z0-9._~\-/]{1,60}$/.test(clean)) {
          return res.status(400).json({ error: '二级路径只能用字母、数字与 - _ . /，例如 /fnbookshelf' });
        }
        a.basePath = clean;
      }
      store.logAudit(req, 'settings.app', a.basePath || '');
    }
    store.save(); store.flushNow().catch(() => {});
    const out = JSON.parse(JSON.stringify(store.data.settings));
    if (out.smtp.pass) out.smtp.pass = '******';
    if (out.ai.apiKey) out.ai.apiKey = '******';
    if (out.tts.openai.apiKey) out.tts.openai.apiKey = '******';
    if (out.tts.azure.key) out.tts.azure.key = '******';
    res.json({ ok: true, settings: out, restartHttps: b.https !== undefined });
  });

  r.post('/settings/smtp-test', ...admin, wrap(async (req, res) => {
    const to = String(req.body.to || req.user.email).trim();
    const s = store.data.settings;
    const cfg = Object.assign({}, s.smtp);
    if (req.body.pass && req.body.pass !== '******') cfg.pass = String(req.body.pass);
    await sendTest(cfg, to, s.siteName);
    res.json({ ok: true });
  }));

  // TTS 连通性测试
  r.post('/settings/tts-test', ...admin, wrap(async (req, res) => {
    const cfg = JSON.parse(JSON.stringify(store.data.settings.tts));
    const out = await ttsLib.synthesize(String(req.body.text || '飞牛书屋语音朗读测试'), cfg, path.join(store.cacheDir, 'tts'));
    res.setHeader('Content-Type', out.type);
    res.setHeader('X-Cache', out.cached ? 'hit' : 'miss');
    streamFile(res, out.file);
  }));

  // AI 连通性测试
  r.post('/settings/ai-test', ...admin, wrap(async (req, res) => {
    const c = store.data.settings.ai;
    const out = await ai.chat(c, [
      { role: 'system', content: '你是测试助手，只回复：连接成功' },
      { role: 'user', content: 'ping' }
    ], { maxTokens: 20 });
    res.json({ ok: true, reply: out.content.slice(0, 200), model: out.model, usage: out.usage, quotaToday: store.aiTodayTotal() });
  }));

  // 数据目录迁移（把数据从系统盘搬到 NAS 上的应用目录，可跨盘）
  r.post('/storage/move', ...admin, wrap(async (req, res) => {
    const target = String((req.body && req.body.dir) || '').trim();
    if (!target || !path.isAbsolute(target)) return res.status(400).json({ error: '请输入绝对路径，例如 /vol1/1000/apps/fnbookshelf-data' });
    if (path.resolve(target) === path.resolve(store.dataDir)) return res.status(400).json({ error: '与当前数据目录相同' });
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.accessSync(target, fs.constants.W_OK);
    } catch (e) { return res.status(400).json({ error: '目标目录不可写：' + e.message }); }

    const copyDir = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from)) {
        const s = path.join(from, f), d = path.join(to, f);
        const st = fs.statSync(s);
        if (st.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
      }
    };
    try {
      if (fs.existsSync(store.file)) fs.copyFileSync(store.file, path.join(target, 'data.json'));
      for (const sub of ['covers', 'certs']) {
        const from = sub === 'covers' ? store.coversDir : store.certsDir;
        if (fs.existsSync(from)) copyDir(from, path.join(target, sub));
      }
    } catch (e) { return res.status(500).json({ error: '复制数据失败：' + e.message }); }

    // 写入位置指针，重启后生效
    const pointer = process.env.APP_ROOT
      ? path.join(process.env.APP_ROOT, 'etc', 'data_dir')
      : path.join(__dirname, '..', '..', '..', '.datadir');
    try {
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      fs.writeFileSync(pointer, target);
    } catch (e) { return res.status(500).json({ error: '无法写入数据目录配置：' + e.message }); }
    res.json({ ok: true, dataDir: target, requiresRestart: true, pointer });
  }));

  // 1.6.3：下载自检（返回一个小附件，用于判断是不是浏览器/沙箱拦了下载）
  r.get('/system/download-test', ...admin, (req, res) => {
    const body = Buffer.from('飞牛书屋 下载测试 OK\n时间：' + new Date().toLocaleString('zh-CN') + '\n', 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('飞牛书屋-下载测试.txt')}`);
    res.setHeader('Content-Length', body.length);
    res.end(body);
  });

  // 1.6.3：存储自检 / 权限修复（封面 EACCES 崩溃的善后与自查入口）
  r.get('/system/storage', ...admin, (req, res) => {
    try { res.json(store.audit()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post('/system/storage/repair', ...admin, (req, res) => {
    try { res.json(store.repair()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 路径
  r.get('/paths', ...admin, (req, res) => res.json({ paths: store.data.settings.paths }));
  r.post('/paths', ...admin, (req, res) => {
    const p = String(req.body.path || '').trim();
    if (!p || !path.isAbsolute(p)) return res.status(400).json({ error: '请输入绝对路径，例如 /vol1/1000/books' });
    try { fs.accessSync(p); } catch (e) { return res.status(400).json({ error: `路径不可访问（${e.message}）。请确认目录存在且应用有权限读取` }); }
    if (store.data.settings.paths.some(x => x.path === p)) return res.status(400).json({ error: '该路径已存在' });
    store.data.settings.paths.push({ id: crypto.randomUUID(), path: p, enabled: true, addedAt: Date.now() });
    store.save();
    res.json({ ok: true, paths: store.data.settings.paths });
  });
  r.delete('/paths/:id', ...admin, (req, res) => {
    store.data.settings.paths = store.data.settings.paths.filter(x => x.id !== req.params.id);
    store.save();
    res.json({ ok: true, paths: store.data.settings.paths });
  });
  r.put('/paths/:id', ...admin, (req, res) => {
    const p = store.data.settings.paths.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '路径不存在' });
    if (req.body.enabled !== undefined) p.enabled = !!req.body.enabled;
    store.save();
    res.json({ ok: true, paths: store.data.settings.paths });
  });

  // 扫描
  r.post('/scan', ...admin, (req, res) => res.json(scanner.scan({ force: !!(req.body && req.body.force) })));
  r.get('/scan/status', ...admin, (req, res) => res.json(scanner.getStatus()));

  // 1.9.0：管理后台「开始刮削」——对未刮削 / 之前失败的书继续补全（不动已完成的）
  r.post('/scrape/start', ...admin, (req, res) => {
    try {
      const out = scanner.startScrape();
      if (out.error) return res.status(400).json({ error: out.error });
      // 后台队列自己会挑 pending 的书；手动开跑时把间隔缩短，别让 3 万本等到天荒地老
      if (runtime && runtime.scraper && runtime.scraper.startCatchUp) runtime.scraper.startCatchUp(3600 * 1000);
      res.json(Object.assign({ ok: true }, out));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ 系统日志 / 崩溃取证 ============
  // 日志仅保存在本机，不发送邮件；SMTP 只用于登录验证码。
  r.get('/logs', ...admin, (req, res) => {
    log.flush(); // 保证后台看到的是最新日志
    res.json({
      keepDays: 2,
      files: log.listFiles(),
      lines: log.readLines(Number(req.query.limit) || 120),
      errors: log.errorSummary(20),
      crash: log.readCrash(),
      progress: log.readProgress(),
      autoScan: runtime && runtime.schedule ? runtime.schedule.status() : (store.data.settings.autoScan || null),
      scan: scanner.getStatus(),
      scrapeWorker: runtime && runtime.scraper ? runtime.scraper.status() : null,
      convertWorker: runtime && runtime.converter ? { active: runtime.converter.list().filter(j => j.state === 'running' || j.state === 'queued').length, jobs: runtime.converter.list().slice(-5) } : null
    });
  });

  // ============ 定时扫描 / 刮削（1.9.1 起归到「扫描与刮削」设置） ============
  const scheduleReady = () => runtime && runtime.schedule ? runtime.schedule : null;
  r.get('/scan/schedule', ...admin, (req, res) => {
    const sc = scheduleReady();
    res.json({ autoScan: sc ? sc.status() : (scheduler.normalize(store.data.settings.autoScan)), scan: scanner.getStatus() });
  });
  r.put('/scan/schedule', ...admin, (req, res) => {
    const sc = scheduleReady();
    if (!sc) return res.status(503).json({ error: '调度服务尚未就绪' });
    const b = req.body || {};
    const patch = {};
    ['enabled', 'every', 'interval', 'at', 'hour', 'minute', 'weekdays', 'monthDay', 'scrape'].forEach(k => {
      if (b[k] !== undefined) patch[k] = b[k];
    });
    if (patch.at && /^\d{1,2}:\d{2}$/.test(String(patch.at))) {
      const [hh, mm] = String(patch.at).split(':');
      patch.hour = Number(hh); patch.minute = Number(mm);
    }
    const st = sc.configure(patch);
    log.info('scan', `管理员 ${req.user.email} 更新定时扫描：${st.enabled ? '启用' : '停用'} · ${st.every} 每 ${st.interval} · ${st.at} · 自动刮削${st.scrape ? '开' : '关'}`);
    res.json({ ok: true, autoScan: st });
  });
  // 兼容旧前端：/logs/auto-scan
  r.post('/logs/auto-scan', ...admin, wrap(async (req, res) => {
    const sc = scheduleReady();
    if (!sc) return res.status(503).json({ error: '调度服务尚未就绪' });
    const out = await sc.trigger('手动触发');
    res.json({ ok: true, message: out && out.message, autoScan: sc.status() });
  }));
  r.put('/logs/auto-scan', ...admin, (req, res) => {
    const sc = scheduleReady();
    const b = req.body || {};
    if (sc) {
      const st = sc.configure(b);
      res.json({ ok: true, autoScan: st });
    } else {
      const s = store.data.settings.autoScan || (store.data.settings.autoScan = { enabled: true });
      if (b.enabled !== undefined) s.enabled = !!b.enabled;
      store.save();
      res.json({ ok: true, autoScan: scheduler.normalize(s) });
    }
  });

  // 用户
  r.get('/users', ...admin, (req, res) => res.json({ users: store.users.map(publicUser) }));
  r.get('/stats/users', ...admin, (req, res) => {
    const list = store.users.map(u => {
      const s = store.getStats(u.id);
      const hist = store.getHistory(u.id);
      return {
        id: u.id, email: u.email, role: u.role, status: u.status,
        totalSec: s.totalSec || 0, opened: s.opened || 0,
        books: Object.keys(s.byBook || {}).length,
        lastReadAt: hist.length ? hist[0].at : 0,
        lastBook: hist.length ? (store.findBook(hist[0].bookId) || {}).title || '' : '',
        aiToday: (store.data.aiUsage[u.id] || {})[new Date().toISOString().slice(0, 10)] || 0
      };
    }).sort((a, b) => b.totalSec - a.totalSec);
    res.json({ users: list, aiTodayTotal: store.aiTodayTotal(), pendingDeletions: store.countPendingDeletions() });
  });
  r.put('/users/:id', ...admin, (req, res) => {
    const u = store.users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const body = req.body || {};
    if (u.id === req.user.id && body.role === 'user') return res.status(400).json({ error: '不能撤销自己的管理员权限' });
    let changed = false;
    let sessionChanged = false;
    if (body.role && ['admin', 'user'].includes(body.role) && body.role !== u.role) { u.role = body.role; changed = true; sessionChanged = true; }
    if (body.status && ['active', 'disabled', 'pending'].includes(body.status)) {
      if (u.id === req.user.id && body.status !== 'active') return res.status(400).json({ error: '不能禁用自己' });
      if (body.status !== u.status) { u.status = body.status; changed = true; sessionChanged = true; }
    }
    // 1.7.0：改角色 / 禁用 / 重新启用都会让该用户已签发的令牌立即失效，管理员可强制踢下线
    if (sessionChanged) u.tokenVer = Number(u.tokenVer || 0) + 1;
    store.save();
    if (changed) store.logAudit(req, 'user.update', u.email, { role: u.role, status: u.status, tokenVer: u.tokenVer });
    res.json({ ok: true, user: publicUser(u) });
  });
  r.delete('/users/:id', ...admin, (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
    const gone = store.users.find(x => x.id === req.params.id);
    store.data.users = store.users.filter(x => x.id !== req.params.id || x.id === req.user.id);
    delete store.data.progress[req.params.id];
    store.save();
    store.logAudit(req, 'user.delete', (gone && gone.email) || req.params.id);
    res.json({ ok: true });
  });

  // 敏感操作留痕（管理员）
  r.get('/logs/audit', ...admin, (req, res) => {
    res.json({ items: store.listAudit(Number(req.query.limit) || 200) });
  });

  // 单本刮削 / 候选探查 / 采用指定候选
  r.post('/books/:id/rescrape', ...admin, wrap(async (req, res) => {
    const body = req.body || {};
    if (body.apply && typeof body.apply === 'object') {
      const b = store.findBook(req.params.id);
      if (!b) return res.status(404).json({ error: '图书不存在' });
      const updated = await scanner.applyScrape(b, body.apply, { provider: body.apply.provider, score: body.apply.score });
      return res.json({ ok: true, book: updated });
    }
    const dryRun = !!body.dryRun;
    const out = await scanner.rescrape(req.params.id, {
      dryRun,
      refine: body.refine,
      providers: body.providers,
      // 1.9.2：用户指定的书名优先，直接按这个名字刮，不再走目录名/正文抽样
      keyword: body.keyword ? String(body.keyword).slice(0, 80) : ''
    });
    if (dryRun) {
      if (!out.ok) return res.json({ ok: false, candidates: out.candidates || [], hints: out.hints || null, tried: out.tried });
      return res.json({ ok: true, candidate: out.data, provider: out.provider, score: out.score, refined: !!out.refined, candidates: out.candidates || [] });
    }
    res.json({ ok: true, book: out });
  }));

  // 抽样分析（管理员查看前 10 页抽到的线索）
  r.post('/books/:id/sample', ...admin, wrap(async (req, res) => {
    const b = store.findBook(req.params.id);
    if (!b) return res.status(404).json({ error: '图书不存在' });
    const text = sample.sampleText(b.path, b.ext, Number(req.body && req.body.pages) || 10);
    const hints = sample.extractHints(text, { title: b.title, author: b.author });
    res.json({ hints, preview: text.slice(0, 1200) });
  }));

  // 统计
  r.get('/stats', auth.requireAuth, (req, res) => {
    const books = store.books;
    const progress = store.data.progress[req.user.id] || {};
    const ctxS = buildSummaryCtx(req.user.id);
    const recent = Object.entries(progress).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 12)
      .map(([id]) => { const b = store.findBook(id); return b ? bookSummary(b, ctxS) : null; }).filter(Boolean);
    res.json({
      totalBooks: books.length, totalUsers: store.users.length,
      formats: [...new Set(books.map(b => b.ext))].length,
      authors: new Set(books.map(b => b.author)).size, recent
    });
  });

  return r;
};
