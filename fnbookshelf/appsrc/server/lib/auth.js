// 邮箱验证码认证（无密码登录）+ 会话令牌
//
// 令牌设计（1.7.0 安全加固）：
//   base64url({uid, exp, ver, jti, iat}).HMAC-SHA256
//   - exp：默认 24 小时（可在管理后台 1–168 小时之间调整），到期必须重新登录
//   - ver：用户会话版本号，改角色/禁用/「退出所有设备」时自增，旧令牌立即失效
//   - jti：单次令牌 ID，「退出登录」时写入短期黑名单
//
// 验证码校验是登录与注册的**前置硬条件**：没有未过期的 challenge 一律拒绝，
// 绝不允许「没发过验证码也能注册」。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function b64urlDecode(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }

const DEFAULT_TTL_HOURS = 24;
const CODE_TTL = 10 * 60 * 1000;      // 验证码 10 分钟
const CODE_RESEND = 60 * 1000;        // 同邮箱 60 秒冷却
const CODE_TRIES = 5;                 // 同邮箱最多试 5 次

/**
 * 允许用「查询串令牌」访问的只读资源白名单。
 * 共同点：它们都由浏览器自己发起、无法附加 Authorization 头
 * （<img src>、<audio src>、pdf.js 的取页请求、<a download> 下载、PPT 内嵌图）。
 * 任何其它接口（/me、/books、/settings…）必须走请求头，防止令牌外泄到日志/历史。
 */
const QUERY_TOKEN_ROUTES = [
  /^\/api\/cover\/[^/]+$/,                                    // 封面 <img>
  /^\/api\/collection-cover\/[^/]+$/,                         // 专题封面 <img>
  /^\/api\/books\/[^/]+\/file$/,                              // 原文件：下载 / pdf.js / 文本
  /^\/api\/books\/[^/]+\/slides$/,                            // PPT 逐页模型（内含内嵌图地址）
  /^\/api\/books\/[^/]+\/slidepdf$/,                          // 图片版 PDF
  /^\/api\/books\/[^/]+\/page-image$/,                        // CBZ 书内某一页
  /^\/api\/books\/[^/]+\/neighbor-image$/,                    // 封面候选预览
  /^\/api\/books\/[^/]+\/cbz\/\d+$/,                          // CBZ 逐页
  /^\/api\/slidesmedia\/[^/]+\/[^/]+$/,                       // PPT 页面内嵌图
  /^\/api\/media\/[^/]+$/,                                    // 旧版 PPTX 图片接口
  /^\/api\/system\/download-test$/                            // 「测试下载」按钮：需要能被新窗口直开（仅管理员）
];

class Auth {
  constructor(store, dataDir) {
    this.store = store;
    this.keyFile = path.join(dataDir, 'secret.key');
    try {
      this.key = fs.readFileSync(this.keyFile);
      if (!this.key || this.key.length < 32) throw new Error('weak');
    } catch (_) {
      this.key = crypto.randomBytes(32);
      try { fs.writeFileSync(this.keyFile, this.key, { mode: 0o600 }); } catch (_) {}
    }
    // 令牌签名与「媒体访问签名」用不同派生密钥，互不影响
    this.mediaKey = crypto.createHmac('sha256', this.key).update('media-v1').digest();
    this.codes = new Map();                 // email -> {code, expires, sentAt, tries}
    this.revoked = new Map();               // jti -> 失效时间戳
  }

  isEmailValid(email) {
    return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /** 令牌有效期（毫秒），可由管理员在设置里调整 */
  get ttlMs() {
    const h = Number(((this.store.data.settings.security || {}).tokenTtlHours) || DEFAULT_TTL_HOURS);
    return Math.max(1, Math.min(168, h)) * 3600 * 1000;
  }

  // ---------- 验证码 ----------
  /** 生成并暂存验证码；同邮箱 60 秒内重复请求会被拒（429） */
  issueCode(email) {
    email = String(email).trim().toLowerCase();
    const prev = this.codes.get(email);
    const now = Date.now();
    if (prev && prev.sentAt && now - prev.sentAt < CODE_RESEND) {
      const wait = Math.ceil((CODE_RESEND - (now - prev.sentAt)) / 1000);
      const err = new Error(`发送过于频繁，请 ${wait} 秒后重试`);
      err.status = 429;
      err.retryAfter = wait;
      throw err;
    }
    const code = String(crypto.randomInt(100000, 1000000));
    this.codes.set(email, { code, expires: now + CODE_TTL, sentAt: now, tries: 0 });
    return code;
  }

  hasChallenge(email) {
    email = String(email).trim().toLowerCase();
    const rec = this.codes.get(email);
    if (!rec) return false;
    if (Date.now() > rec.expires) { this.codes.delete(email); return false; }
    return true;
  }

  /**
   * 只校验验证码本身，不要求账号已存在。
   * 校验通过后立即作废该验证码（一次性）。
   */
  checkCode(email, code) {
    email = String(email).trim().toLowerCase();
    const rec = this.codes.get(email);
    if (!rec) { const e = new Error('请先获取验证码'); e.status = 400; throw e; }
    if (Date.now() > rec.expires) {
      this.codes.delete(email);
      const e = new Error('验证码已过期，请重新获取'); e.status = 400; throw e;
    }
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries > CODE_TRIES) {
      this.codes.delete(email);
      const e = new Error('错误次数过多，请重新获取验证码'); e.status = 429; e.retryAfter = 600; throw e;
    }
    // 定长比较，避免时序侧信道
    const a = Buffer.from(String(code == null ? '' : code).trim());
    const b = Buffer.from(rec.code);
    const same = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!same) {
      const left = CODE_TRIES - rec.tries;
      const e = new Error(left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码错误');
      e.status = 400;
      throw e;
    }
    this.codes.delete(email);
    return true;
  }

  /** 兼容旧调用：校验验证码并要求账号已存在且可用 */
  verifyCode(email, code) {
    this.checkCode(email, code);
    email = String(email).trim().toLowerCase();
    const user = this.store.findUserByEmail(email);
    if (!user) { const e = new Error('该邮箱尚未注册，请先注册'); e.status = 403; throw e; }
    if (user.status !== 'active') { const e = new Error('账号已被禁用，请联系管理员'); e.status = 403; throw e; }
    return user;
  }

  // ---------- 令牌 ----------
  signToken(user) {
    const now = Date.now();
    const payload = {
      uid: user.id,
      exp: now + this.ttlMs,
      iat: now,
      ver: Number(user.tokenVer || 0),
      jti: crypto.randomBytes(12).toString('hex')
    };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', this.key).update(body).digest());
    return body + '.' + sig;
  }

  /** 解出令牌载荷（校验签名与有效期），不查用户 */
  decodeToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = b64url(crypto.createHmac('sha256', this.key).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(b64urlDecode(body));
      if (!payload || typeof payload.uid !== 'string') return null;
      if (!payload.exp || Date.now() > payload.exp) return null;
      return payload;
    } catch (_) { return null; }
  }

  verifyToken(token) {
    const payload = this.decodeToken(token);
    if (!payload) return null;
    if (payload.jti && this.revoked.has(payload.jti)) return null;
    const user = this.store.data.users.find(u => u.id === payload.uid);
    if (!user) return null;
    if (user.status !== 'active') return null;                       // 禁用账号的旧令牌立即失效
    if (Number(user.tokenVer || 0) !== Number(payload.ver || 0)) return null;  // 会话版本已变（退出所有设备/改角色）
    user.lastSeenAt = Date.now();
    return user;
  }

  /** 单令牌吊销（退出登录）；黑名单按令牌到期时间自动清理 */
  revoke(token) {
    const payload = this.decodeToken(token);
    if (!payload) return false;
    const ttl = Math.max(0, payload.exp - Date.now());
    this.revoked.set(payload.jti, Date.now() + ttl);
    this.sweepRevoked();
    return true;
  }

  /** 使某用户全部已签发令牌失效（「退出所有设备」/ 禁用 / 改角色） */
  revokeAllFor(user) {
    if (!user) return 0;
    user.tokenVer = Number(user.tokenVer || 0) + 1;
    user.sessionRevokedAt = Date.now();
    try { this.store.save(); } catch (_) {}
    return user.tokenVer;
  }

  sweepRevoked() {
    const now = Date.now();
    for (const [jti, until] of this.revoked) if (until <= now) this.revoked.delete(jti);
  }

  /** 令牌剩余寿命不足一半时，由响应头下发新令牌（滑动续期，避免用着用着突然掉线） */
  shouldRefresh(payload) {
    if (!payload || !payload.exp) return false;
    return payload.exp - Date.now() < this.ttlMs / 2;
  }

  // ---------- Express 中间件 ----------
  middleware() {
    return (req, res, next) => {
      let token = req.get('Authorization') || '';
      let via = 'header';
      if (token.startsWith('Bearer ')) token = token.slice(7);
      if (!token && req.query.token) {
        // 1.7.1：查询串令牌只放行「浏览器无法加请求头」的只读资源
        //   —— <img src>、<audio src>、pdf.js 取页、<a download> 下载、PPT 内嵌图。
        // 其余接口（含 /api/me、/api/books、设置等）一律只认 Authorization 头，
        // 避免令牌出现在访问日志、浏览器历史、Referer 与截图里。
        const method = String(req.method || 'GET').toUpperCase();
        const allowQueryPost = req.path === '/api/reading/heartbeat';   // sendBeacon 兜底（页面卸载时无法加头）
        const allowQueryPath = QUERY_TOKEN_ROUTES.some(re => re.test(req.path));
        if (((method === 'GET' || method === 'HEAD') && allowQueryPath) || allowQueryPost) {
          const q = req.query.token;
          token = Array.isArray(q) ? String(q[q.length - 1] || '') : String(q);
          via = 'query';
        }
      }
      token = String(token || '');
      req.authToken = token;
      req.authVia = via;
      req.user = null;
      const payload = this.decodeToken(token);
      if (payload) {
        const user = this.verifyToken(token);
        if (user) {
          req.user = user;
          req.authPayload = payload;
          // 滑动续期：快到期的令牌换一张新的（前端在响应头里取）
          if (this.shouldRefresh(payload) && !res.headersSent) {
            try { res.setHeader('X-Refresh-Token', this.signToken(user)); } catch (_) {}
            res.setHeader('Access-Control-Expose-Headers', 'X-Refresh-Token');
          }
        }
      }
      next();
    };
  }

  requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    next();
  }

  requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
  }

  /**
   * 书库写操作权限：管理员，或管理员显式开启「家人共同管理」时的普通用户。
   * 默认只允许管理员，避免任何被批准的账号都能静默改动全站书库。
   * 用箭头函数定义：路由里以 `auth.requireEditor` 形式裸引用，不能依赖 this 的调用方。
   */
  requireEditor = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    if (req.user.role === 'admin') return next();
    if ((this.store.data.settings.security || {}).collaborativeLibrary) return next();
    return res.status(403).json({ error: '该操作会影响其他所有用户，仅管理员可执行（可在管理后台开启「家人共同管理」）' });
  };

  isEditor = user => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return !!(this.store.data.settings.security || {}).collaborativeLibrary;
  };
}

module.exports = { Auth, DEFAULT_TTL_HOURS };
