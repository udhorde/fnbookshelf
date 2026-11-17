// 轻量内存限流（进程内固定窗口；重启即清零）
// 用途：验证码发送 / 注册 / 登录校验等易被脚本刷的入口。
// 注意：key 一律由调用方用「真实来源地址」拼装，绝不采信可伪造的 X-Forwarded-For。
'use strict';

class RateLimiter {
  constructor() {
    this.m = new Map();   // key -> { start, n, set:Set }
    this._timer = null;
  }

  _rec(key, windowMs) {
    const now = Date.now();
    let r = this.m.get(key);
    if (!r || now - r.start >= windowMs) {
      r = { start: now, n: 0, set: new Set() };
      this.m.set(key, r);
    }
    return r;
  }

  /** 计数 +1，超出限额时返回 ok:false 与建议的 Retry-After（秒） */
  hit(key, limit, windowMs) {
    const r = this._rec(key, windowMs);
    r.n++;
    if (r.n > limit) {
      const retryAfter = Math.max(1, Math.ceil((r.start + windowMs - Date.now()) / 1000));
      return { ok: false, count: r.n, limit, retryAfter };
    }
    return { ok: true, count: r.n, limit, remaining: limit - r.n };
  }

  /** 记录窗口内出现过的不同取值，用于「短时间大量不同收件人」这类熔断 */
  distinct(key, value, limit, windowMs) {
    const r = this._rec(key, windowMs);
    if (value) r.set.add(String(value));
    if (r.set.size > limit) {
      return { ok: false, size: r.set.size, limit };
    }
    return { ok: true, size: r.set.size, limit };
  }

  /** 只查不改 */
  peek(key, windowMs) {
    const r = this.m.get(key);
    if (!r || Date.now() - r.start >= windowMs) return { count: 0, remaining: Infinity };
    return { count: r.n, start: r.start };
  }

  reset(key) { this.m.delete(key); }

  sweep() {
    const now = Date.now();
    for (const [k, r] of this.m) {
      // 窗口最长按 24h 兜底清理，避免长期驻留
      if (now - r.start > 24 * 3600 * 1000) this.m.delete(k);
    }
  }

  /** 周期清理（unref，不阻止进程退出） */
  start(intervalMs = 10 * 60 * 1000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.sweep(), intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stats() { return { buckets: this.m.size }; }
}

/** 取真实来源地址：优先 socket，其次 req.ip（未开启 trust proxy 时同样是 socket 地址） */
function clientIp(req) {
  if (!req) return 'unknown';
  let ip = (req.socket && (req.socket.remoteAddress || req.socket.address && req.socket.address().address)) || req.ip || '';
  ip = String(ip).replace(/^::ffff:/, '');
  return ip || 'unknown';
}

/** 统一生成 429 响应 */
function tooMany(res, retryAfter, msg) {
  const sec = Math.max(1, Number(retryAfter) || 60);
  res.setHeader('Retry-After', String(sec));
  return res.status(429).json({
    error: msg || `请求过于频繁，请 ${sec} 秒后再试`,
    retryAfter: sec
  });
}

module.exports = { RateLimiter, clientIp, tooMany };
