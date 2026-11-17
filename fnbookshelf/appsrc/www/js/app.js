/* 飞牛书屋 前端 SPA 1.9.0 */
'use strict';

// ===== 路径前缀（1.9.0）=====
// 除了「直接访问端口」，还可以在飞牛页面（5667）下用 /fnbookshelf/ 这样的二级路径进来。
// 前端所有地址都由这里拼：直接访问时 BASE 为空，二级路径访问时 BASE = '/fnbookshelf'。
const BASE = (() => {
  try {
    const p = location.pathname || '/';
    const i = p.indexOf('/index.html');
    let clean = (i >= 0 ? p.slice(0, i) : p).replace(/\/+$/, '');
    if (clean === '/' || clean === '.') clean = '';
    return clean;
  } catch (_) { return ''; }
})();
/** 把 '/api/xxx' 这类绝对路径补上前缀 */
const A = p => (typeof p === 'string' && p.charAt(0) === '/' ? BASE + p : p);

// ===== 工具 =====
const $ = sel => document.querySelector(sel);
const el = (tag, attrs, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c)); }
  return e;
};
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const fmtDate = t => new Date(t).toLocaleDateString('zh-CN');
const fmtDur = sec => {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
  return (sec / 3600).toFixed(1) + ' 小时';
};
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = {
  token: localStorage.getItem('fb_token') || '',
  user: null, site: null, canEdit: false,
  filters: null, page: 1,
  // 1.8.2：每页显示多少本（书库分页下拉，记住上次选择）
  pageSize: (() => {
    const n = Math.min(200, Math.max(1, Number(localStorage.getItem('fb_pageSize')) || 24));
    return n;
  })(),
  shelfIds: null,
  // 1.8.2：专题列表缓存在这里，侧栏（shell）每次渲染都能直接画出来
  collections: [],
  // 1.8.3：记住最近打开的专题，从专题里点进书后「返回」能回到专题
  lastCol: '',
  // 1.9.2：记住来源列表的完整地址（含 q / author / publisher / format / page），
  // 从列表点进详情后返回要回到「同一份列表」，不能把筛选条件丢掉
  lastListHash: '',
  view: { name: 'library', params: {} }
};
const PAGE_SIZES = [24, 48, 96, 200];

/** 拉取专题列表（侧栏与书库页共用；失败时退回上次的缓存） */
async function loadCollections() {
  try {
    const d = await api('/collections');
    state.collections = d.items || [];
  } catch (_) { /* 离线或未登录时保持原样 */ }
  return state.collections;
}

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(A('/api') + path, Object.assign({}, opts, { headers }));
  // 服务端在令牌过半寿命时下发新令牌，前端静默替换，避免用着用着突然掉线
  const rt = res.headers.get('X-Refresh-Token');
  if (rt) { state.token = rt; localStorage.setItem('fb_token', rt); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(false); throw new Error(data.error || '请先登录'); }
  if (!res.ok) { const e = new Error(data.error || '请求失败'); e.status = res.status; e.candidates = data.candidates; throw e; }
  return data;
}
function tokenQ() { return state.token ? '?token=' + encodeURIComponent(state.token) : ''; }

// 是否会改动「所有人的」书库（封面 / 版本合并 / 默认版本）：
// 服务端默认只允许管理员，管理员可在后台开启「家人共同管理」。
function canEditNow() {
  if (state.canEdit) return true;
  if (state.user && state.user.role === 'admin') return true;
  return !!(state.site && state.site.canEdit);
}
// 1.9.1：仅管理员（用于删除专题这类破坏性操作）
function isAdminNow() { return !!(state.user && state.user.role === 'admin'); }
function refreshSite() {
  return api('/site').then(s => {
    state.site = s;
    state.canEdit = !!s.canEdit || (state.user && state.user.role === 'admin');
    return s;
  }).catch(() => state.site || {});
}

/**
 * 触发文件下载（1.6.3：三级兜底）
 * 浏览器拦下载的成因不止一种：
 *   ① 自签名 HTTPS 页面里 <a href download> 会被 Chrome 拦（下载列表显示「无法下载 - 网络问题」）；
 *   ② 应用被嵌在飞牛桌面的 iframe 里时，没有 allow-downloads 的沙箱会静默丢弃下载；
 *   ③ 某些企业策略 / 插件会拦 blob: 下载。
 * 所以顺序是：iframe 内先「新窗口直接打开附件地址」→ fetch 成 Blob 保存 → 再退「新窗口直开」，
 * 每一步都能拿到真实原因，不再只留一句「网络问题」。
 */
async function saveFile(url, filename, btn) {
  const label = btn ? btn.textContent : '';
  const name = filename || 'download';
  const href = /[?&]download=1/.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'download=1';
  if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
  const inFrame = (() => { try { return window.top !== window.self; } catch (_) { return true; } })();
  // 新窗口直开：由浏览器原生下载器接管，不受 <a download> 与 iframe 沙箱限制
  const directOpen = () => {
    try { return !!window.open(href, '_blank', 'noopener'); } catch (_) { return false; }
  };
  try {
    if (inFrame && directOpen()) {
      if (btn) btn.textContent = '已在新窗口打开';
      return;
    }
    const headers = state.token ? { Authorization: 'Bearer ' + state.token } : {};
    const res = await fetch(href, { headers, cache: 'no-store' });
    if (!res.ok) {
      let msg = '服务器返回 ' + res.status;
      try { const j = await res.clone().json(); if (j && j.error) msg += '：' + j.error; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('文件内容为空');
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 20000);
    if (btn) btn.textContent = '已开始下载';
  } catch (e) {
    if (directOpen()) {
      if (btn) btn.textContent = '已交给浏览器';
    } else {
      alert('下载失败：' + e.message +
        '\n\n可以这样排查：\n① 在地址栏直接打开这个链接：' + location.origin + href +
        '\n② 若嵌在飞牛桌面里，请把应用在新标签页打开\n③ 「设置 → HTTPS」上传受信任证书后可彻底避免');
      if (btn) btn.textContent = '下载失败';
    }
  } finally {
    if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 1600);
  }
}

function logout(redirect = true) {
  const tok = state.token;
  state.token = ''; state.user = null; state.shelfIds = null; state.canEdit = false;
  localStorage.removeItem('fb_token');
  // 1.7.0：真正让服务端令牌失效，而不是只清本地
  if (tok) {
    fetch(A('/api/auth/logout'), { method: 'POST', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {});
  }
  if (redirect) { location.hash = '#/login'; render(); }
}

// 退出所有设备：自增会话版本号，所有已签发令牌立即失效
async function logoutAll() {
  if (!confirm('退出所有设备？\n\n本机与其他设备上的登录状态都会立即失效，需要重新验证邮箱。')) return;
  try { await api('/auth/logout-all', { method: 'POST' }); } catch (_) {}
  logout();
}

// ===== 全局兜底 =====
function fatal(e) {
  const msg = String((e && e.message) || e || '');
  if (!msg || msg === '[object Object]' || /ResizeObserver|Script error|Autofill|_AutofillCallbackHandler/i.test(msg)) return;
  if (document.querySelector('.reader')) { console.warn('[reader-error]', msg); return; }
  const app = document.querySelector('#app');
  if (!app) return;
  app.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = '<div class="big">⚠️</div>';
  const p = document.createElement('p');
  p.textContent = '页面出错：' + msg;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '重新加载';
  btn.style.marginTop = '14px';
  btn.onclick = () => location.reload();
  box.append(p, btn);
  app.append(box);
}
window.addEventListener('error', e => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', e => fatal(e.reason));

// ===== 路由 =====
// 1.5.0：登录后默认进入「我的书架」
function parseHash() {
  const h = (location.hash || '#/shelf').slice(2);
  const [name, ...rest] = h.split('?')[0].split('/');
  return { name: name || 'shelf', params: { id: rest[0] ? decodeURIComponent(rest[0]) : null, q: new URLSearchParams(location.hash.split('?')[1] || '') } };
}
// 路由变化时，若阅读器遮罩仍打开（例如点了浏览器后退），先关闭遮罩再渲染
window.addEventListener('hashchange', () => {
  if (window.Reader && window.Reader.close) window.Reader.close();
  render();
});

/**
 * 1.9.2：APP 端返回键 = 回「上一层级」，不是回「上一个页面」。
 * 以前客户端直接 web.goBack()，走的是浏览历史——在书库里点 A 书 → 返回 → 点 B 书 → 返回，
 * 会退回到 A 书（历史栈），用户看到的不是「上一层」。
 * 现在按路由的层级关系算目标地址：
 *   书详情 → 来源列表（专题 / 搜索 / 全部图书）→ 我的书架 / 全部图书 → 首页
 * 阅读器、弹窗这类「层」由 reader.js 自己的 __fnbBack 拦在前面处理；
 * 桌面浏览器没有硬件返回键，只影响 APP，网页内行为不变。
 */
function routeParent(hash) {
  const h = String(hash || location.hash || '#/shelf');
  const path = h.split('?')[0];
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = parts[0] || 'shelf';
  switch (name) {
    case 'book': {
      // 1.9.2：优先回到「进来时那份列表」——保留 q / author / publisher / format / page，
      // 否则从筛选结果点进详情，返回就变成不筛选的全库，用户以为筛选白做了。
      const back = state.lastListHash || '';
      const backName = String(back).replace(/^#\/?/, '').split(/[/?]/)[0];
      if (back && (backName === 'library' || backName === 'collections')) return back;
      if (state.lastCol) return '#/collections/' + encodeURIComponent(state.lastCol);
      return '#/library';
    }
    case 'collections':
      return parts[1] ? '#/collections' : '#/shelf';
    case 'admin':
    case 'me':
    case 'records':
    case 'app':
      return '#/shelf';
    case 'library':
      // 从书架点进来的就回书架；否则回书架（书库本身是根）
      return '#/shelf';
    case 'shelf':
    case 'login':
      return '';
    default:
      return '#/shelf';
  }
}

function goParent() {
  const to = routeParent();
  if (!to || to === location.hash) return false;
  location.hash = to;
  return true;
}

// 客户端先问这个：还有没有「一层」可以退
window.__fnbBack = function () {
  // 先给阅读器/弹窗自己的处理留机会（阅读器打开时会覆盖这个函数）
  try {
    const m = document.querySelector('.modal-mask');
    if (m) {
      if (typeof m.__close === 'function') { m.__close(); return true; }
      m.remove(); return true;
    }
  } catch (_) {}
  return goParent();
};
// 客户端兜底也走层级，而不是浏览历史
window.__fnbParent = function () { try { return goParent() ? '1' : '0'; } catch (_) { return '0'; } };

async function render() {
  const route = parseHash();
  const app = $('#app');
  try {
    if (!state.user) {
      if (route.name !== 'login') location.hash = '#/login';
      app.innerHTML = ''; app.append(await authView());
      return;
    }
    if (route.name === 'login') { location.hash = '#/shelf'; return; }
    await loadCollections();      // 侧栏「专题」要用（失败不阻塞页面）
    if (route.name === 'book' && route.params.id) return await renderDetail(app, route.params.id);
    if (route.name === 'admin') return await renderAdmin(app);
    if (route.name === 'app') return await renderAppPage(app);
    if (route.name === 'shelf') return await renderShelf(app);
    if (route.name === 'me') return await renderMe(app);
    if (route.name === 'records') return await renderRecords(app);
    if (route.name === 'collections') {
      // 1.8.3：/collections 是总览，/collections/<id> 复用书库的网格视图
      if (route.params.id) return await renderLibrary(app, route, { colId: route.params.id, active: 'collections' });
      return await renderCollections(app);
    }
    await renderLibrary(app, route);
  } catch (e) {
    app.innerHTML = '';
    app.append(el('div', { class: 'empty' },
      el('div', { class: 'big', html: '⚠️' }),
      el('p', {}, e.message),
      el('button', { class: 'btn', style: 'margin-top:14px', onclick: () => render() }, '重试')));
  }
}

// ===== 登录 =====
async function authView() {
  if (!state.site) { try { state.site = await api('/site'); } catch (_) { state.site = { siteName: '飞牛书屋' }; } }
  const siteName = (state.site && state.site.siteName) || '飞牛书屋';
  let setup = null;
  try { setup = await api('/setup'); } catch (_) {}

  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-card' });
  const msg = el('div');
  const email = el('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
  const code = el('input', { type: 'text', placeholder: '6 位验证码或离线解锁码', maxlength: '12', inputmode: 'text' });
  const sendBtn = el('button', { class: 'btn ghost', type: 'button' }, '获取验证码');
  const loginBtn = el('button', { class: 'btn full' }, '验证并进入');

  if (setup && setup.setupRequired && setup.adminEmail) email.value = setup.adminEmail;

  let cd = 0;
  const tick = () => { if (cd > 0) { sendBtn.textContent = `${cd}s 后重发`; cd--; setTimeout(tick, 1000); } else sendBtn.textContent = '获取验证码'; };

  sendBtn.addEventListener('click', async () => {
    msg.innerHTML = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return show(msg, '请输入正确的邮箱地址', 'err');
    sendBtn.disabled = true;
    try {
      await api('/auth/code', { method: 'POST', body: JSON.stringify({ email: email.value.trim() }) });
      cd = 60; tick();
      // 统一文案：服务端不再告知该邮箱是否已注册（防账号枚举）
      show(msg, '验证码已发送（10 分钟内有效），请查收邮箱', 'ok');
    } catch (e) { show(msg, e.message, 'err'); sendBtn.disabled = false; }
  });

  const submit = async () => {
    msg.innerHTML = '';
    try {
      const r = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ email: email.value.trim(), code: code.value.trim() }) });
      if (r.pending) { show(msg, r.message || '注册成功，等待管理员审核', 'ok'); return; }
      state.token = r.token; state.user = r.user;
      localStorage.setItem('fb_token', r.token);
      await refreshSite();
      location.hash = '#/shelf';
      await render();
    } catch (e) { show(msg, e.message, 'err'); }
  };
  loginBtn.addEventListener('click', submit);
  card.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

  card.append(
    el('h2', {}, siteName),
    el('p', { class: 'sub' }, '邮箱验证码登录 · 无需密码'),
    msg,
    el('div', { class: 'field' }, el('label', {}, '邮箱地址'), email),
    el('div', { class: 'field' }, el('label', {}, '验证码'),
      el('div', { class: 'code-row' }, code, sendBtn)),
    el('div', { style: 'margin:6px 0 14px' }, loginBtn)
  );

  if (setup && setup.setupRequired) {
    const setupBox = el('div', { class: 'setup-box' });
    setupBox.append(el('h3', { style: 'font-size:15px;margin-bottom:8px' }, '🔧 首次启动配置'));
    if (!setup.smtpConfigured) {
      setupBox.append(el('p', { style: 'font-size:13px;color:var(--muted);margin-bottom:10px' },
        '尚未配置发件邮箱，无法发送验证码。请在下方配置 SMTP，或直接使用离线解锁码登录。'));
      const f = {};
      const mk = (key, ph, type) => { f[key] = el('input', { type: type || 'text', placeholder: ph }); return el('div', { class: 'field' }, f[key]); };
      setupBox.append(
        mk('host', 'SMTP 服务器，如 smtp.qq.com'),
        el('div', { style: 'display:flex;gap:8px' },
          el('div', { class: 'field', style: 'flex:1' }, (() => { f.port = el('input', { type: 'number', placeholder: '端口 465' }); return f.port; })()),
          el('div', { class: 'field', style: 'flex:1' }, (() => { f.secure = el('select', {}, el('option', { value: 'true' }, 'SSL'), el('option', { value: 'false' }, 'STARTTLS')); return f.secure; })())
        ),
        mk('user', '发件邮箱账号'),
        mk('pass', '密码 / 授权码', 'password'),
        el('div', { style: 'display:flex;gap:8px;margin-bottom:10px' },
          el('button', { class: 'btn sm', onclick: async e => {
            e.target.disabled = true;
            try {
              await api('/setup/smtp', { method: 'POST', body: JSON.stringify({ host: f.host.value, port: f.port.value || 465, secure: f.secure.value === 'true', user: f.user.value, pass: f.pass.value }) });
              setup.smtpConfigured = true;
              show(msg, 'SMTP 已保存！现在可以获取验证码了', 'ok');
            } catch (err) { show(msg, err.message, 'err'); }
            e.target.disabled = false;
          } }, '保存 SMTP'),
          el('button', { class: 'btn sm ghost', onclick: async e => {
            e.target.disabled = true; e.target.textContent = '发送中…';
            try {
              await api('/setup/smtp', { method: 'POST', body: JSON.stringify({ host: f.host.value, port: f.port.value || 465, secure: f.secure.value === 'true', user: f.user.value, pass: f.pass.value }) });
              await api('/setup/smtp-test', { method: 'POST', body: JSON.stringify({ to: f.user.value }) });
              show(msg, '测试邮件已发送，请查收', 'ok');
            } catch (err) { show(msg, '发送失败：' + err.message, 'err'); }
            e.target.disabled = false; e.target.textContent = '保存并测试';
          } }, '保存并测试'))
      );
    } else {
      setupBox.append(el('p', { style: 'font-size:13px;color:#15803d;margin-bottom:10px' }, '✅ 发件邮箱已配置，可直接获取验证码登录。'));
    }
    if (setup.bootstrapHint) {
      setupBox.append(el('div', { class: 'boot-hint' },
        el('p', { style: 'font-size:13px;color:#92400e;margin-bottom:4px;font-weight:600' }, '📄 无法收发邮件？使用离线解锁码'),
        el('p', { style: 'font-size:12px;color:#92400e;line-height:1.6' },
          '在飞牛文件管理中打开以下文件，将其中的解锁码填入上方"验证码"框（邮箱填管理员邮箱）即可登录：'),
        el('code', { style: 'display:block;background:#fef3c7;padding:6px 8px;border-radius:6px;font-size:11px;word-break:break-all;margin-top:4px' }, setup.bootstrapHint)));
    }
    card.append(setupBox);
  } else {
    card.append(el('p', { class: 'sub', style: 'margin:0' }, '验证码由管理员配置的邮箱发送，10 分钟内有效'));
  }

  wrap.append(card);
  return wrap;
}
function show(container, text, type) { container.innerHTML = `<div class="msg ${type}">${esc(text)}</div>`; }

// ===== 外壳 =====
function shell(active) {
  const layout = el('div', { class: 'layout' });
  const sidebar = el('div', { class: 'sidebar' });
  const main = el('div', { class: 'main' });
  const mask = el('div', { class: 'sb-mask', onclick: () => closeSidebar() });
  const closeSidebar = () => { sidebar.classList.remove('open'); mask.classList.remove('show'); };
  const openSidebar = () => { sidebar.classList.add('open'); mask.classList.add('show'); };
  layout._closeSidebar = closeSidebar;
  window.__closeSidebar = closeSidebar;

  // 移动端顶栏（桌面端隐藏）
  const mobileBar = el('div', { class: 'mobile-bar' },
    el('button', { class: 'mb-menu', onclick: openSidebar, 'aria-label': '菜单' }, '☰'),
    el('div', { class: 'mb-title' }, '飞牛书屋'),
    el('button', { class: 'mb-menu', onclick: () => { location.hash = '#/library'; state.q = ''; render(); }, 'aria-label': '书库' }, '🔍')
  );

  sidebar.append(el('div', { class: 'brand', html: `<svg width="30" height="30" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#2563eb"/><path d="M28 72c8-6 16-6 22-2 6-4 14-4 22 2V30c-8-6-16-6-22-2-6-4-14-4-22 2z" fill="none" stroke="white" stroke-width="6" stroke-linejoin="round"/></svg><span>飞牛书屋</span>` }));

  // 1.8.3：「专题」是一级导航，和「全部图书」同级，只是排在它下面（不再缩进成全部图书的子项）
  const navs = [
    ['shelf', '⭐ 我的书架', '#/shelf'],
    ['library', '📚 全部图书', '#/library'],
    ['collections', '🗂 专题', '#/collections'],
    ['records', '🔖 我的记录', '#/records'],
    ['me', '📊 阅读统计', '#/me']
  ];
  const navSec = el('div', { class: 'nav-section' }, el('div', { class: 'nav-title' }, '浏览'));
  for (const [key, label, href] of navs) {
    // 1.9.0：侧栏只在「专题」下留一级入口，不再展开二级目录（专题在总览页里看）
    const on = key === active;
    navSec.append(el('div', { class: 'nav-item' + (on ? ' active' : ''), onclick: () => { state.page = 1; location.hash = href; } }, label));
  }
  sidebar.append(navSec);

  // 侧栏底部：账号 → 管理后台 → 下载 APP → 退出登录（1.9.0：退出登录固定在左下角最底下）
  const foot = el('div', { class: 'sidebar-foot' });
  foot.append(
    el('div', { class: 'sf-mail', title: state.user.email }, state.user.email),
    state.user.role === 'admin' ? el('a', { class: 'sf-link', href: '#/admin' }, '⚙ 管理后台') : null,
    el('a', { class: 'sf-link', href: '#/app' }, '📱 下载 APP'),
    el('a', { class: 'sf-link sf-logout', href: '#', onclick: e => { e.preventDefault(); logout(); } }, '退出登录')
  );
  sidebar.append(foot);
  layout.append(mobileBar, sidebar, mask, main);
  return { layout, sidebar, main };
}

function currentTitle(route) {
  if (route.name === 'collections') {
    if (!route.params.id) return '专题';
    const c = (state.collections || []).find(x => x.id === route.params.id);
    return c ? c.name : '专题';
  }
  const p = route.params.q;
  if (p.get('col')) {
    const c = (state.collections || []).find(x => x.id === p.get('col'));
    return c ? c.name : '专题';
  }
  if (p.get('q')) return `搜索：${p.get('q')}`;
  return '全部图书';
}

/** 当前正在看的具体专题 id（#/collections/<id>，兼容旧链接 #/library?col=xxx） */
function currentCollectionId() {
  const path = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  const [name, id] = path.split('/');
  if (name === 'collections' && id) return decodeURIComponent(id);
  const legacy = new URLSearchParams(location.hash.split('?')[1] || '').get('col');
  return legacy || '';
}

/**
 * 1.8.3：「专题」总览页——和「全部图书」平级的一个入口。
 * 只做归类，不复制、不移动任何文件。
 */
async function renderCollections(app) {
  state.view = { name: 'collections' };
  const { layout, sidebar, main } = shell('collections');
  const cols = await loadCollections();

  const canEdit = canEditNow();
  main.append(el('div', { class: 'topbar' },
    el('h1', {}, '🗂 专题'),
    canEdit ? el('button', { class: 'btn', onclick: () => createCollectionFlow([], () => render()) }, '＋ 新建专题') : null));
  main.append(el('p', { class: 'col-desc' },
    '把书按主题归类。专题只记分类关系：书仍然在「全部图书」里，不会被复制、移动或删除。'));

  if (!cols.length) {
    main.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '🗂'),
      el('p', {}, canEdit ? '还没有专题。点右上角「＋ 新建专题」，或在书库里「☑ 选择」多本书后一键建专题。' : '还没有专题。')));
    app.innerHTML = ''; app.append(layout);
    return;
  }

  const grid = el('div', { class: 'col-grid' });
  for (const c of cols) {
    // 1.9.0：专题可以有自己的封面；没设就用里面书的封面拼一张
    const coverBox = el('div', { class: 'col-cover' });
    if (c.coverUrl) {
      coverBox.append(el('img', { src: A(c.coverUrl) + '?token=' + encodeURIComponent(state.token) + '&t=' + (c.updatedAt || 0), alt: c.name, loading: 'lazy' }));
    } else if ((c.covers || []).length) {
      for (const id of c.covers.slice(0, 4)) {
        coverBox.append(el('img', { src: A(`/api/cover/${id}${tokenQ()}`), alt: '', loading: 'lazy' }));
      }
      coverBox.classList.add('multi');
    } else {
      coverBox.append(el('div', { class: 'col-cover-empty' }, '📁'));
    }
    const card = el('div', {
      class: 'col-card',
      title: c.desc || c.name,
      onclick: () => { state.page = 1; location.hash = '#/collections/' + encodeURIComponent(c.id); }
    },
      coverBox,
      el('div', { class: 'col-card-head' },
        el('span', { class: 'col-card-name' }, c.name),
        el('span', { class: 'col-card-count' }, `${c.count} 本`)),
      c.desc ? el('div', { class: 'col-card-desc' }, c.desc) : el('div', { class: 'col-card-desc muted' }, '没有简介'),
      canEdit ? el('div', { class: 'col-card-act' },
        el('button', {
          class: 'btn sm ghost', title: '给这个专题设置封面',
          onclick: e => { e.stopPropagation(); openCollectionCover(c); }
        }, '🖼 封面')) : null);
    grid.append(card);
  }
  if (canEdit) {
    grid.append(el('div', { class: 'col-card-new', onclick: () => createCollectionFlow([], () => render()) }, '＋ 新建专题'));
  }
  main.append(grid);

  app.innerHTML = ''; app.append(layout);
}

// 1.5.0：分类功能已彻底下线（不再有年份 / 格式分组与筛选），书库是一部平铺的列表

// ===== 书库 =====
// 1.9.0 改版要点：
//   · 合并 / 批量加专题收敛到「一个按钮」：点「☑ 批量」开始多选，选完再决定做什么
//   · 新增按格式筛选（chips）
//   · 搜不到书时可以一键「通知管理员」
async function renderLibrary(app, route, opts = {}) {
  state.view = { name: opts.colId ? 'collection' : 'library' };
  const p0 = route.params.q;
  // 1.8.3：专题自己有独立入口 #/collections/<id>；旧的 #/library?col=xxx 自动跳到新地址
  const legacyCol = p0.get('col') || '';
  if (!opts.colId && legacyCol) {
    const keep = new URLSearchParams(p0);
    keep.delete('col');
    location.hash = '#/collections/' + encodeURIComponent(legacyCol) + (keep.toString() ? '?' + keep.toString() : '');
    return;
  }
  const colId = opts.colId || currentCollectionId();
  const { layout, sidebar, main } = shell(opts.active || (colId ? 'collections' : 'library'));
  const canEdit = canEditNow();

  const collections = await loadCollections();
  const collection = colId ? collections.find(c => c.id === colId) : null;
  if (colId && !collection) { state.page = 1; location.hash = '#/collections'; return render(); }
  state.lastCol = collection ? collection.id : '';
  // 1.9.2：记下来源列表的完整地址，详情页返回时用它还原筛选/搜索/页码
  try { state.lastListHash = location.hash || '#/library'; } catch (_) { state.lastListHash = '#/library'; }

  const searchInput = el('input', {
    placeholder: collection ? `在「${collection.name}」里搜索…` : '搜索书名 / 作者 / 文件名 / 目录路径…',
    value: p0.get('q') || ''
  });
  const formatNow = (p0.get('format') || '').toLowerCase();
  // 1.9.2：出版社 / 作者筛选（多选，逗号分隔）
  const pubsNow = (p0.get('publisher') || '').split(',').map(s => s.trim()).filter(Boolean);
  const authsNow = (p0.get('author') || '').split(',').map(s => s.trim()).filter(Boolean);
  const buildHash = patch => {
    const params = new URLSearchParams();
    const q = patch.q !== undefined ? patch.q : searchInput.value.trim();
    if (q) params.set('q', q);
    const f = patch.format !== undefined ? patch.format : formatNow;
    if (f) params.set('format', f);
    const pb = patch.publisher !== undefined ? patch.publisher : pubsNow;
    if (pb && pb.length) params.set('publisher', pb.join(','));
    const au = patch.author !== undefined ? patch.author : authsNow;
    if (au && au.length) params.set('author', au.join(','));
    if (p0.get('sort')) params.set('sort', p0.get('sort'));
    const base = colId ? '#/collections/' + encodeURIComponent(colId) : '#/library';
    location.hash = base + (params.toString() ? '?' + params.toString() : '');
    state.page = 1;
  };
  const doSearch = () => { buildHash({}); render(); };
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // 1.9.0：找书按钮改名「AI 找书」
  const aiBtn = el('button', { class: 'btn ghost sm', title: '用一句话描述想读什么，AI 在全书库里找（本地检索 + AI 重排）' }, '✦ AI找书');
  aiBtn.addEventListener('click', () => openAiSearch(main, searchInput.value.trim(), { colId }));

  const headTitle = collection ? collection.name
    : (p0.get('q') ? `搜索：${p0.get('q')}` : '全部图书');
  const topbar = el('div', { class: 'topbar' },
    el('h1', {}, collection ? '📁 ' + headTitle : headTitle),
    el('div', { class: 'searchbox' }, searchInput, el('button', { onclick: doSearch }, '搜索')),
    aiBtn);

  if (collection) {
    main.append(el('div', { class: 'crumb' },
      el('a', { href: '#/collections' }, '🗂 专题'), el('span', { class: 'crumb-sep' }, '/'),
      el('span', { class: 'crumb-cur' }, collection.name)));
    if (collection.desc) main.append(el('p', { class: 'col-desc' }, collection.desc));
  }
  // 1.9.2：顶栏（搜索 / AI找书 / 批量 / 筛选）吸附在页面顶部。
  // 筛选不再是常驻的一排格式 chip（那是 1.9.0 的做法，占掉两行高度），
  // 而是一个「🔎 筛选」按钮：点开才出现面板，选完点「确定」才执行；
  // 往下翻书时面板自动收起，只留一行按钮，同时把已选条件显示成摘要。
  const stickyHead = el('div', { class: 'sticky-head' }, topbar);
  main.append(stickyHead);
  // 吸顶后加一点阴影，让人一眼看出内容从下面滑过
  (() => {
    const mark = () => {
      const off = stickyHead.getBoundingClientRect().top;
      const base = window.innerWidth <= 760 ? 57 : 0;
      stickyHead.classList.toggle('stuck', off <= base + 1);
    };
    window.addEventListener('scroll', mark, { passive: true });
    window.addEventListener('resize', mark);
    setTimeout(mark, 30);
  })();

  // ---- 筛选面板 ----
  const filterBar = el('div', { class: 'filter-bar' });
  stickyHead.append(filterBar);
  const filterFacets = { formats: [], publishers: [], authors: [] };
  // 面板里的待提交选择（点「确定」前不生效）
  const pend = { format: new Set(formatNow ? [formatNow] : []), publisher: new Set(pubsNow), author: new Set(authsNow) };
  let facetLoaded = false;
  // 打开面板时各分组默认全折叠，只显示三行标题，不挤占书库空间
  let groupOpen = { format: false, publisher: false, author: false };

  const selCount = () => pend.format.size + pend.publisher.size + pend.author.size;
  const filterBtn = el('button', { class: 'btn ghost sm', title: '按格式、出版社、作者筛选' }, '🔎 筛选');
  const filterPanel = el('div', { class: 'filter-panel hidescroll' });
  filterPanel.style.display = 'none';
  const chipRow = el('div', { class: 'chip-row' });
  filterBar.append(filterBtn, chipRow);

  function renderSummary() {
    chipRow.innerHTML = '';
    // 摘要只反映「已生效」的条件（来自 URL），避免面板里改了还没点确定就提前显示
    if (formatNow) {
      chipRow.append(el('button', { class: 'chip on', title: '取消该筛选', onclick: () => { pend.format.delete(formatNow); buildHash({ format: '' }); render(); } }, String(formatNow).toUpperCase() + ' ✕'));
    }
    for (const v of pubsNow) chipRow.append(el('button', { class: 'chip on', title: '取消该筛选', onclick: () => { pend.publisher.delete(v); buildHash({ publisher: pubsNow.filter(x => x !== v) }); render(); } }, `🏷 ${v} ✕`));
    for (const v of authsNow) chipRow.append(el('button', { class: 'chip on', title: '取消该筛选', onclick: () => { pend.author.delete(v); buildHash({ author: authsNow.filter(x => x !== v) }); render(); } }, `✍ ${v} ✕`));
    const n = (formatNow ? 1 : 0) + pubsNow.length + authsNow.length;
    if (n) {
      chipRow.append(el('button', { class: 'chip clear', onclick: () => {
        pend.format.clear(); pend.publisher.clear(); pend.author.clear();
        buildHash({ format: '', publisher: [], author: [] }); render();
      } }, '✕ 清空筛选'));
    }
    filterBtn.classList.toggle('on', n > 0);
    filterBtn.textContent = n ? `🔎 筛选 · ${n}` : '🔎 筛选';
  }

  function facetGroup(key, label, icon) {
    // 格式只有一个分组（选项少，默认展开）；出版社/作者可能有几十项，
    // 两者都从折叠态开始，面板打开时只占三行，不挤占书库空间。
    const box = el('div', { class: 'fp-group' + (groupOpen[key] ? ' open' : '') });
    const caret = el('span', { class: 'fp-caret' }, groupOpen[key] ? '▾' : '▸');
    const head = el('button', { class: 'fp-head' }, `${icon} ${label}`, caret);
    head.addEventListener('click', () => {
      groupOpen[key] = !groupOpen[key];
      box.classList.toggle('open', groupOpen[key]);
      caret.textContent = groupOpen[key] ? '▾' : '▸';
    });
    const body = el('div', { class: 'fp-body' });
    // 记录本组被选中的值，用于「全部折叠/展开」
    const keyOf = it => {
      const raw = it.raw !== undefined ? it.raw : it.value;
      return key === 'format' ? String(raw).toLowerCase() : raw;
    };
    body._repaint = () => {
      body.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', pend[key].has(c.dataset.k)));
    };
    const items = key === 'format'
      ? (filterFacets.formats || []).map(x => ({ value: String(x.value).toUpperCase(), raw: String(x.value), count: x.count }))
      : (filterFacets[key === 'publisher' ? 'publishers' : 'authors'] || []);
    if (!items.length) body.append(el('span', { class: 'muted-sm' }, key === 'publisher' ? '书库里还没有出版社信息（刮削成功后会自动补全）' : '没有可筛选的项'));
    for (const it of items) {
      const k = keyOf(it);
      const on = pend[key].has(k);
      const b = el('button', { class: 'chip sm' + (on ? ' on' : ''), 'data-k': k }, `${it.value}`, el('span', { class: 'chip-n' }, String(it.count || '')));
      b.addEventListener('click', () => {
        if (pend[key].has(k)) { pend[key].delete(k); b.classList.remove('on'); }
        else { pend[key].add(k); b.classList.add('on'); }
        updateAct();
      });
      body.append(b);
    }
    box.append(head, body);
    return box;
  }
  // 底部「已选 N 项」跟着实时变
  function updateAct() {
    const n = selCount();
    const box = filterPanel.querySelector('.fp-act .muted-sm');
    if (box) box.textContent = n ? `已选 ${n} 项` : '未选择条件';
  }

  function renderPanel() {
    filterPanel.innerHTML = '';
    filterPanel.append(
      el('div', { class: 'fp-top' },
        el('span', { class: 'fp-title' }, '筛选'),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'btn sm ghost', onclick: () => {
          pend.format.clear(); pend.publisher.clear(); pend.author.clear();
          renderPanel();
        } }, '清空')),
      facetGroup('format', '格式', '🗂'),
      facetGroup('publisher', '出版社', '🏷'),
      facetGroup('author', '作者', '✍'),
      el('div', { class: 'fp-act' },
        el('span', { class: 'muted-sm' }, selCount() ? `已选 ${selCount()} 项` : '未选择条件'),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'btn sm ghost', onclick: () => { closePanel(); } }, '取消'),
        el('button', { class: 'btn sm', onclick: () => {
          buildHash({
            format: [...pend.format].join(','),
            publisher: [...pend.publisher],
            author: [...pend.author]
          });
          render();
        } }, '确定')));
  }

  function openPanel() {
    filterPanel.style.display = '';
    filterBtn.classList.add('on');
    if (!facetLoaded) {
      filterPanel.innerHTML = '<div class="muted-sm" style="padding:10px">加载筛选项…</div>';
      const qs = new URLSearchParams();
      const kw = (p0.get('q') || '').trim();
      if (kw) qs.set('q', kw);
      if (colId) qs.set('col', colId);
      api('/facets' + (qs.toString() ? '?' + qs : '')).then(f => {
        filterFacets.formats = f.formats || [];
        filterFacets.publishers = f.publishers || [];
        filterFacets.authors = f.authors || [];
        facetLoaded = true;
        renderPanel();
      }).catch(err => {
        filterPanel.innerHTML = '';
        filterPanel.append(
          el('div', { class: 'muted-sm', style: 'padding:10px;color:#b91c1c' }, '筛选项加载失败：' + (err && err.message ? err.message : '请稍后重试')),
          el('button', { class: 'btn sm ghost', style: 'margin:0 10px 10px', onclick: () => { facetLoaded = false; openPanel(); } }, '重试'),
          // 即使筛选项拿不到，也要能清空已生效的条件
          el('div', { class: 'fp-act' },
            el('span', { class: 'muted-sm' }, '仍可清除现有筛选'),
            el('span', { style: 'flex:1' }),
            el('button', { class: 'btn sm ghost', onclick: () => { closePanel(); } }, '关闭'),
            el('button', { class: 'btn sm', onclick: () => {
              pend.format.clear(); pend.publisher.clear(); pend.author.clear();
              buildHash({ format: '', publisher: [], author: [] }); render();
            } }, '清空筛选')));
      });
    } else renderPanel();
  }
  function closePanel() {
    filterPanel.style.display = 'none';
    filterBtn.classList.toggle('on', !!(formatNow || pubsNow.length || authsNow.length));
  }
  filterBtn.addEventListener('click', () => {
    if (filterPanel.style.display !== 'none') closePanel(); else openPanel();
  });
  // 往下翻找书的时候把面板收起来，别占着屏幕。
  // 1.9.2：书少的时候页面滚不动（没有滚动条），滚轮事件照样会触发但 scrollY 不变——
  // 这种「用户想看下面的书」的意图也要收起面板，否则面板一直压着书卡。
  let lastY = window.scrollY || 0;
  const onScroll = () => {
    const y = window.scrollY || 0;
    if (filterPanel.style.display !== 'none' && Math.abs(y - lastY) > 24) closePanel();
    lastY = y;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('wheel', e => {
    if (filterPanel.style.display === 'none') return;
    if (e.deltaY > 20) closePanel();          // 只认「往下翻」，往上滚不打扰
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (filterPanel.style.display === 'none') return;
    if (filterPanel.contains(e.target)) return;   // 手指在面板里滚（选项多）不收起
    closePanel();
  }, { passive: true });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && filterPanel.style.display !== 'none') closePanel();
  });
  renderSummary();

  const grid = el('div', { class: 'grid' });
  const pager = el('div', { class: 'pager' });
  const selBar = el('div', { class: 'sel-bar' });
  main.append(grid, pager, selBar);

  // ===== 1.9.0：统一的「批量」入口 =====
  // 以前「合并书籍」是一个按钮、批量加专题是另一个按钮，用户要记两套操作。
  // 现在只有一个「☑ 批量」：多选完成后在下方选「合并」或「加入专题」。
  let selMode = false;
  const selected = new Set();
  const selBtn = el('button', { class: 'btn ghost' }, '☑ 批量');
  selBtn.addEventListener('click', () => setSelMode(!selMode));

  if (canEdit) {
    topbar.append(selBtn);
    if (collection) {
      topbar.append(el('button', { class: 'btn ghost sm', title: '修改专题名称、简介与封面', onclick: () => renameCollectionFlow(collection) }, '✎ 改专题'));
      // 1.9.1：删除专题属于破坏性操作，只给管理员看
      if (isAdminNow()) {
        topbar.append(el('button', { class: 'btn ghost sm danger-text', title: '删除专题（不会删除任何书籍）', onclick: () => deleteCollectionFlow(collection) }, '🗑 删专题'));
      }
    }
  }
  // 1.9.2：「筛选」按钮与 AI找书 / 批量 同一排（游客也能用，不算编辑操作）
  topbar.append(filterBtn);
  topbar.append(filterPanel);

  function applySelMarks() {
    grid.classList.toggle('sel-mode', selMode);
    grid.querySelectorAll('.book-card').forEach(c => c.classList.toggle('sel', selected.has(c.dataset.id)));
  }
  function setSelMode(v) {
    selMode = !!v;
    if (!selMode) selected.clear();
    selBtn.classList.toggle('on', selMode);
    selBtn.textContent = selMode ? '✓ 退出批量' : '☑ 批量';
    applySelMarks(); updateSelBar();
  }
  function updateSelBar() {
    selBar.innerHTML = '';
    selBar.classList.toggle('show', selMode);
    document.body.classList.toggle('has-selbar', selMode);
    if (!selMode) return;
    const none = selected.size === 0;
    const one = selected.size < 2;
    // 注意：Node.append(null) 会塞进一段文本 "null"，条件按钮要先过滤掉
    selBar.append(...[
      el('span', { class: 'sel-count' }, `已选 ${selected.size} 本`),
      el('button', { class: 'btn sm ghost', onclick: () => { grid.querySelectorAll('.book-card').forEach(c => selected.add(c.dataset.id)); applySelMarks(); updateSelBar(); } }, '全选本页'),
      el('button', { class: 'btn sm ghost', onclick: () => { selected.clear(); applySelMarks(); updateSelBar(); } }, '清空'),
      el('span', { style: 'flex:1' }),
      // 选好之后的动作：合并 / 加入专题 / 新建专题（专题内额外有「移出」）
      el('button', { class: 'btn sm', disabled: one ? 'true' : null, title: one ? '至少选两本才能合并' : '把选中的书合并为同一部作品的不同版本', onclick: () => mergeSelected([...selected]) }, '⇄ 合并'),
      el('button', { class: 'btn sm ghost', disabled: none ? 'true' : null, onclick: () => addToCollectionFlow([...selected]) }, '＋ 加入专题'),
      el('button', { class: 'btn sm ghost', disabled: none ? 'true' : null, onclick: () => createCollectionFlow([...selected]) }, '新建专题'),
      collection ? el('button', { class: 'btn sm ghost danger-text', disabled: none ? 'true' : null, onclick: () => removeFromCollectionFlow(collection, [...selected]) }, '移出本专题') : null,
      el('button', { class: 'btn sm ghost', onclick: () => setSelMode(false) }, '完成')
    ].filter(x => x != null));
  }
  async function mergeSelected(ids) {
    if (ids.length < 2) return;
    try {
      const r = await api('/works/merge-batch', { method: 'POST', body: JSON.stringify({ ids }) });
      notify(`已合并 ${r.merged} 本到同一部作品`);
      setSelMode(false);
      await load();
    } catch (e) { alert(e.message); }
  }
  // 捕获阶段拦掉卡片的「打开详情」，批量模式下点击 = 勾选
  grid.addEventListener('click', e => {
    if (!selMode) return;
    const card = e.target.closest('.book-card');
    if (!card) return;
    e.preventDefault(); e.stopPropagation();
    const id = card.dataset.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    applySelMarks(); updateSelBar();
  }, true);

  async function load() {
    grid.innerHTML = ''; pager.innerHTML = '';
    const qs = new URLSearchParams();
    for (const k of ['q', 'sort']) { if (p0.get(k)) qs.set(k, p0.get(k)); }
    if (formatNow) qs.set('format', formatNow);
    if (pubsNow.length) qs.set('publisher', pubsNow.join(','));
    if (authsNow.length) qs.set('author', authsNow.join(','));
    if (colId) qs.set('col', colId);
    qs.set('page', state.page);
    qs.set('limit', String(state.pageSize));
    grid.append(el('div', { class: 'spinner' }));
    const data = await api('/books?' + qs.toString());
    grid.innerHTML = '';
    selected.clear();
    updateSelBar();
    if (!data.items.length) {
      const kw = (p0.get('q') || '').trim();
      const box = el('div', { class: 'empty', style: 'grid-column:1/-1' });
      if (kw) {
        // 1.9.0：搜不到 → 一键通知管理员，后台能看到用户搜的是什么
        const btn = el('button', { class: 'btn sm ghost', style: 'margin-top:10px' }, '📣 没找到，通知管理员');
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = '发送中…';
          try {
            await api('/search-notify', { method: 'POST', body: JSON.stringify({ q: kw, scope: collection ? 'collection' : 'library' }) });
            btn.textContent = '✓ 已通知管理员';
            notify('已把这次搜索词发给管理员');
          } catch (e) { btn.textContent = '发送失败，重试'; btn.disabled = false; alert(e.message); }
        });
        box.append(
          el('div', { class: 'big' }, '🔍'),
          el('p', {}, `没有找到匹配「${kw}」的书。`),
          el('p', { class: 'muted-sm' }, '可以换个关键词，或试试「✦ AI找书」用一句话描述；也可以让管理员知道书库里缺什么。'),
          btn);
      } else {
        box.append(
          el('div', { class: 'big' }, collection ? '📁' : '📚'),
          el('p', {}, collection
            ? '这个专题还是空的：点上面的「☑ 批量」，勾选书籍后加入本专题。'
            : '还没有图书。请管理员在「管理后台 → 图书库」添加 NAS 目录并扫描。'));
      }
      grid.append(box);
      return;
    }
    for (const b of data.items) {
      const card = bookCard(b);
      if (canEdit) card.append(el('span', { class: 'card-check' }, '✓'));
      grid.append(card);
    }
    applySelMarks();
    pager.append(el('span', { class: 'pager-total' }, `共 ${data.total} 本`));
    if (data.pages > 1) {
      const goPage = n => {
        const v = Math.max(1, Math.min(data.pages, parseInt(n, 10) || 0));
        if (!v || v === state.page) return false;
        state.page = v; load(); scroll(0, 0);
        return true;
      };
      pager.append(el('button', { disabled: state.page <= 1 ? 'true' : null, onclick: () => goPage(state.page - 1) }, '上一页'));
      pager.append(el('button', { class: 'cur' }, `${data.page} / ${data.pages}`));
      pager.append(el('button', { disabled: state.page >= data.pages ? 'true' : null, onclick: () => goPage(state.page + 1) }, '下一页'));
      const jumpInput = el('input', {
        class: 'pager-input', type: 'number', min: '1', max: String(data.pages),
        placeholder: String(data.page), 'aria-label': '输入页码'
      });
      jumpInput.addEventListener('keydown', e => { if (e.key === 'Enter') goPage(jumpInput.value); });
      pager.append(el('span', { class: 'pager-jump' }, '跳至', jumpInput,
        el('span', { class: 'muted-sm' }, `页 / 共 ${data.pages} 页`),
        el('button', { class: 'btn sm ghost', onclick: () => goPage(jumpInput.value) }, '跳转')));
    }
    const sizeSel = el('select', { class: 'page-size', 'aria-label': '每页显示数量' });
    for (const n of PAGE_SIZES) {
      const o = el('option', { value: String(n) }, `${n} 本`);
      if (n === state.pageSize) o.selected = true;
      sizeSel.append(o);
    }
    sizeSel.addEventListener('change', () => {
      const n = Math.min(200, Math.max(1, parseInt(sizeSel.value, 10) || 24));
      state.pageSize = n;
      try { localStorage.setItem('fb_pageSize', String(n)); } catch (_) {}
      state.page = 1; load();
    });
    pager.append(el('span', { class: 'pager-size' }, '每页', sizeSel));
  }

  app.innerHTML = ''; app.append(layout);
  await load();
}


// ===== 轻提示（1.8.2）=====
function notify(msg) {
  let box = document.querySelector('.toast-wrap');
  if (!box) { box = el('div', { class: 'toast-wrap' }); document.body.append(box); }
  const t = el('div', { class: 'toast' }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2800);
}

// ===== 专题管理弹窗（1.8.2）=====
function modalBox(title, children, actions) {
  const mask = el('div', { class: 'modal-mask' });
  const box = el('div', { class: 'modal' }, el('h3', {}, title));
  for (const c of children) if (c) box.append(c);
  const act = el('div', { class: 'modal-act' });
  for (const [label, cls, fn] of actions) {
    act.append(el('button', { class: 'btn ' + (cls || ''), onclick: fn }, label));
  }
  box.append(act);
  mask.append(box);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  document.body.append(mask);
  return { mask, box, close: () => mask.remove() };
}

/** 新建专题（可带上已选书籍；搜索后批量建专题就走这里） */
function createCollectionFlow(bookIds, after) {
  bookIds = (bookIds || []).filter(Boolean);
  const nameIn = el('input', { type: 'text', placeholder: '例如：中国史入门 / 想读的科幻' });
  const descIn = el('input', { type: 'text', placeholder: '一句话说明（可留空）' });
  const hint = el('p', { class: 'muted-sm', style: 'margin-top:8px' },
    bookIds.length ? `创建后把已选的 ${bookIds.length} 本书直接放进去。` : '专题建好后可以随时往里加书。');
  const m = modalBox('新建专题', [
    el('div', { class: 'field' }, el('label', {}, '专题名称'), nameIn),
    el('div', { class: 'field' }, el('label', {}, '简介（可选）'), descIn),
    hint
  ], [
    ['取消', 'ghost', () => m.close()],
    ['创建', '', async e => {
      const name = nameIn.value.trim();
      if (!name) return nameIn.focus();
      e.target.disabled = true;
      try {
        const r = await api('/collections', { method: 'POST', body: JSON.stringify({ name, desc: descIn.value.trim(), bookIds }) });
        m.close();
        notify(`专题「${name}」已创建${r.collection.keys ? '，共 ' + r.collection.keys + ' 本' : ''}`);
        if (after) after(); else render();
      } catch (err) { alert(err.message); e.target.disabled = false; }
    }]
  ]);
  setTimeout(() => nameIn.focus(), 60);
}

/** 把选中的书加入已有专题 */
/**
 * 1.9.0：批量编辑专题——一次勾选多个专题，把选中的书一起加进去或一起移出。
 * 以前只能一本一本地塞进某一个专题，整理「同一批书要进好几个专题」很麻烦。
 */
async function addToCollectionFlow(bookIds) {
  bookIds = (bookIds || []).filter(Boolean);
  if (!bookIds.length) return;
  let items = [];
  try { items = (await api('/collections')).items || []; } catch (e) { return alert(e.message); }
  if (!items.length) return createCollectionFlow(bookIds);
  const picked = new Set();
  const list = el('div', { class: 'col-pick' });
  for (const c of items) {
    const cb = el('input', { type: 'checkbox', value: c.id });
    cb.addEventListener('change', () => {
      if (cb.checked) picked.add(c.id); else picked.delete(c.id);
      hint.textContent = picked.size ? `已勾选 ${picked.size} 个专题` : '勾选要处理的专题（可多选）';
    });
    list.append(el('label', { class: 'col-pick-row' }, cb,
      el('span', { class: 'col-pick-name' }, '📁 ' + c.name),
      el('span', { class: 'muted-sm' }, `${c.count} 本`)));
  }
  const hint = el('p', { class: 'muted-sm', style: 'margin:8px 0 0' }, '勾选要处理的专题（可多选）');
  const m = modalBox(`批量编辑专题 · 已选 ${bookIds.length} 本`, [list, hint], [
    ['新建专题', 'ghost', () => { m.close(); createCollectionFlow(bookIds); }],
    ['取消', 'ghost', () => m.close()],
    ['移出所选专题', 'ghost danger-text', async e => {
      if (!picked.size) return alert('先勾选要移出的专题');
      e.target.disabled = true;
      try {
        const r = await api('/collections/batch', { method: 'POST', body: JSON.stringify({ action: 'remove', ids: [...picked], bookIds }) });
        m.close();
        notify(`已从 ${picked.size} 个专题移出 ${r.removed || 0} 项（书仍在书库里）`);
        state.collections = null; render();
      } catch (err) { alert(err.message); e.target.disabled = false; }
    }],
    ['加入所选专题', '', async e => {
      if (!picked.size) return alert('先勾选要加入的专题');
      e.target.disabled = true;
      try {
        const r = await api('/collections/batch', { method: 'POST', body: JSON.stringify({ action: 'add', ids: [...picked], bookIds }) });
        m.close();
        notify(`已加入 ${picked.size} 个专题（新增 ${r.added || 0} 项）`);
        state.collections = null; render();
      } catch (err) { alert(err.message); e.target.disabled = false; }
    }]
  ]);
}

async function removeFromCollectionFlow(c, bookIds) {
  if (!bookIds || !bookIds.length) return;
  try {
    const r = await api(`/collections/${c.id}/items`, { method: 'DELETE', body: JSON.stringify({ bookIds }) });
    notify(`已从「${c.name}」移出 ${r.removed} 本（书籍仍在书库里）`);
    render();
  } catch (e) { alert(e.message); }
}

function renameCollectionFlow(c) {
  const nameIn = el('input', { type: 'text' });
  nameIn.value = c.name;
  const descIn = el('input', { type: 'text', placeholder: '一句话说明（可留空）' });
  descIn.value = c.desc || '';
  const m = modalBox('修改专题', [
    el('div', { class: 'field' }, el('label', {}, '专题名称'), nameIn),
    el('div', { class: 'field' }, el('label', {}, '简介'), descIn)
  ], [
    ['取消', 'ghost', () => m.close()],
    ['保存', '', async e => {
      const name = nameIn.value.trim();
      if (!name) return nameIn.focus();
      e.target.disabled = true;
      try {
        await api('/collections/' + c.id, { method: 'PUT', body: JSON.stringify({ name, desc: descIn.value.trim() }) });
        m.close(); notify('已保存'); render();
      } catch (err) { alert(err.message); e.target.disabled = false; }
    }]
  ]);
  setTimeout(() => nameIn.focus(), 60);
}

function deleteCollectionFlow(c) {
  if (!confirm(`删除专题「${c.name}」？\n\n只删除这个分类，里面的书仍然留在书库，不会被删除。`)) return;
  api('/collections/' + c.id, { method: 'DELETE' })
    .then(() => { notify('专题已删除'); state.page = 1; location.hash = '#/collections'; render(); })
    .catch(e => alert(e.message));
}

/**
 * 1.9.0：给专题设封面。
 * 三种来源：上传一张图 / 用专题里某本书的封面 / 恢复默认（自动拼）。
 */
async function openCollectionCover(c) {
  const mask = el('div', { class: 'modal-mask' });
  const box = el('div', { class: 'modal cover-modal' });
  mask.append(box);
  document.body.append(mask);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });

  const msg = el('div', { class: 'cv-msg' });
  const body = el('div', { class: 'cv-body' });
  box.append(
    el('h3', {}, '🖼 专题封面 · ' + c.name),
    el('p', { class: 'muted-sm' }, '上传一张图，或者直接借用专题里某本书的封面。设置后专题总览页会显示这张图。'),
    body, msg,
    el('div', { class: 'modal-act' },
      el('button', { class: 'btn ghost', onclick: () => mask.remove() }, '关闭'),
      el('button', {
        class: 'btn ghost', onclick: async () => {
          try {
            await api(`/collections/${c.id}/cover`, { method: 'POST', body: JSON.stringify({ source: 'reset' }) });
            mask.remove(); notify('已恢复默认封面'); render();
          } catch (e) { msg.textContent = e.message; }
        }
      }, '恢复默认')));

  async function apply(payload) {
    msg.textContent = '正在保存…';
    try {
      await api(`/collections/${c.id}/cover`, { method: 'POST', body: JSON.stringify(payload) });
      msg.textContent = '✅ 已更新';
      setTimeout(() => { mask.remove(); render(); }, 400);
    } catch (e) { msg.textContent = '保存失败：' + e.message; }
  }

  // ① 上传
  const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
  const upBtn = el('button', { class: 'btn sm' }, '⬆ 上传图片');
  upBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) { msg.textContent = '图片太大了（上限 6MB）'; return; }
    const fr = new FileReader();
    fr.onload = () => {
      // 统一压到 600px 宽，省空间也避免大图拖慢列表
      const img = new Image();
      img.onload = () => {
        const w = Math.min(600, img.naturalWidth || 600);
        const cv = el('canvas');
        cv.width = w;
        cv.height = Math.round(w * (img.naturalHeight || 800) / (img.naturalWidth || 600));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        apply({ dataUrl: cv.toDataURL('image/jpeg', 0.86) });
      };
      img.onerror = () => { msg.textContent = '这张图读不出来'; };
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
  });
  body.append(el('div', { class: 'cv-row' }, upBtn, fileIn));

  // ② 借用专题里某本书的封面
  const listBox = el('div', { class: 'cv-grid' });
  body.append(el('p', { class: 'muted-sm', style: 'margin-top:12px' }, '或者从专题里的书中挑一张：'), listBox);
  listBox.append(el('span', { class: 'muted-sm' }, '读取中…'));
  try {
    const d = await api(`/books?col=${encodeURIComponent(c.id)}&limit=18&page=1`);
    listBox.innerHTML = '';
    if (!d.items.length) listBox.append(el('span', { class: 'muted-sm' }, '这个专题里还没有书。'));
    for (const b of d.items) {
      const item = el('div', { class: 'cv-item' },
        el('img', { src: A(`/api/cover/${b.id}${tokenQ()}`), loading: 'lazy', alt: b.title }),
        el('div', { class: 'cv-name' }, b.title));
      item.addEventListener('click', () => apply({ bookId: b.id }));
      listBox.append(item);
    }
  } catch (e) { listBox.textContent = '读取失败：' + e.message; }
}

/**
 * 1.9.0：下载 APP 页面。
 * 管理员在「管理后台 → APP 安装包」里上传两个 APK（手机/平板、TV），这里给下载入口。
 */
async function renderAppPage(app) {
  const { layout, sidebar, main } = shell('');
  main.append(el('div', { class: 'topbar' }, el('h1', {}, '📱 下载 APP')));
  main.append(el('p', { class: 'col-desc' },
    '安卓客户端为原生外壳 + 内置网页，装上后直接进这本书屋。首次打开填 NAS 地址即可（例如 192.168.1.10:8096）。'));
  app.innerHTML = ''; app.append(layout);

  const info = el('div', { class: 'app-grid' });
  main.append(info);
  info.append(el('div', { class: 'spinner' }));

  let data;
  try { data = await api('/app/info'); }
  catch (e) { info.innerHTML = ''; info.append(el('p', { class: 'muted-sm' }, '读取失败：' + e.message)); return; }
  info.innerHTML = '';

  const kinds = [
    ['phone', '📱 手机 / 平板版', '触屏操作，跟随系统方向，支持分屏'],
    ['tv', '📺 TV 版', '遥控器方向键操作，横屏全屏，字号更大']
  ];
  for (const [k, label, desc] of kinds) {
    const m = data.items[k];
    const card = el('div', { class: 'app-card' },
      el('div', { class: 'app-card-title' }, label),
      el('div', { class: 'app-card-desc' }, desc));
    if (m) {
      card.append(
        el('div', { class: 'app-meta' }, `版本 ${m.version || '—'} · ${fmtSize(m.size || 0)} · ${fmtDate(m.at || Date.now())}`),
        el('button', {
          class: 'btn', onclick: e => saveFile(A(`/api/app/download/${k}`), `fnbookshelf-${k}-${m.version || 'latest'}.apk`, e.currentTarget)
        }, '⬇ 下载安装包'));
      card.append(el('p', { class: 'muted-sm', style: 'margin-top:8px' },
        '安装后打开 APP，它会自动检查更新：有新版本时提示下载并直接调起安装。'));
    } else {
      card.append(el('p', { class: 'muted-sm', style: 'margin-top:10px' },
        state.user && state.user.role === 'admin'
          ? '还没有上传安装包：到「管理后台 → APP 安装包」里上传。'
          : '管理员还没有上传这个版本的安装包。'));
      if (state.user && state.user.role === 'admin') {
        card.append(el('a', { class: 'btn sm ghost', href: '#/admin' }, '去上传'));
      }
    }
    info.append(card);
  }
}

async function openAiSearch(main, preset, opts) {
  opts = opts || {};
  // 1.8.1：找书默认走「本地全库检索」，AI 只是可选的重排；没配 AI 也能用
  let cfg = null;
  try { cfg = await api('/ai/config'); } catch (_) {}
  if (cfg && cfg.features && cfg.features.recommend === false) return alert('管理员已关闭书库推荐功能');
  const q = prompt('想读什么样的书？例如：\n· 讲中国近代史、偏通俗的\n· 和《三体》气质接近的科幻\n· 能提升写作能力的实用书', preset || '');
  if (!q) return;
  const head = el('span', {}, '✦ 正在书库中检索…');
  const box = el('div', { class: 'ai-result' }, el('div', { class: 'ai-result-head' }, head));
  const grid = el('div', { class: 'grid' });
  const noteEl = el('div', { class: 'muted-sm ai-note' });
  box.append(grid, noteEl);
  main.insertBefore(box, main.children[1] || null);
  try {
    const r = await api('/ai/recommend', { method: 'POST', body: JSON.stringify({ query: q, limit: 8 }) });
    const mode = r.mode === 'ai' ? 'AI 精选' : '本地检索';
    const more = r.matched > r.items.length ? `（书库共 ${r.matched} 本相关）` : '';
    const quota = r.quota && r.mode === 'ai' ? ` · 今日 AI 剩余 ${r.quota.left}/${r.quota.limit} 次` : '';
    head.textContent = `✦ ${mode} · 找到 ${r.items.length} 本${more}${quota}`;
    if (!r.items.length) {
      const p = el('div', { class: 'muted-sm' }, r.hint || '书库里暂时没有匹配的书，换个说法试试。');
      const btn = el('button', { class: 'btn sm ghost', style: 'margin-top:8px' }, '📣 没找到，通知管理员');
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '发送中…';
        try {
          await api('/search-notify', { method: 'POST', body: JSON.stringify({ q, scope: 'ai' }) });
          btn.textContent = '✓ 已通知管理员';
        } catch (e) { btn.textContent = '发送失败，重试'; btn.disabled = false; }
      });
      grid.append(p, btn);
    }
    for (const b of r.items) {
      const card = bookCard(b);
      if (b.reason) card.append(el('div', { class: 'ai-reason' }, '✦ ' + b.reason));
      grid.append(card);
    }
    if (r.note) noteEl.textContent = 'ℹ ' + r.note;
  } catch (e) {
    head.textContent = '✦ ' + e.message;
  }
}

function bookCard(b) {
  // 1.6.0：移除原生 draggable，合并只在「合并模式」下通过自定义指针拖拽进行
  const card = el('div', { class: 'book-card', 'data-id': b.id });
  const badges = [];
  if (b.versions > 1) badges.push(el('span', { class: 'ver-tag' }, `${b.versions} 个版本`));
  if (b.anns && b.anns.bookmarks) badges.push(el('span', { class: 'ver-tag bm' }, `🔖 ${b.anns.bookmarks}`));
  if (b.anns && b.anns.notes) badges.push(el('span', { class: 'ver-tag nt' }, `✎ ${b.anns.notes}`));
  card.append(
    el('div', { class: 'cover' },
      el('img', { class: 'cover-img', src: A(`/api/cover/${b.id}${tokenQ()}`), loading: 'lazy', alt: b.title }),
      badges.length ? el('div', { class: 'cover-badges' }, badges) : null),
    el('div', { class: 'b-title' }, b.title),
    el('div', { class: 'b-author' }, b.author || '未知作者'),
    b.year ? el('div', { class: 'b-year' }, b.year) : null
  );
  card.addEventListener('click', () => { location.hash = '#/book/' + b.id; });
  return card;
}

// ===== 我的书架（上下三栏：在架 / 近期阅读未收藏 / 每日推荐） =====
async function renderShelf(app) {
  const { layout, sidebar, main } = shell('shelf');

  main.append(el('div', { class: 'topbar' }, el('h1', {}, '⭐ 我的书架')));
  const flow = el('div', { class: 'shelf-flow' });
  main.append(flow);
  app.innerHTML = ''; app.append(layout);
  flow.append(el('div', { class: 'spinner' }));

  const data = await api('/shelf/home');
  state.shelfIds = (data.shelf || []).map(b => b.id);
  flow.innerHTML = '';

  const quickAdd = b => {
    const btn = el('button', { class: 'qs-add', title: '加入书架' }, '＋ 加入书架');
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await api(`/shelf/${b.id}`, { method: 'PUT' });
        btn.textContent = '✓ 已加入';
        setTimeout(() => render(), 600);
      } catch (err) { alert(err.message); btn.disabled = false; }
    });
    return btn;
  };

  function section(opt) {
    const sec = el('section', { class: 'shelf-sec' });
    const head = el('div', { class: 'sec-head' },
      el('h2', {}, opt.title),
      opt.hint ? el('span', { class: 'sec-hint' }, opt.hint) : null,
      el('span', { style: 'flex:1' }),
      opt.count != null ? el('span', { class: 'sec-count' }, `${opt.count} 本`) : null);
    sec.append(head);
    if (!opt.items.length) {
      sec.append(el('div', { class: 'sec-empty' }, opt.empty));
      return sec;
    }
    const grid = el('div', { class: 'grid' });
    for (const b of opt.items) {
      const card = bookCard(b);
      if (opt.decorate) opt.decorate(card, b);
      grid.append(card);
    }
    sec.append(grid);
    return sec;
  }

  // ① 已加入书架
  flow.append(section({
    title: '📌 我的收藏',
    hint: '你主动加入书架的书',
    count: (data.shelf || []).length,
    items: data.shelf || [],
    empty: '书架还是空的：在图书详情页点「♡ 加入书架」，或在下方「最近在读」里一键加入。'
  }));

  // ② 近期阅读但未加入书架
  flow.append(section({
    title: '🕘 最近在读',
    hint: '读过但还没放进书架',
    count: (data.recent || []).length,
    items: data.recent || [],
    empty: '还没有阅读记录。打开任意一本书，这里就会自动出现。',
    decorate: (card, b) => {
      card.classList.add('card-reading');
      const pct = Math.max(0, Math.min(100, Math.round(b.pct || 0)));
      card.append(el('div', { class: 'card-progress' },
        el('div', { class: 'cp-bar' }, el('i', { style: `width:${pct}%` })),
        el('span', {}, pct ? `已读 ${pct}%` : '刚翻开')));
      card.append(quickAdd(b));
    }
  }));

  // ③ 每日随机推荐（同一天固定，次日更换）
  flow.append(section({
    title: '🎲 今日为你推荐',
    hint: `${data.date || ''} · 每天换一批`,
    items: data.recommend || [],
    empty: '书库里的书都在你的书架或阅读记录里了，明天再来看看。'
  }));
}

// ===== 我的记录（全部书签与笔记，按书籍分组） =====
async function renderRecords(app) {
  const { layout, sidebar, main } = shell('records');

  main.append(el('div', { class: 'topbar' }, el('h1', {}, '🔖 我的记录'),
    el('span', { class: 'muted-sm', style: 'align-self:center' }, '全部书签与笔记 · 按书籍分组')));
  app.innerHTML = ''; app.append(layout);
  const holder = el('div', { class: 'records-wrap' });
  main.append(holder);
  holder.append(el('div', { class: 'spinner' }));
  const data = await api('/records');
  holder.innerHTML = '';

  if (!data.groups.length) {
    holder.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '🔖'),
      el('p', {}, '还没有任何书签或笔记。'),
      el('p', { class: 'muted-sm' }, '阅读时点击 🔖 添加书签，选中文字可以高亮或写笔记。')));
    return;
  }
  for (const g of data.groups) {
    const bm = g.annotations.filter(a => a.type === 'bookmark').length;
    const nt = g.annotations.length - bm;
    const panel = el('div', { class: 'panel rec-group' });
    const head = el('div', { class: 'rec-head', onclick: () => { location.hash = '#/book/' + g.bookId; } },
      el('div', { class: 'rec-title' }, g.title),
      el('div', { class: 'rec-sub' }, `${g.author || '未知作者'} · ${String(g.ext).toUpperCase()}`),
      el('div', { class: 'rec-counts' },
        bm ? el('span', { class: 'rc bm' }, `书签 ${bm}`) : null,
        nt ? el('span', { class: 'rc nt' }, `笔记 ${nt}`) : null));
    panel.append(head);
    const list = el('div', { class: 'rec-list' });
    for (const a of g.annotations.slice(0, 12)) {
      const typeLabel = { bookmark: '书签', highlight: '高亮', note: '笔记' }[a.type] || a.type;
      const when = new Date(a.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      list.append(el('div', { class: 'rec-item ' + a.type },
        el('span', { class: 'rec-type' }, typeLabel),
        a.quote ? el('div', { class: 'rec-quote' }, a.quote) : null,
        a.note ? el('div', { class: 'rec-note' }, a.note) : null,
        el('span', { class: 'rec-when' }, a.page ? `第 ${a.page} 页 · ` : '', when)));
    }
    if (g.annotations.length > 12) list.append(el('p', { class: 'muted-sm' }, `… 还有 ${g.annotations.length - 12} 条，打开书籍查看全部`));
    panel.append(list);
    holder.append(panel);
  }
}

// ===== 阅读统计 =====
async function renderMe(app) {
  const { layout, sidebar, main } = shell('me');

  main.append(el('div', { class: 'topbar' }, el('h1', {}, '📊 我的阅读')));
  app.innerHTML = ''; app.append(layout);
  const holder = el('div', { class: 'me-wrap' });
  main.append(holder);
  holder.append(el('div', { class: 'spinner' }));
  const s = await api('/me/stats');
  holder.innerHTML = '';

  const nowD = new Date();
  const today = new Date(nowD.getTime() - nowD.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const todaySec = (s.byDay || {})[today] || 0;
  const cards = el('div', { class: 'stat-cards' });
  const mkCard = (label, value, sub, ico) => el('div', { class: 'stat-card' },
    el('div', { class: 'st-label' }, el('span', { class: 'st-ico' }, ico || ''), label),
    el('div', { class: 'st-value' }, value),
    sub ? el('div', { class: 'st-sub' }, sub) : null);
  cards.append(
    mkCard('今日阅读', fmtDur(todaySec), todaySec ? '继续保持' : '今天还没开始', '☀️'),
    mkCard('累计阅读', fmtDur(s.totalSec), `共打开 ${s.opened || 0} 次`, '⏱'),
    mkCard('书架收藏', String(s.shelfCount || 0) + ' 本', `笔记 ${s.annotationCount || 0} 条`, '⭐'),
    mkCard('涉及图书', String(s.booksRead || 0) + ' 本', '读过的不同作品', '📚')
  );
  holder.append(cards);

  // 1.6.0：已读完的书籍（手工点「读过」 ∪ 进度到 100%）
  {
    const fin = el('div', { class: 'panel' }, el('h3', {}, `✅ 已读完的书籍（${(s.finished || []).length}）`));
    if (!(s.finished || []).length) {
      fin.append(el('p', { class: 'muted-sm' }, '还没有读完的书。在书籍详情页点「○ 标为读过」，或把阅读进度读到 100%，就会自动出现在这里。'));
    } else {
      const list = el('div', { class: 'fin-list' });
      for (const f of s.finished) {
        list.append(el('div', { class: 'fin-row', onclick: () => { location.hash = '#/book/' + f.bookId; } },
          el('img', { class: 'fin-cover', src: A(`/api/cover/${f.bookId}${tokenQ()}`), loading: 'lazy', alt: '' }),
          el('div', { class: 'fin-main' },
            el('div', { class: 'fin-title' }, f.title),
            el('div', { class: 'fin-sub' }, `${f.author || '未知作者'} · ${String(f.ext).toUpperCase()} · ${new Date(f.at).toLocaleDateString('zh-CN')} 读完`)),
          el('span', { class: 'fin-badge' }, '100%')));
      }
      fin.append(list);
    }
    holder.append(fin);
  }

  const chart = el('div', { class: 'panel chart-panel' }, el('h3', {}, '近 7 天阅读时长'));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowD.getTime() - i * 86400000);
    const key = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, sec: (s.byDay || {})[key] || 0 });
  }
  const maxSec = Math.max(60, ...days.map(d => d.sec));
  const bars = el('div', { class: 'bars' });
  for (const d of days) {
    const h = Math.max(3, Math.round(d.sec / maxSec * 100));
    bars.append(el('div', { class: 'bar-col' + (d.key === today ? ' today' : ''), title: `${d.label} ${fmtDur(d.sec)}` },
      el('div', { class: 'bar-val' }, d.sec ? Math.round(d.sec / 60) + "'" : ''),
      el('div', { class: 'bar-area' },
        el('div', { class: 'bar' + (d.sec ? '' : ' zero'), style: `height:${h}%` })),
      el('div', { class: 'bar-label' }, d.label)));
  }
  chart.append(bars, el('p', { class: 'muted-sm', style: 'margin-top:10px' },
    `近 7 天合计 ${fmtDur(days.reduce((a, d) => a + d.sec, 0))} · 柱高按 7 天内最高一天归一化`));
  holder.append(chart);

  if ((s.byBook || []).length) {
    const top = el('div', { class: 'panel' }, el('h3', {}, '阅读时长 Top'));
    for (const b of s.byBook.slice(0, 8)) {
      top.append(el('div', { class: 'row-line', onclick: () => { location.hash = '#/book/' + b.bookId; } },
        el('span', { class: 'rl-title' }, b.title),
        el('span', { class: 'rl-meta' }, fmtDur(b.sec))));
    }
    holder.append(top);
  }

  const hist = el('div', { class: 'panel' }, el('h3', {}, '阅读记录'));
  if (!(s.history || []).length) hist.append(el('p', { class: 'muted-sm' }, '还没有阅读记录，去书库挑一本开始吧。'));
  for (const h of s.history || []) {
    const pct = h.progress && h.progress.pct ? Math.round(h.progress.pct) : 0;
    hist.append(el('div', { class: 'hist-row', onclick: () => { location.hash = '#/book/' + h.bookId; } },
      el('div', { class: 'hist-info' },
        el('div', { class: 'hist-title' }, h.title),
        el('div', { class: 'hist-sub' }, `${h.author || '未知作者'} · ${String(h.ext).toUpperCase()} · 进度 ${pct}%`),
        el('div', { class: 'hist-bar' }, el('i', { style: `width:${pct}%` }))),
      el('div', { class: 'hist-time' }, new Date(h.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))));
  }
  holder.append(hist);
}

// ===== 1.6.0：PPT 后台转换面板（详情页） =====
function convertPanel(b) {
  const box = el('div', { class: 'panel conv-panel' });
  box.append(el('h3', {}, '⚙ PPT 转 PDF'));
  // 1.7.1：一个文件只允许转换一次——只要转换生成的 PDF 还在（没被删除），入口就锁住
  const done = (b.versions || []).find(v => v.generated && v.generatedFrom === b.id) || null;
  box.append(el('p', { class: 'muted-sm' },
    '图片型 PPT 由服务端逐页提取整页图片并合成 PDF；若 NAS 已自带 LibreOffice 会优先借用它。转换在后台进行，完成后把新 PDF 作为本书的一个新版本加入书库（源文件不动）。'));
  const status = el('div', { class: 'conv-status' });
  if (done) {
    status.textContent = `已转换过：${done.filename}（${done.pages || '—'} 页）。同一个文件只转换一次；如需重新转换，请先在上面「版本管理」里删除这个 PDF 版本。`;
  } else if (b.convert && b.convert.status === 'done') {
    status.textContent = `上次转换完成：${b.convert.pages} 页 · 引擎 ${({ 'builtin-image': '内置逐页取图', libreoffice: '系统 LibreOffice', 'browser-canvas': '浏览器渲染', cached: '复用' })[b.convert.engine] || b.convert.engine}，已作为新版本入库。`;
  } else status.textContent = '尚未转换。';
  box.append(status);
  const canDo = canEditNow();
  const btn = el('button', { class: 'btn sm', disabled: (done || !canDo) ? 'true' : null },
    done ? '✓ 已转换（不可重复）' : (canDo ? '⚙ 后台转换' : '⚙ 后台转换（仅管理员）'));
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true; status.textContent = '正在启动后台任务…';
    try {
      const j = await api(`/books/${b.id}/convert`, { method: 'POST', body: JSON.stringify({}) });
      await poll(j.jobId);
    } catch (e) { status.textContent = '启动失败：' + e.message; btn.disabled = false; }
  });
  async function poll(jobId) {
    for (let i = 0; i < 240; i++) {
      await new Promise(r => setTimeout(r, 700));
      let j;
      try { j = await api('/convert/' + jobId); } catch (_) { continue; }
      if (j.state === 'done') {
        status.textContent = `✅ ${j.message}（新版本 ID ${j.result && j.result.versionId ? j.result.versionId.slice(0, 8) : '—'}）`;
        btn.disabled = false;
        setTimeout(() => render(), 900);
        return;
      }
      if (j.state === 'failed') { status.textContent = '❌ 转换失败：' + (j.error || '未知原因'); btn.disabled = false; return; }
      status.textContent = `${j.message}${j.total ? `（${j.done}/${j.total}）` : ''}`;
    }
    status.textContent = '任务仍在后台运行，稍后刷新详情页查看结果。';
    btn.disabled = false;
  }
  box.append(btn);
  return box;
}

// ===== 1.6.0：封面设置弹窗（刮削图 / 同目录图片 / 书内某一页） =====
async function openCoverPicker(b) {
  const mask = el('div', { class: 'modal-mask' });
  const box = el('div', { class: 'modal cover-modal' });
  mask.append(box);
  document.body.append(mask);
  box.append(el('h3', {}, '🖼 设置封面'), el('p', { class: 'muted-sm' }, '手动选择后，重新扫描或刮削都不会覆盖你选的封面。同一部作品的所有版本会一起更新。'));
  const tabs = el('div', { class: 'cv-tabs' });
  const body = el('div', { class: 'cv-body' });
  const msg = el('div', { class: 'cv-msg' });
  box.append(tabs, body, msg);
  box.append(el('div', { class: 'modal-act' },
    el('button', { class: 'btn ghost', onclick: () => mask.remove() }, '关闭'),
    el('button', { class: 'btn ghost', onclick: async () => {
      try { await api(`/books/${b.id}/cover`, { method: 'POST', body: JSON.stringify({ source: 'reset' }) }); mask.remove(); render(); }
      catch (e) { msg.textContent = e.message; }
    } }, '恢复自动封面')));
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });

  let opt;
  try { opt = await api(`/books/${b.id}/cover-options`); }
  catch (e) { msg.textContent = '读取候选失败：' + e.message; return; }

  async function apply(payload) {
    msg.textContent = '正在保存…';
    try {
      await api(`/books/${b.id}/cover`, { method: 'POST', body: JSON.stringify(payload) });
      msg.textContent = '✅ 已更新封面';
      setTimeout(() => { mask.remove(); render(); }, 450);
    } catch (e) { msg.textContent = '保存失败：' + e.message; }
  }
  function tab(name, label) {
    const t = el('button', { class: 'cv-tab' + (name === 'scraped' ? ' on' : ''), 'data-tab': name }, label);
    t.addEventListener('click', () => {
      tabs.querySelectorAll('.cv-tab').forEach(x => x.classList.remove('on'));
      t.classList.add('on'); show(name);
    });
    return t;
  }
  tabs.append(tab('scraped', '刮削封面'), tab('neighbor', '同目录图片'), tab('upload', '上传图片'), tab('page', '书内某一页'));

  function show(which) {
    body.innerHTML = ''; msg.textContent = '';
    if (which === 'scraped') {
      if (!opt.scraped) {
        body.append(el('p', { class: 'muted-sm' }, '这本书还没有刮削/书内提取到封面。可以等后台刮削完成，或改选「同目录图片」「书内某一页」。'));
      } else {
        body.append(el('div', { class: 'cv-preview' },
          el('img', { src: opt.scrapedUrl + '&t=' + Date.now(), alt: '刮削封面' })));
      }
      body.append(el('p', { class: 'muted-sm' }, opt.coverSource === 'manual' ? '当前封面已锁定为手动选择。' : '选自刮削结果或书籍文件内嵌封面。'));
      body.append(el('button', { class: 'btn sm', disabled: opt.scraped ? null : 'true', onclick: () => apply({ source: 'scraped' }) }, '使用这张封面'));
      return;
    }
    if (which === 'neighbor') {
      // 1.9.1：同目录优先；同目录没图时列出上级目录的图，并且每张图都直出「为什么不能用」的原因
      const dirBox = el('p', { class: 'muted-sm' }, '书籍目录：' + (opt.dir || '—'));
      body.append(dirBox);
      if (!opt.neighbors.length && !(opt.parentImages || []).length) {
        body.append(el('p', { class: 'muted-sm' },
          '书籍文件所在目录（以及它的上级目录）里都没有找到图片。可以把封面图放到书籍同一目录（jpg / png / webp / gif / bmp），或者切到「上传图片」直接从电脑选一张。'));
        body.append(el('button', { class: 'btn sm', onclick: () => {
          tabs.querySelectorAll('.cv-tab').forEach(x => x.classList.remove('on'));
          tabs.querySelector('[data-tab="upload"]').classList.add('on');
          show('upload');
        } }, '⬆ 去上传图片'));
        return;
      }
      let picked = null;
      const pickBtn = el('button', { class: 'btn sm', disabled: 'true', style: 'margin-top:10px' }, '用选中的图片做封面');
      const gridOf = (list, note) => {
        const wrap = el('div');
        if (note) wrap.append(el('p', { class: 'muted-sm', style: 'margin-bottom:6px' }, note));
        const grid = el('div', { class: 'cv-grid' });
        for (const n of list) {
          const label = n.label || n.name;
          const item = el('div', { class: 'cv-item', title: label },
            el('img', { src: n.url, loading: 'lazy', alt: label }),
            el('div', { class: 'cv-name' }, label));
          item.addEventListener('click', () => {
            grid.querySelectorAll('.cv-item').forEach(x => x.classList.remove('on'));
            item.classList.add('on');
            picked = n.name;
            pickBtn.disabled = false;
          });
          grid.append(item);
        }
        wrap.append(grid);
        return wrap;
      };
      if (opt.neighbors.length) body.append(gridOf(opt.neighbors));
      if ((opt.parentImages || []).length) {
        body.append(gridOf(opt.parentImages,
          `同目录里没有图片，下面是上级目录 ${opt.parentDir || ''} 里的图片（点选后会用这张做封面）：`));
      }
      pickBtn.addEventListener('click', () => {
        if (!picked) return msg.textContent = '先点选一张图片';
        apply({ source: 'neighbor', name: picked });
      });
      body.append(pickBtn,
        el('p', { class: 'muted-sm', style: 'margin-top:8px' },
          `只支持 jpg / jpeg / png / webp / gif / bmp；图片必须和书籍文件在同一个目录（或上级目录），不能引用书库以外的地方。`));
      return;
    }
    if (which === 'upload') {
      // 1.9.1：上传本地图片做封面
      const maxMB = opt.maxUploadMB || 8;
      const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp', style: 'display:none' });
      const drop = el('div', { class: 'cv-drop' },
        el('div', { style: 'font-size:28px;line-height:1.2' }, '⬆'),
        el('div', { style: 'font-weight:600;margin-top:6px' }, '点击选择图片，或把图片拖到这里'),
        el('div', { class: 'muted-sm', style: 'margin-top:4px' }, `支持 jpg / png / webp / gif / bmp，最大 ${maxMB}MB`));
      const prev = el('div', { class: 'cv-preview', style: 'display:none' });
      const prevImg = el('img', { alt: '待上传的封面' });
      prev.append(prevImg);
      const upBtn = el('button', { class: 'btn sm', disabled: 'true', style: 'margin-top:10px' }, '用这张图片做封面');
      let dataUrl = '';

      const readFile = file => {
        if (!file) return;
        if (!/^image\/(jpeg|jpg|png|webp|gif|bmp)$/i.test(file.type) && !/\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)) {
          msg.textContent = '❌ 只支持 jpg / png / webp / gif / bmp 图片';
          return;
        }
        if (file.size > maxMB * 1048576) {
          msg.textContent = `❌ 图片 ${fmtSize(file.size)}，超过 ${maxMB}MB，请压缩后再上传`;
          return;
        }
        const fr = new FileReader();
        fr.onload = () => {
          dataUrl = String(fr.result || '');
          prevImg.src = dataUrl;
          prev.style.display = '';
          upBtn.disabled = false;
          msg.textContent = `已选择 ${file.name}（${fmtSize(file.size)}）`;
        };
        fr.onerror = () => { msg.textContent = '❌ 读取图片失败，请换一张试试'; };
        fr.readAsDataURL(file);
      };
      drop.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => readFile(fileInput.files && fileInput.files[0]));
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('on'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('on'));
      drop.addEventListener('drop', e => {
        e.preventDefault(); drop.classList.remove('on');
        readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
      });
      upBtn.addEventListener('click', () => { if (dataUrl) apply({ source: 'upload', dataUrl }); });
      body.append(fileInput, drop, prev, upBtn);
      return;
    }
    // 书内某一页
    const pg = opt.page || {};
    if (!pg.supported) {
      body.append(el('p', { class: 'muted-sm' }, '该格式暂不支持在详情页选页。PDF / CBZ / 已转换的 PPT 可以直接选页；其他格式请先用「同目录图片」或与源书放在同一目录的封面图。'));
      return;
    }
    const num = el('input', { type: 'number', min: '1', value: '1' });
    const preview = el('div', { class: 'cv-preview' });
    const canvas = el('canvas');
    const img = el('img');
    const loadBtn = el('button', { class: 'btn sm ghost' }, '预览这一页');
    body.append(el('div', { class: 'cv-pager' }, '第 ', num, ' 页 ', loadBtn, el('span', { class: 'muted-sm' }, `共约 ${pg.pages || '?'} 页`)), preview);
    let mode = pg.pdfUrl ? 'pdf' : 'img';
    let dataUrl = '';
    async function previewPage() {
      msg.textContent = '正在渲染…';
      const n = Math.max(1, parseInt(num.value) || 1);
      try {
        if (mode === 'pdf') {
          preview.innerHTML = ''; preview.append(canvas);
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
          const task = window.pdfjsLib.getDocument({ url: pg.pdfUrl, rangeChunkSize: 131072, disableAutoFetch: true });
          const doc = await task.promise;
          const p = await doc.getPage(Math.min(n, doc.numPages));
          const vp1 = p.getViewport({ scale: 1 });
          const sc = Math.min(300 / vp1.width, 380 / vp1.height);
          const vp = p.getViewport({ scale: sc });
          canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
          await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          dataUrl = canvas.toDataURL('image/jpeg', 0.88);
          try { doc.destroy(); } catch (_) {}
        } else {
          preview.innerHTML = ''; preview.append(img);
          await new Promise((resolve, reject) => {
            img.onload = resolve; img.onerror = () => reject(new Error('这一页读取失败'));
            img.src = pg.cbzUrl + n + '&t=' + Date.now();
          });
          const c = el('canvas');
          c.width = Math.min(600, img.naturalWidth || 400);
          c.height = Math.round(c.width * (img.naturalHeight || 600) / (img.naturalWidth || 400));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          dataUrl = c.toDataURL('image/jpeg', 0.88);
        }
        msg.textContent = '预览完成，可以设为封面了。';
        useBtn.disabled = false;
      } catch (e) { msg.textContent = '预览失败：' + e.message; useBtn.disabled = true; }
    }
    const useBtn = el('button', { class: 'btn sm', disabled: 'true', style: 'margin-top:10px', onclick: () => apply({ source: 'page', dataUrl }) }, '用这一页做封面');
    loadBtn.addEventListener('click', previewPage);
    num.addEventListener('change', () => { useBtn.disabled = true; });
    body.append(useBtn);
    previewPage();
  }
  show('scraped');
}

// ===== 详情 =====
async function renderDetail(app, id) {
  const b = await api('/books/' + id);
  b.scrapePending = !!b.scrapePending;
  // 1.8.2：刮削补全后不再整页重渲染。
  // 旧实现在 4 秒后 render() 一次，会把用户正在编辑的弹窗、版本「编辑」状态、滚动位置
  // 全部冲掉（表现为「刮削的时候点什么都没反应 / 点了几下就失败」）。
  // 现在只轮询轻量接口，就地更新书名、元数据行、简介与封面。
  const { layout, main } = shell('');
  app.innerHTML = ''; app.append(layout);
  // 1.8.3：从专题里点进来的书，返回上一级回到该专题
  const backCol = state.lastCol && (state.collections || []).some(c => c.id === state.lastCol) ? state.lastCol : '';
  main.append(el('a', { class: 'back', href: backCol ? '#/collections/' + encodeURIComponent(backCol) : '#/library' },
    backCol ? '← 返回专题' : '← 返回书库'));

  const info = el('div', { class: 'd-info' });
  const headEl = el('h2', {}, b.title);
  const metaBox = el('div', {});
  const descEl = el('div', { class: 'desc' });
  const actions = el('div', { class: 'd-actions' });
  info.append(headEl, metaBox, descEl, actions);

  // 元数据区整体由 fillMeta() 负责：刮削补全后只重画这一块，不动按钮、不动版本面板
  let refBook = b;   // 「编辑资料」按钮要用到最新的书名，补全后同步更新
  function fillMeta(x) {
    refBook = x;
    metaBox.innerHTML = '';
    metaBox.append(el('div', { class: 'meta-row' }, el('b', {}, x.author || '未知作者'),
      x.year ? el('span', { class: 'path-hint' }, ' · ' + x.year + ' 年') : null));
    if (x.publisher) metaBox.append(el('div', { class: 'meta-row' }, '出版社：', el('b', {}, x.publisher)));
    if (x.date) metaBox.append(el('div', { class: 'meta-row' }, '出版：', el('b', {}, x.date)));
    metaBox.append(el('div', { class: 'meta-row' }, '格式：', el('b', {}, String(x.ext).toUpperCase()), ` · ${fmtSize(x.size)} · ${fmtDate(x.addedAt)} 入库`));
    // 1.8.0：管理员需要知道文件到底存在 NAS 的哪个位置（点击可复制）
    if (x.path && state.user.role === 'admin') {
      const code = el('code', { class: 'path-code', title: '点击复制路径' }, x.path);
      code.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(x.path);
          const old = code.textContent;
          code.textContent = '✓ 已复制';
          setTimeout(() => { code.textContent = old; }, 1200);
        } catch (_) { alert(x.path); }
      });
      metaBox.append(el('div', { class: 'meta-row' }, '存储位置：', code));
    }
    if (x.isbn) metaBox.append(el('div', { class: 'meta-row' }, 'ISBN：', el('b', {}, x.isbn)));
    if (x.scrapeInfo) {
      const names = { douban: '豆瓣读书', isbn: 'ISBN 直达', dangdang: '当当图书' };
      metaBox.append(el('div', { class: 'meta-row' }, '刮削：',
        el('b', {}, names[x.scrapeInfo.provider] || x.scrapeInfo.provider || '—'),
        ` · 匹配度 ${Math.round((x.scrapeInfo.score || 0) * 100)}%`,
        x.scrapeInfo.refined ? ' · 抽样重刮' : ''));
    } else {
      // 1.9.2：刮削状态按「作品」判断（同作品任一版本刮到就算刮到），
      // 未刮削与刮削失败分别给一句明确的引导，不再只有一句「正在补全」。
      const st = x.workScrape || (x.scrapePending ? 'pending' : 'failed');
      if (st === 'pending') {
        metaBox.append(el('div', { class: 'meta-row scrape-pending' }, '⏳ 正在后台补全简介、封面与出版信息…'));
      } else if (st === 'failed') {
        const row = el('div', { class: 'meta-row scrape-failed' },
          '⚠ 未刮削到书籍信息，手动编辑书名等信息后重新按书名执行一次刮削');
        if (isAdminNow()) {
          const b2 = el('button', { class: 'btn sm ghost', style: 'margin-left:8px' }, '✎ 编辑资料');
          b2.addEventListener('click', () => openEditMeta(refBook));
          row.append(b2);
        }
        metaBox.append(row);
      }
    }
    descEl.textContent = x.description || '';
    descEl.style.display = x.description ? '' : 'none';
  }
  b.scrapePending = !!b.scrapePending;
  fillMeta(b);

  let inShelf = false;
  try {
    const sh = await api('/shelf');
    state.shelfIds = sh.ids || [];
    inShelf = state.shelfIds.some(x => x === b.id || (b.versions || []).some(v => v.id === x));
  } catch (_) {}
  const shelfBtn = el('button', { class: 'btn ghost' + (inShelf ? ' on' : '') }, inShelf ? '♥ 已在书架' : '♡ 加入书架');
  shelfBtn.addEventListener('click', async () => {
    try {
      const r = await api(`/shelf/${b.id}`, { method: 'PUT' });
      inShelf = r.added;
      shelfBtn.textContent = inShelf ? '♥ 已在书架' : '♡ 加入书架';
      shelfBtn.classList.toggle('on', inShelf);
    } catch (e) { alert(e.message); }
  });

  actions.append(el('button', { class: 'btn', onclick: () => window.Reader.open({ id: b.defaultVersion || b.id, title: b.title, author: b.author, filename: b.filename }) }, '📖 开始阅读'));
  actions.append(shelfBtn);
  // 1.6.0：读过 / 封面设置
  const readBtn = el('button', { class: 'btn ghost' + (b.finished ? ' on' : '') }, b.finished ? '✓ 已读完' : '○ 标为读过');
  readBtn.addEventListener('click', async () => {
    readBtn.disabled = true;
    try {
      const r = await api(`/books/${b.id}/finished`, { method: 'POST', body: JSON.stringify({ done: !b.finished }) });
      b.finished = r.done;
      readBtn.textContent = r.done ? '✓ 已读完' : '○ 标为读过';
      readBtn.classList.toggle('on', r.done);
    } catch (e) { alert(e.message); }
    readBtn.disabled = false;
  });
  actions.append(readBtn);
  if (canEditNow()) actions.append(el('button', { class: 'btn ghost', onclick: () => openCoverPicker(b) }, '🖼 设置封面'));
  actions.append(el('button', { class: 'btn ghost', onclick: e => saveFile(A(`/api/books/${b.id}/file${tokenQ()}&download=1`), b.filename, e.currentTarget) }, '⬇ 下载'));
  if (state.user.role === 'admin') {
    actions.append(el('button', { class: 'btn ghost', onclick: () => openEditMeta(b) }, '✎ 编辑资料'));
    actions.append(el('button', { class: 'btn ghost', onclick: e => rescrapeFlow(b, e.target) }, '🔄 重新刮削'));
  }
  info.append(actions);

  // PPT/PPTX：后台转换入口（服务端逐页取图 → 合成 PDF → 作为新版本入库）
  if (b.ext === 'ppt' || b.ext === 'pptx') info.append(convertPanel(b));

  const detail = el('div', { class: 'detail' },
    el('div', { class: 'd-cover' }, el('img', { src: A(`/api/cover/${b.id}${tokenQ()}&t=${Date.now()}`) })),
    info);
  main.append(detail);

  // ---- 刮削补全：局部更新（1.8.2）----
  // 只改书名 / 元数据行 / 简介 / 封面这几处，绝不动按钮和版本面板，也不重排页面，
  // 所以用户此刻正在编辑资料、挑封面、改版本都不受影响。
  if (b.scrapePending) {
    let tries = 0;
    let sig = [b.title, b.author, b.publisher, b.date, b.isbn, (b.description || '').length, b.coverExt, 'pending'].join('|');
    const tick = async () => {
      tries++;
      if (!document.body.contains(info)) return;
      try {
        const nb = await api('/books/' + b.id + '/scrape-status');
        const merged = Object.assign({}, b, nb);
        const ns = [nb.title, nb.author, nb.publisher, nb.date, nb.isbn, (nb.description || '').length, nb.coverExt, nb.scrapeState].join('|');
        if (ns !== sig) {
          sig = ns;
          // 用户正在弹窗里填东西时先不动界面，等他关掉弹窗下一次再更新
          if (!document.querySelector('.modal-mask')) {
            if (headEl.textContent !== merged.title) headEl.textContent = merged.title;
            fillMeta(merged);
            const img = detail.querySelector('.d-cover img');
            if (img && merged.coverExt) img.src = A(`/api/cover/${b.id}${tokenQ()}&t=${Date.now()}`);
            if (!nb.scrapePending) notify('已补全书籍信息');
          }
        }
        if (nb.scrapePending && tries < 10) setTimeout(tick, 3000);
      } catch (_) {
        if (tries < 10) setTimeout(tick, 6000);
      }
    };
    setTimeout(tick, 2000);
  }

  // ---- 版本管理（1.6.0：单版本也常显；编辑模式支持手动合并 / 分离） ----
  {
    const vers = (b.versions && b.versions.length) ? b.versions : [{
      id: b.id, ext: b.ext, filename: b.filename, size: b.size, pages: b.pages || 0,
      current: true, isDefault: true, progress: b.progress, addedAt: b.addedAt
    }];
    const panel = el('div', { class: 'panel ver-panel' });
    let editing = false;
    const picked = new Set();
    const head = el('div', { class: 'ver-head' },
      el('h3', {}, `版本管理 · ${vers.length} 个文件`));
    let editBtn = null;
    if (canEditNow()) {
      editBtn = el('button', { class: 'btn sm ghost', onclick: () => { editing = !editing; editBtn.textContent = editing ? '✓ 完成编辑' : '✎ 编辑'; drawRows(); } }, '✎ 编辑');
      head.append(editBtn);
    }
    panel.append(head);
    panel.append(el('p', { class: 'muted-sm', style: 'margin-bottom:10px' },
      '这里列出本书当前的全部文件。不同格式/来源的文件可归为同一作品；「设为默认」决定从书库打开时进入哪个版本。点「编辑」可勾选多个文件一起分离、或把整组打散。'));
    const rows = el('div', { class: 'ver-rows' });
    const batch = el('div', { class: 'ver-batch' });
    const mergeHost = el('div', {});
    panel.append(rows, batch, mergeHost);

    /** 1.8.2：分离不再弹二次确认（随时可以再合并回来），批量与整组打散走同一个接口 */
    async function unmerge(ids) {
      if (!ids.length) return;
      try {
        const r = await api('/works/unmerge', { method: 'POST', body: JSON.stringify({ bookIds: ids }) });
        notify(`已分离 ${r.count} 个文件为独立书籍`);
        render();
      } catch (e) { alert(e.message); }
    }
    async function unmergeAll() {
      try {
        const r = await api('/works/unmerge', { method: 'POST', body: JSON.stringify({ all: b.workKey }) });
        notify(`已把 ${r.count} 个文件全部打散成独立书籍`);
        render();
      } catch (e) { alert(e.message); }
    }
    function updateBatch() {
      const c = batch.querySelector('.ver-batch-count');
      if (c) c.textContent = `已选 ${picked.size} 个`;
    }
    function selectAll() {
      rows.querySelectorAll('.ver-cb').forEach(cb => {
        cb.checked = true;
        picked.add(cb.dataset.id);
        const r = cb.closest('.ver-row'); if (r) r.classList.add('picked');
      });
      updateBatch();
    }

    // 1.9.0：版本顺序可调（只在本次页面里改数组，然后整份提交给服务端保存）
    async function saveOrder() {
      try {
        await api('/works/order', { method: 'PUT', body: JSON.stringify({ workKey: b.workKey, ids: vers.map(v => v.id) }) });
        notify('版本顺序已保存');
      } catch (e) { alert(e.message); }
    }
    function moveVer(from, to) {
      if (to < 0 || to >= vers.length) return;
      const item = vers.splice(from, 1)[0];
      vers.splice(to, 0, item);
      drawRows();
      saveOrder();
    }

    function drawRows() {
      rows.innerHTML = '';
      picked.clear();
      batch.innerHTML = '';
      mergeHost.innerHTML = '';
      batch.style.display = editing ? '' : 'none';
      mergeHost.style.display = editing ? '' : 'none';
      if (editing) {
        batch.append(
          el('span', { class: 'muted-sm ver-batch-count' }, '已选 0 个'),
          el('button', { class: 'btn sm ghost', onclick: selectAll }, '全选'),
          el('button', { class: 'btn sm', onclick: () => unmerge([...picked]) }, '⇤ 分离所选'),
          vers.length > 1 ? el('button', { class: 'btn sm ghost danger-text', onclick: unmergeAll }, '⇤ 全部打散') : null,
          el('span', { class: 'muted-sm' }, '只改索引里的分组关系，不移动、不重命名任何文件'));
        mergeHost.append(mergeBox());
      }
      for (let vi = 0; vi < vers.length; vi++) {
        const v = vers[vi];
        const pct = v.progress && v.progress.pct ? Math.round(v.progress.pct) : 0;
        const defBtn = v.isDefault
          ? el('button', { class: 'btn sm on', disabled: 'true' }, '✓ 默认版本')
          : (canEditNow()
              ? el('button', { class: 'btn sm ghost', onclick: async e => {
                  e.target.disabled = true;
                  try {
                    await api(`/works/${encodeURIComponent(b.workKey)}/default`, { method: 'PUT', body: JSON.stringify({ bookId: v.id }) });
                    render();
                  } catch (err) { alert(err.message); e.target.disabled = false; }
                } }, '设为默认')
              : null);
        const act = el('div', { class: 'ver-act' }, defBtn,
          el('button', { class: 'btn sm', onclick: () => window.Reader.open({ id: v.id, title: b.title, author: b.author, filename: v.filename }) }, '阅读'),
          // 1.7.1：每个版本单独下载（阅读 → 下载 → 申请删除）
          el('button', { class: 'btn sm ghost', title: `下载 ${v.filename}`, onclick: e => saveFile(A(`/api/books/${v.id}/file${tokenQ()}&download=1`), v.filename, e.currentTarget) }, '⬇ 下载'),
          el('button', { class: 'btn sm ghost danger-text', onclick: () => requestDelete(v.id, b.title + ' · ' + v.filename) }, '申请删除'));
        if (editing) {
          act.append(el('button', { class: 'btn sm ghost', title: '把这个版本拆成一本独立的书', onclick: () => unmerge([v.id]) }, '⇤ 分离'));
          // 1.9.0：上下移动调整版本展示顺序（第一版通常是用户最想打开的那个）
          act.append(
            el('button', { class: 'btn sm ghost ver-move', title: '上移', disabled: vi === 0 ? 'true' : null, onclick: () => moveVer(vi, vi - 1) }, '↑'),
            el('button', { class: 'btn sm ghost ver-move', title: '下移', disabled: vi === vers.length - 1 ? 'true' : null, onclick: () => moveVer(vi, vi + 1) }, '↓'));
        }
        const row = el('div', { class: 'ver-row' + (v.isDefault ? ' cur' : '') });
        if (editing) {
          const cb = el('input', { type: 'checkbox', class: 'ver-cb', 'data-id': v.id });
          cb.addEventListener('change', () => {
            if (cb.checked) picked.add(v.id); else picked.delete(v.id);
            row.classList.toggle('picked', cb.checked);
            updateBatch();
          });
          row.append(cb);
        }
        row.append(
          el('span', { class: 'ver-ext' }, String(v.ext).toUpperCase()),
          el('div', { class: 'ver-main' },
            el('div', { class: 'ver-name' }, v.filename,
              v.generated ? el('span', { class: 'ver-tag gen' }, '转换产物') : null,
              v.current ? el('span', { class: 'ver-tag cur-tag' }, '当前') : null),
            el('div', { class: 'ver-meta' }, `${fmtSize(v.size)}${v.pages ? ' · ' + v.pages + ' 页' : ''}${pct ? ' · 已读 ' + pct + '%' : ''}`),
            v.path ? el('div', { class: 'ver-path', title: v.path }, v.path) : null),
          act);
        rows.append(row);
      }
    }

    function mergeBox() {
      const box = el('div', { class: 'ver-merge' });
      box.append(el('div', { class: 'vm-title' }, '✎ 把其他书籍合并进来'));
      box.append(el('p', { class: 'muted-sm' }, '合并只改索引里的分组关系，不移动、不重命名任何文件；之后可在上面的「分离」还原。列表里每一行是一部作品（可能包含多个文件），勾选后会把这些文件一次性全部并进来。'));
      const input = el('input', { type: 'text', placeholder: '输入书名 / 作者 / 路径搜索（留空显示全部）' });
      const list = el('div', { class: 'vm-list' });
      const search = el('button', { class: 'btn sm ghost' }, '搜索');
      // 1.9.2：picked 存的是「文件 id」，来自候选作品里的 books[]，而不是作品代表条目
      const pickedIds = new Set();
      const countEl = el('span', { class: 'muted-sm' }, '已选 0 本');
      const doBatch = el('button', { class: 'btn sm', disabled: 'true', onclick: async e => {
        if (!pickedIds.size) return;
        e.target.disabled = true;
        try {
          const r = await api('/works/merge-batch', { method: 'POST', body: JSON.stringify({ ids: [b.id, ...pickedIds], targetId: b.id }) });
          notify(`已合并 ${r.merged} 个文件进来`);
          render();
        } catch (err) { alert(err.message); e.target.disabled = false; }
      } }, '⇄ 批量合并所选');
      const refreshCount = () => {
        countEl.textContent = `已选 ${pickedIds.size} 个文件`;
        doBatch.disabled = pickedIds.size === 0;
      };
      box.append(el('div', { class: 'vm-search' }, input, search));
      box.append(el('div', { class: 'vm-bar' }, countEl,
        el('button', { class: 'btn sm ghost', onclick: () => {
          list.querySelectorAll('.vm-cb').forEach(cb => { cb.checked = true; pickedIds.add(cb.dataset.id); });
          refreshCount();
        } }, '全选结果'),
        el('button', { class: 'btn sm ghost', onclick: () => {
          list.querySelectorAll('.vm-cb').forEach(cb => { cb.checked = false; });
          pickedIds.clear(); refreshCount();
        } }, '清空'),
        el('span', { style: 'flex:1' }), doBatch));
      box.append(list);
      let timer = null;
      const run = async () => {
        list.innerHTML = '<span class="muted-sm">搜索中…</span>';
        pickedIds.clear(); refreshCount();
        try {
          const d = await api(`/books/${b.id}/merge-candidates?q=${encodeURIComponent(input.value.trim())}`);
          list.innerHTML = '';
          if (!d.items.length) list.append(el('span', { class: 'muted-sm' }, '没有找到可合并的书'));
          for (const x of d.items) {
            // 一部作品的所有文件 id（老接口只返回单本时退回 x.id）
            const fileIds = (x.books && x.books.length) ? x.books.map(v => v.id) : [x.id];
            const cb = el('input', { type: 'checkbox', class: 'vm-cb', 'data-id': x.id, 'data-ids': fileIds.join(',') });
            cb.addEventListener('change', () => {
              for (const fid of fileIds) {
                if (cb.checked) pickedIds.add(fid); else pickedIds.delete(fid);
              }
              refreshCount();
            });
            const detail = (x.books || []).length > 1
              ? el('span', { class: 'muted-sm' }, '· ' + x.books.map(v => String(v.ext || '').toUpperCase()).join(' / '))
              : null;
            list.append(el('div', { class: 'vm-item' },
              cb,
              el('span', {}, `${x.title} · ${x.author || '未知作者'} · ${String(x.ext).toUpperCase()}`),
              (x.files > 1) ? el('span', { class: 'ver-tag' }, `${x.files} 个文件`) : null,
              detail,
              el('button', { class: 'btn sm ghost', onclick: async e => {
                e.target.disabled = true;
                try {
                  // 1.9.2：「合并进来」= 这一部作品的全部文件一起并进来，不再只挪第一个
                  if (fileIds.length > 1) {
                    await api('/works/merge-batch', { method: 'POST', body: JSON.stringify({ ids: [b.id, ...fileIds], targetId: b.id }) });
                  } else {
                    await api('/works/merge', { method: 'POST', body: JSON.stringify({ sourceId: fileIds[0], targetId: b.id }) });
                  }
                  render();
                } catch (err) { alert(err.message); e.target.disabled = false; }
              } }, fileIds.length > 1 ? `合并全部 ${fileIds.length} 个文件` : '合并进来')));
          }
        } catch (err) { list.textContent = err.message; }
      };
      search.addEventListener('click', run);
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      run();
      return box;
    }
    drawRows();
    main.append(panel);
  }

  // ---- 1.9.0：专辑（专题）管理 ----
  // 在详情页直接看到「这本书在哪几个专题里」，并能加入/移出/新建——不用退回书库再批量选。
  if (canEditNow()) {
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, '🗂 专辑管理'));
    panel.append(el('p', { class: 'muted-sm', style: 'margin-bottom:10px' }, '把这部作品放进专题（剧集、系列、主题书单）。一个专题可以有任意多部作品，一部作品也可以在多个专题里。'));
    const listBox = el('div', { class: 'col-manage-list' });
    panel.append(listBox);
    let allCols = [];
    const draw = async () => {
      listBox.innerHTML = '<span class="muted-sm">加载中…</span>';
      try {
        allCols = await loadCollections(true);
      } catch (_) { allCols = []; }
      const mine = new Set((b.collections || []).map(c => c.id));
      listBox.innerHTML = '';
      if (!allCols.length) listBox.append(el('span', { class: 'muted-sm' }, '还没有专题，点下面的「新建专题」创建一个。'));
      for (const c of allCols) {
        const on = mine.has(c.id);
        const btn = el('button', { class: 'btn sm ' + (on ? 'on' : 'ghost') }, on ? '✓ 已在' : '＋ 加入');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            if (on) await api('/collections/' + c.id + '/items', { method: 'DELETE', body: JSON.stringify({ bookIds: [b.id] }) });
            else await api('/collections/' + c.id + '/items', { method: 'POST', body: JSON.stringify({ bookIds: [b.id] }) });
            b.collections = on ? (b.collections || []).filter(x => x.id !== c.id) : (b.collections || []).concat([{ id: c.id, name: c.name }]);
            notify(on ? `已从「${c.name}」移出` : `已加入「${c.name}」`);
            state.collections = null;
            draw();
          } catch (e) { alert(e.message); btn.disabled = false; }
        });
        listBox.append(el('div', { class: 'col-manage-row' },
          el('span', { class: 'col-manage-name' }, '📁 ' + c.name),
          el('span', { class: 'muted-sm' }, `${c.count} 本`), btn));
      }
    };
    const addBtn = el('button', { class: 'btn sm ghost', style: 'margin-top:10px' }, '＋ 新建专题并加入');
    addBtn.addEventListener('click', async () => {
      const name = prompt('新专题名称（例如：三体全集、2024 读完的书）');
      if (!name || !name.trim()) return;
      try {
        const c = await api('/collections', { method: 'POST', body: JSON.stringify({ name: name.trim(), bookIds: [b.id] }) });
        state.collections = null;
        b.collections = (b.collections || []).concat([{ id: c.id, name: c.name }]);
        notify('专题已创建并加入');
        draw();
      } catch (e) { alert(e.message); }
    });
    panel.append(addBtn);
    main.append(panel);
    draw();
  }

  // ---- 这本书的书签与笔记 ----
  {
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, `我的书签与笔记（${(b.annotations || []).length}）`));
    if (!(b.annotations || []).length) {
      panel.append(el('p', { class: 'muted-sm' }, '还没有书签或笔记。阅读时点 🔖 加书签，选中文字可高亮或记笔记。'));
    } else {
      const list = el('div', { class: 'rec-list' });
      for (const a of b.annotations.slice(0, 20)) {
        const typeLabel = { bookmark: '书签', highlight: '高亮', note: '笔记' }[a.type] || a.type;
        list.append(el('div', { class: 'rec-item ' + a.type },
          el('span', { class: 'rec-type' }, typeLabel),
          a.quote ? el('div', { class: 'rec-quote' }, a.quote) : null,
          a.note ? el('div', { class: 'rec-note' }, a.note) : null,
          el('span', { class: 'rec-when' }, (a.versionExt || '').toUpperCase() + (a.page ? ` · 第 ${a.page} 页 · ` : ' · ') + new Date(a.createdAt).toLocaleDateString('zh-CN'))));
      }
      if (b.annotations.length > 20) list.append(el('p', { class: 'muted-sm' }, `… 还有 ${b.annotations.length - 20} 条`));
      panel.append(list);
    }
    main.append(panel);
  }

  // ---- 目录栏目：1.6.3 起从详情页移除（阅读器内左侧目录仍然可用） ----

  // ---- 编辑资料 ----
  function openEditMeta(book) {
    const m = el('div', { class: 'modal-mask' });
    const f = {};
    const field = (key, label, val, ph, type) => {
      f[key] = type === 'textarea' ? el('textarea', { rows: '4', placeholder: ph || '' }) : el('input', { type: type || 'text', placeholder: ph || '' });
      if (val != null) f[key].value = val;
      return el('div', { class: 'field' }, el('label', {}, label), f[key]);
    };
    const box = el('div', { class: 'modal' },
      el('h3', {}, '编辑书籍资料'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:12px' }, '手动修改后，重新扫描不会覆盖这些字段。'),
      field('title', '书名', book.title),
      field('author', '作者', book.author),
      el('div', { class: 'two-col' }, field('publisher', '出版社', book.publisher || ''), field('date', '出版日期', book.date || '', '2023-06')),
      field('isbn', 'ISBN', book.isbn || ''),
      field('description', '简介', book.description || '', '', 'textarea'),
      el('div', { class: 'modal-act' },
        el('button', { class: 'btn ghost', onclick: () => m.remove() }, '取消'),
        el('button', { class: 'btn', onclick: async e => {
          e.target.disabled = true;
          try {
            await api(`/books/${book.id}/meta`, {
              method: 'PUT',
              body: JSON.stringify({
                title: f.title.value, author: f.author.value,
                publisher: f.publisher.value, date: f.date.value, isbn: f.isbn.value,
                description: f.description.value
              })
            });
            m.remove(); render();
          } catch (err) { alert(err.message); e.target.disabled = false; }
        } }, '保存')));
    m.append(box);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    document.body.append(m);
  }

  async function requestDelete(bookId, label) {
    // 先查这个版本上有没有用户留下的书签/笔记
    let usage = [];
    try { usage = (await api(`/books/${bookId}/usage`)).usage || []; } catch (_) {}
    let warn = '';
    if (usage.length) {
      const lines = usage.map(u => `· ${u.email}：书签 ${u.bookmarks} 个、笔记 ${u.notes} 条`).join('\n');
      warn = `\n\n⚠️ 注意：这个版本上还有用户留下的书签和笔记：\n${lines}\n删除后这些记录将无法再使用。`;
    }
    if (!confirm(`提交删除申请？\n\n${label}${warn}\n\n申请会进入管理后台，管理员确认后文件才会被移入回收站。`)) return;
    try {
      await api(`/books/${bookId}/delete-request`, { method: 'POST', body: JSON.stringify({ note: '' }) });
      // 1.9.0：不再弹出「已提交给管理员审核」的对话框（每次删都弹一次很烦），改成轻提示
      notify('已提交删除申请，等待管理员处理');
      render();
    } catch (e) { alert(e.message); }
  }

  async function rescrapeFlow(book, btn) {
    const old = btn.textContent;
    // 1.9.2：书名不可信时（文件名/元数据都是乱码或垃圾），先让管理员确认检索用的书名，
    // 这样「手动编辑书名后重新按书名刮削」才真的按书名走，而不是又退回目录名/正文抽样。
    const junk = !book.title || book.titleSrc === 'dir' || /^(untitled|未命名|新建|文档)/i.test(book.title);
    const askName = junk || !book.scrapeInfo;
    let keyword = '';
    if (askName) {
      keyword = prompt('按书名刮削——这本书要按哪个书名去查？（留空则自动用文件名 / 元数据 / 路径逐级尝试）', book.title || '') || '';
      keyword = keyword.trim();
    }
    btn.disabled = true; btn.textContent = '刮削中…';
    try {
      const r = await api(`/books/${book.id}/rescrape`, { method: 'POST', body: JSON.stringify({ dryRun: true, keyword: keyword || undefined }) });
      btn.disabled = false; btn.textContent = old;
      if (!r.ok) {
        const cands = (r.candidates || []).map((c, i) => `${i + 1}. [${c.provider}] ${c.title}${c.author ? ' / ' + c.author : ''}（${Math.round((c.score || 0) * 100)}%）`).join('\n');
        const hints = r.hints ? `\n\n抽样线索：书名「${r.hints.title || '—'}」作者「${r.hints.author || '—'}」ISBN「${r.hints.isbn || '—'}」\n查询词：${(r.hints.queries || []).join(' / ')}` : '';
        alert('没有找到足够匹配的结果。' + (cands ? '\n\n低置信候选：\n' + cands : '') + hints + '\n\n可在「管理后台 → 图书库」开启更多刮削源。');
        return;
      }
      const c = r.candidate;
      const names = { douban: '豆瓣读书', isbn: 'ISBN 直达', nlc: '国家图书馆', duxiu: '读秀', dangdang: '当当图书' };
      const msg = `来源：${names[r.provider] || r.provider}\n匹配度：${Math.round((r.score || 0) * 100)}%${r.refined ? '（已抽样前 10 页重刮）' : ''}\n\n书名：${c.title}\n作者：${c.author || '—'}\n出版社：${c.publisher || '—'}\n出版年：${c.date || '—'}\nISBN：${c.isbn || '—'}\n简介：${(c.description || '—').slice(0, 120)}…\n\n采用此结果？`;
      if (!confirm(msg)) return;
      await api(`/books/${book.id}/rescrape`, { method: 'POST', body: JSON.stringify({ apply: c }) });
      render();
    } catch (e) {
      btn.disabled = false; btn.textContent = old;
      alert(e.message);
    }
  }
}

// ===== 管理后台 =====
async function renderAdmin(app) {
  if (state.user.role !== 'admin') { location.hash = '#/library'; return; }
  let settingsResp = await api('/settings');
  let settings = settingsResp.settings;
  const providers = settingsResp.providers || [];
  const storage = settingsResp.storage || {};
  const knownExts = settingsResp.exts || [];

  const { layout, main } = shell('');
  app.innerHTML = ''; app.append(layout);
  main.append(el('a', { class: 'back', href: '#/library' }, '← 返回书库'), el('h1', { style: 'margin-bottom:16px' }, '管理后台'));

  const tabDefs = [
    ['library', '📚 图书库'], ['deletions', '🗂 删除审核'], ['users', '👥 用户'],
    ['stats', '📊 阅读统计'], ['apps', '📱 APP 安装包'], ['notes', '📣 找书通知'],
    ['tts', '🔊 语音朗读'], ['ai', '✦ AI 设置'],
    ['logs', '📋 系统日志'],
    ['mail', '📧 邮箱'], ['security', '🔒 安全'], ['data', '💾 数据位置']
  ];
  const tabs = el('div', { class: 'tabs' });
  const panels = {};
  for (const [k] of tabDefs) panels[k] = el('div', { class: 'panel-wrap' });
  function switchTab(key) {
    tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === key));
    Object.entries(panels).forEach(([k, p]) => p.style.display = k === key ? '' : 'none');
    if (key === 'deletions') loadDeletions();
    if (key === 'apps') loadAppsPanel();
    if (key === 'notes') loadNotesPanel();
    if (key === 'logs' && logsPanel.refresh) logsPanel.refresh();
  }
  for (const [key, label] of tabDefs) tabs.append(el('div', { class: 'tab', 'data-tab': key, onclick: () => switchTab(key) }, label));

  const save = async body => {
    const r = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
    settings = r.settings;
    return r;
  };

  // ---------- 图书库 ----------
  async function loadLibraryPanel() {
    const p = panels.library;
    p.innerHTML = '';
    const paths = (await api('/paths')).paths;

    const pathPanel = el('div', { class: 'panel' }, el('h3', {}, '图书路径（直接关联 NAS 目录，不搬运、不重命名）'));
    for (const item of paths) {
      pathPanel.append(el('div', { class: 'path-row' },
        el('code', {}, item.path),
        el('label', { class: 'switch', title: '启用/停用' },
          (() => { const i = el('input', { type: 'checkbox' }); i.checked = item.enabled; i.addEventListener('change', () => api(`/paths/${item.id}`, { method: 'PUT', body: JSON.stringify({ enabled: i.checked }) }).then(loadLibraryPanel)); return i; })(),
          el('span', {})),
        el('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`移除路径 ${item.path}？（不会删除任何文件）`)) { await api(`/paths/${item.id}`, { method: 'DELETE' }); loadLibraryPanel(); } } }, '移除')));
    }
    if (!paths.length) pathPanel.append(el('p', { class: 'muted-sm' }, '尚未添加路径。添加后点击「扫描书库」，应用只会读取并索引这些目录中的图书文件。'));
    const pathInput = el('input', { placeholder: '/vol1/1000/图书目录（NAS 上的绝对路径）', style: 'flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:8px' });
    pathPanel.append(el('div', { style: 'display:flex;gap:10px;margin-top:14px' }, pathInput,
      el('button', { class: 'btn', onclick: async () => { try { await api('/paths', { method: 'POST', body: JSON.stringify({ path: pathInput.value.trim() }) }); pathInput.value = ''; loadLibraryPanel(); } catch (e) { alert(e.message); } } }, '＋ 添加路径')));
    p.append(pathPanel);

    // 1.8.0：入库文件类型（取消勾选 = 扫描时跳过这些后缀）
    const lib = settings.library || (settings.library = { excludeExts: [] });
    const excluded = new Set(lib.excludeExts || []);
    const extPanel = el('div', { class: 'panel' },
      el('h3', {}, '入库文件类型'),
      el('p', { class: 'muted-sm' }, '取消勾选的后缀在扫描时会被直接忽略（不解析、不入库）。已经在库里的同类文件会在下次完整扫描时移出书库；NAS 上的源文件不会被改动。'));
    const extBox = el('div', { class: 'ext-grid' });
    const boxes = [];
    for (const e of knownExts) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !excluded.has(e);
      cb.dataset.ext = e;
      boxes.push(cb);
      extBox.append(el('label', { class: 'ext-item' }, cb, el('span', {}, String(e).toUpperCase())));
    }
    const extraInput = el('input', { class: 'ext-extra', placeholder: '额外排除的后缀，例如 wps, chm（逗号分隔）' });
    extraInput.value = (lib.excludeExts || []).filter(e => !knownExts.includes(e)).join(', ');
    extPanel.append(extBox,
      el('div', { class: 'ext-actions' },
        el('button', { class: 'btn sm ghost', onclick: () => boxes.forEach(cb => { cb.checked = true; }) }, '全选'),
        el('button', { class: 'btn sm ghost', onclick: () => boxes.forEach(cb => { cb.checked = false; }) }, '全不选'),
        extraInput,
        el('button', { class: 'btn sm', onclick: async e => {
          e.target.disabled = true;
          try {
            const keep = boxes.filter(cb => cb.checked).map(cb => cb.dataset.ext);
            const extraList = extraInput.value.split(/[,，\s]+/).map(x => x.toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
            const exclude = knownExts.filter(x => !keep.includes(x))
              .concat(extraList.filter(x => !knownExts.includes(x)));
            await save({ library: { excludeExts: exclude } });
            alert('已保存。点击「立即扫描书库」后生效。');
            loadLibraryPanel();
          } catch (err) { alert(err.message); e.target.disabled = false; }
        } }, '保存文件类型')));
    p.append(extPanel);

    // 1.9.0：按路径批量合并
    // 同一个 NAS 目录下的多个文件通常就是同一部作品的不同格式/译本，扫描时没并上就到这里一把并掉。
    // 1.9.1：改成「资源管理器」式的目录树——按真实目录层级缩进、可折叠，勾选目录即整目录合并。
    const pathMergePanel = el('div', { class: 'panel' },
      el('h3', {}, '按路径批量合并'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:10px' },
        '下面按目录结构列出「一个目录里还散着多部作品」的情况（和电脑里看文件夹一样）。勾选目录后合并，会把这个目录里的书并成同一部作品的不同版本（只改索引，不动源文件）。'));
    const pmBody = el('div', {});
    pathMergePanel.append(pmBody);
    p.append(pathMergePanel);
    (async () => {
      try {
        const d = await api('/path-groups');
        pmBody.innerHTML = '';
        if (!d.items.length) {
          pmBody.append(el('p', { class: 'muted-sm' },
            `没有需要合并的目录（每个目录里的书都已经并好了）。当前已扫描 ${d.dirs || 0} 个目录、${d.books || 0} 个文件。`));
          return;
        }
        const pickedDirs = new Set();
        const collapsed = new Set();       // 折叠的目录（默认全部展开，层级深的先折起来）
        const list = el('div', { class: 'pm-tree' });
        const countEl = el('span', { class: 'muted-sm' }, '已选 0 个目录');
        const mergeBtn = el('button', { class: 'btn sm' }, '⇄ 合并所选目录');

        // 把「路径 -> 节点」拼成一棵树
        const root = { name: '', dir: '', children: new Map(), items: [] };
        const segsOf = dir => String(dir).split(/[\\/]+/).filter(Boolean);
        for (const g of d.items) {
          const segs = segsOf(g.dir);
          let node = root;
          let acc = segs[0] && /^[A-Za-z]:$/.test(segs[0]) ? segs[0] : '';
          // 保留盘符 / 开头的 /，拼接时贴近原路径
          const basePrefix = String(g.dir).startsWith('/') ? '/' : '';
          let i = 0;
          if (segs[0] && /^[A-Za-z]:$/.test(segs[0])) { acc = segs[0]; i = 1; }
          else if (basePrefix) { acc = ''; }
          else { acc = segs[0] || ''; i = 1; }
          let cur = root;
          for (; i < segs.length; i++) {
            const seg = segs[i];
            acc = acc ? acc.replace(/[\\/]+$/, '') + (acc === '/' ? '' : '/') + seg : (basePrefix + seg);
            if (!cur.children.has(acc)) cur.children.set(acc, { name: seg, dir: acc, children: new Map(), items: [] });
            cur = cur.children.get(acc);
          }
          cur.items.push(g);
        }

        const updateCount = () => {
          const n = pickedDirs.size;
          const files = d.items.filter(g => pickedDirs.has(g.dir)).reduce((s, g) => s + g.count, 0);
          countEl.textContent = `已选 ${n} 个目录 · ${files} 个文件`;
          mergeBtn.disabled = !n;
          mergeBtn.textContent = n ? `⇄ 合并所选 ${n} 个目录` : '⇄ 合并所选目录';
        };

        function renderNode(node, depth, container) {
          // 子目录优先排序（和资源管理器一致：文件夹在上）
          const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));          for (const k of kids) {
            const hasOwn = k.items.length > 0;
            const row = el('div', { class: 'pm-node', style: `padding-left:${depth * 18}px` });
            const caret = el('button', { class: 'pm-caret', title: '展开 / 折叠' }, collapsed.has(k.dir) ? '▸' : '▾');
            const badge = hasOwn
              ? el('span', { class: 'pm-badge' }, `${k.items[0].count} 个文件 · ${k.items[0].works} 部作品`)
              : null;
            row.append(caret, el('span', { class: 'pm-ico' }, '📁'),
              el('span', { class: 'pm-name', title: k.dir }, k.name));
            if (badge) row.append(badge);
            row.append(el('span', { style: 'flex:1' }));
            container.append(row);
            // 有本级待合并目录时，主行右侧也给一个勾选（等价于勾上这条目录）
            for (const g of k.items) {
              const gcb = el('input', { type: 'checkbox', title: '合并这个目录里的书' });
              gcb.addEventListener('change', () => {
                if (gcb.checked) pickedDirs.add(g.dir); else pickedDirs.delete(g.dir);
                updateCount();
              });
              row.append(gcb);
              break;
            }
            const box = el('div', { class: 'pm-kids' });
            if (collapsed.has(k.dir)) box.style.display = 'none';
            caret.addEventListener('click', () => {
              const now = box.style.display !== 'none';
              box.style.display = now ? 'none' : '';
              caret.textContent = now ? '▸' : '▾';
              if (now) collapsed.add(k.dir); else collapsed.delete(k.dir);
            });
            // 本目录自己的待合并详情（勾选框在这里，一个目录对应一行）
            for (const g of k.items) {
              const gcb = el('input', { type: 'checkbox', title: '合并这个目录里的书' });
              gcb.addEventListener('change', () => {
                if (gcb.checked) pickedDirs.add(g.dir); else pickedDirs.delete(g.dir);
                updateCount();
              });
              box.append(el('div', { class: 'pm-leaf', style: `padding-left:${(depth + 1) * 18 + 20}px` },
                el('span', { class: 'pm-ico' }, '📚'),
                el('span', { class: 'pm-name', title: g.dir }, g.name),
                el('span', { class: 'muted-sm' }, `${g.count} 个文件 · ${g.works} 部作品 · ${g.books.map(b => String(b.ext).toUpperCase()).join(' / ')}`),
                el('span', { style: 'flex:1' }),
                el('button', { class: 'btn sm ghost', onclick: async e => {
                  e.target.disabled = true;
                  try {
                    const r = await api('/works/merge-by-path', { method: 'POST', body: JSON.stringify({ dirs: [g.dir] }) });
                    notify(`已合并 ${r.groups} 个目录、${r.merged} 个文件`);
                    loadLibraryPanel();
                  } catch (err) { alert(err.message); e.target.disabled = false; }
                } }, '只合并这个'),
                gcb));
            }
            renderNode(k, depth + 1, box);
            container.append(box);
          }
        }

        const bar = el('div', { class: 'pm-bar' },
          el('span', { class: 'muted-sm' }, `共 ${d.total} 个目录待处理（书库 ${d.dirs || ''} 个目录 / ${d.books || ''} 个文件）`),
          countEl,
          el('span', { style: 'flex:1' }),
          el('button', { class: 'btn sm ghost', onclick: () => {
            list.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(i => { if (!i.checked) { i.checked = true; i.dispatchEvent(new Event('change')); } });
          } }, '全选'),
          el('button', { class: 'btn sm ghost', onclick: () => {
            list.querySelectorAll('.pm-caret').forEach(c => { if (c.textContent === '▾') c.click(); });
          } }, '全部折叠'),
          el('button', { class: 'btn sm ghost', onclick: () => {
            list.querySelectorAll('.pm-caret').forEach(c => { if (c.textContent === '▸') c.click(); });
          } }, '全部展开'),
          mergeBtn);
        mergeBtn.addEventListener('click', async () => {
          if (!pickedDirs.size) return alert('先勾选要合并的目录');
          mergeBtn.disabled = true;
          try {
            const r = await api('/works/merge-by-path', { method: 'POST', body: JSON.stringify({ dirs: [...pickedDirs] }) });
            notify(`已合并 ${r.groups} 个目录、${r.merged} 个文件`);
            loadLibraryPanel();
          } catch (err) { alert(err.message); mergeBtn.disabled = false; }
        });
        // 顶层先铺一行「根」——显示盘符 / 起始目录，视觉上像资源管理器
        const roots = [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (roots.length) {
          const firstDir = d.items[0].dir || '';
          const head = el('div', { class: 'pm-root' },
            el('span', { class: 'pm-ico' }, '💾'),
            el('span', { class: 'pm-rootname' }, String(firstDir).match(/^[A-Za-z]:/) ? firstDir.slice(0, 2) : '/'),
            el('span', { class: 'muted-sm' }, `书库根目录 · ${d.dirs || 0} 个目录 / ${d.books || 0} 个文件`));
          list.append(head);
        }
        renderNode(root, 0, list);
        updateCount();
        pmBody.append(bar, list);
      } catch (e) { pmBody.append(el('p', { class: 'muted-sm' }, '读取失败：' + e.message)); }
    })();

    // 扫描
    const scanPanel = el('div', { class: 'panel' });
    // 1.9.1：「每日 0 点自动扫描」挪到这里，并支持自由设定周期
    const timerBox = el('div', { class: 'timer-box' });
    const scanBtn = el('button', { class: 'btn', onclick: doScan }, '🔄 立即扫描书库');
    // 1.9.0：手动「开始刮削」——把还没刮过的书继续补全（后台平时也会自己跑，这里是想立刻开始）
    const scrapeAllBtn = el('button', { class: 'btn ghost', style: 'margin-left:8px', onclick: async e => {
      e.target.disabled = true; e.target.textContent = '启动中…';
      try {
        const r = await api('/scrape/start', { method: 'POST', body: JSON.stringify({}) });
        notify(r.message || '已开始后台刮削');
        refreshScan();
      } catch (err) { alert(err.message); }
      e.target.disabled = false; e.target.textContent = '✦ 开始刮削';
    } }, '✦ 开始刮削');
    const scanInfo = el('div', { style: 'margin-top:12px;font-size:13px;color:var(--muted)' }, '尚未扫描');
    const scanLog = el('pre', { class: 'scan-log' });
    async function refreshScan() {
      const st = await api('/scan/status');
      if (st.running) {
        scanInfo.textContent = `${st.phase || '扫描中'}… ${st.scanned}/${st.total}（新增 ${st.added} · 更新 ${st.updated}）`;
        scanBtn.disabled = true;
        scanLog.textContent = (st.log || []).join('\n');
        scanLog.scrollTop = scanLog.scrollHeight;
        setTimeout(refreshScan, 2000);
      } else {
        scanBtn.disabled = false;
        if (st.finishedAt) {
          scanInfo.textContent = `上次扫描：新增 ${st.added} · 更新 ${st.updated} · 移除 ${st.removed}` +
            (st.errors && st.errors.length ? ` · 错误 ${st.errors.length} 项` : '') + `（${new Date(st.finishedAt).toLocaleString('zh-CN')}）`;
          scanLog.textContent = [...(st.log || []), ...(st.errors || []).map(e => '⚠ ' + e)].join('\n');
        }
        if (st.scrape && st.scrape.running) setTimeout(refreshScan, 3000);
      }
    }
    async function doScan() { await api('/scan', { method: 'POST' }); refreshScan(); }

    // ===== 1.9.1：定时自动扫描 / 自动刮削（可自由设定周期） =====
    const everyOpts = [
      ['hour', '每 N 小时'],
      ['day', '每 N 天'],
      ['week', '每 N 周的星期几'],
      ['month', '每 N 月的某一天']
    ];
    const tEnabled = el('input', { type: 'checkbox' });
    const tEvery = el('select', {}, ...everyOpts.map(([v, l]) => el('option', { value: v }, l)));
    const tInterval = el('input', { type: 'number', min: '1', max: '90', step: '1', style: 'width:74px' });
    const tIntervalUnit = el('span', { class: 'muted-sm' });
    const tAt = el('input', { type: 'time', step: '60', style: 'width:120px' });
    const tAtLabel = el('span', { class: 'muted-sm' }, '触发时刻');
    const tWeek = el('div', { class: 'week-days' });
    const WD = [['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'], ['5', '五'], ['6', '六'], ['0', '日']];
    const wdSet = new Set(['1', '2', '3', '4', '5', '6', '0']);
    const wdBoxes = {};
    for (const [v, l] of WD) {
      const cb = el('input', { type: 'checkbox' }); cb.checked = true;
      wdBoxes[v] = cb;
      tWeek.append(el('label', { class: 'wd' }, cb, '周' + l));
    }
    const tMonthDay = el('select', { style: 'width:100px' },
      ...Array.from({ length: 31 }, (_, i) => el('option', { value: String(i + 1) }, `每月 ${i + 1} 日`)));
    const tScrape = el('input', { type: 'checkbox' });
    const tNext = el('div', { class: 'muted-sm', style: 'margin-top:10px;line-height:1.9' }, '读取中…');
    const tSave = el('button', { class: 'btn sm' }, '保存定时设置');

    const tIsHour = el('span', { class: 'muted-sm' }, '分钟');
    const tMinute = el('input', { type: 'number', min: '0', max: '59', step: '1', style: 'width:74px' });
    const rowMinute = el('div', { class: 'timer-row' }, el('span', { class: 'muted-sm' }, '第'), tMinute, tIsHour, el('span', { class: 'muted-sm' }, '分钟触发'));
    const rowEvery = el('div', { class: 'timer-row' }, tEvery, tInterval, tIntervalUnit);
    const rowAt = el('div', { class: 'timer-row' }, tAtLabel, tAt);
    const rowWeek = el('div', { class: 'timer-row' }, el('span', { class: 'muted-sm' }, '星期'), tWeek);
    const rowMonth = el('div', { class: 'timer-row' }, tMonthDay);

    function syncRowVisibility() {
      const ev = tEvery.value;
      rowAt.style.display = ev === 'hour' ? 'none' : '';
      rowMinute.style.display = ev === 'hour' ? '' : 'none';
      rowWeek.style.display = ev === 'week' ? '' : 'none';
      rowMonth.style.display = ev === 'month' ? '' : 'none';
      tIntervalUnit.textContent = ev === 'hour' ? '小时（整点后的第几分钟见下）'
        : ev === 'day' ? '天'
          : ev === 'week' ? '周'
            : '个月';
    }

    timerBox.append(
      el('div', { class: 'timer-head' },
        el('label', { class: 'switch' }, tEnabled, el('span', {})),
        el('div', {}, el('div', { style: 'font-weight:600' }, '定时自动扫描书库'),
          el('div', { class: 'muted-sm' }, '到点自动扫描，同名书籍会自动合并；可顺手开启自动刮削，把简介与封面补齐。'))),
      el('div', { class: 'timer-body' }, rowEvery, rowMinute, rowAt, rowWeek, rowMonth,
        el('label', { class: 'check-line' }, tScrape, '扫描完成后自动刮削（后台逐本补全简介 / 封面）'),
        tNext,
        el('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' }, tSave,
          el('button', { class: 'btn sm ghost', onclick: async e => {
            e.target.disabled = true;
            try {
              const r = await api('/scan', { method: 'POST', body: JSON.stringify({}) });
              if (r && r.started) notify('已开始扫描书库');
              else notify((r && r.message) || '已在扫描中');
              refreshScan();
            } catch (err) { alert(err.message); }
            e.target.disabled = false;
          } }, '▶ 立即扫描一次')))
    );

    // 立即扫描（触发调度器），走到 /logs/auto-scan 会带上「手动触发」reason
    tEvery.addEventListener('change', syncRowVisibility);
    tInterval.addEventListener('input', syncRowVisibility);

    function fillTimer(st) {
      if (!st) return;
      tEnabled.checked = st.enabled !== false;
      tEvery.value = st.every || 'day';
      tInterval.value = st.interval || 1;
      tAt.value = st.at || `${String(st.hour || 0).padStart(2, '0')}:${String(st.minute || 0).padStart(2, '0')}`;
      tMinute.value = Number(st.minute) || 0;
      tScrape.checked = st.scrape !== false;
      const wd = Array.isArray(st.weekdays) ? st.weekdays : [0, 1, 2, 3, 4, 5, 6];
      for (const k of Object.keys(wdBoxes)) wdBoxes[k].checked = wd.indexOf(Number(k)) >= 0;
      tMonthDay.value = String(st.monthDay || 1);
      syncRowVisibility();
      const last = st.lastAt ? `上次 ${new Date(st.lastAt).toLocaleString('zh-CN')}（${st.lastReason || '定时触发'} · ${st.lastResult || ''}）` : '上次：尚未执行';
      const next = st.enabled === false ? '已停用' : (st.nextAt ? `下次 ${new Date(st.nextAt).toLocaleString('zh-CN')}` : '—');
      tNext.textContent = `${last} · ${next}`;
    }
    async function refreshTimer() {
      try { const d = await api('/scan/schedule'); fillTimer(d.autoScan); }
      catch (e) { tNext.textContent = '读取定时设置失败：' + e.message; }
    }
    tSave.addEventListener('click', async () => {
      const ev = tEvery.value;
      const body = {
        enabled: tEnabled.checked,
        every: ev,
        interval: Math.max(1, Number(tInterval.value) || 1),
        scrape: tScrape.checked
      };
      if (ev !== 'hour') body.at = tAt.value || '00:00';
      else body.minute = Math.min(59, Math.max(0, Number(tMinute.value) || 0));
      if (ev === 'week') {
        const wd = Object.keys(wdBoxes).filter(k => wdBoxes[k].checked).map(Number);
        if (!wd.length) return alert('请至少选一个星期几');
        body.weekdays = wd;
      }
      if (ev === 'month') body.monthDay = Number(tMonthDay.value) || 1;
      tSave.disabled = true;
      try {
        const r = await api('/scan/schedule', { method: 'PUT', body: JSON.stringify(body) });
        fillTimer(r.autoScan);
        notify('定时设置已保存');
      } catch (e) { alert(e.message); }
      tSave.disabled = false;
    });
    refreshTimer();

    scanPanel.append(el('h3', {}, '扫描与刮削'), el('div', {}, scanBtn, scrapeAllBtn), scanInfo, scanLog, timerBox);
    p.append(scanPanel);

    // 刮削设置
    const sc = settings.scrape || {};
    const scPanel = el('div', { class: 'panel' }, el('h3', {}, '在线刮削'));
    const scEnabled = el('input', { type: 'checkbox' }); scEnabled.checked = !!sc.enabled;
    scPanel.append(el('div', { class: 'field', style: 'display:flex;gap:16px;align-items:center' },
      el('label', { class: 'switch' }, scEnabled, el('span', {})), '启用在线刮削（应用本身离线可用，仅此功能需要外网）'));

    const providerBox = el('div', { class: 'prov-grid' });
    const selected = new Set(sc.providers || [sc.provider || 'douban']);
    const provDesc = {
      douban: '图书条目：书名/作者/ISBN/评分/封面（首选）',
      isbn: '用 ISBN 直接命中豆瓣条目，准确率最高',
      dangdang: '当当图书商品页（含出版信息）',
      nlc: '国家图书馆 OPAC（实验：多数家庭网络不可达）',
      duxiu: '读秀（实验：需机构账号或校园网）'
    };
    for (const pv of providers) {
      const cb = el('input', { type: 'checkbox' }); cb.checked = selected.has(pv.id);
      cb.dataset.id = pv.id;
      providerBox.append(el('label', { class: 'prov', title: provDesc[pv.id] || '' }, cb,
        el('span', {}, pv.name),
        el('span', { class: 'prov-tag' }, provDesc[pv.id] || '')));
    }
    scPanel.append(el('div', { class: 'field' }, el('label', {}, '刮削源（按勾选顺序依次尝试）'), providerBox));

    const refineCb = el('input', { type: 'checkbox' }); refineCb.checked = sc.refine !== false;
    const coverCb = el('input', { type: 'checkbox' }); coverCb.checked = sc.cover !== false;
    scPanel.append(
      el('label', { class: 'check-line' }, refineCb, '刮不到时，读取前 10 页正文提取书名/作者/ISBN 再刮一次'),
      el('label', { class: 'check-line' }, coverCb, '下载封面图（保存到应用数据目录）'),
      el('p', { class: 'muted-sm' }, '说明：刮削源的网页抓取可能受访问频率限制，命中失败的书会留到下次再试。'),
      el('button', { class: 'btn', onclick: async () => {
        const ids = [...providerBox.querySelectorAll('input:checked')].map(i => i.dataset.id);
        await save({ scrape: { enabled: scEnabled.checked, providers: ids, provider: ids[0], refine: refineCb.checked, cover: coverCb.checked } });
        alert('已保存');
      } }, '保存刮削设置'));
    p.append(scPanel);
    refreshScan();
  }

  // ---------- 1.9.0：APP 安装包 ----------
  async function loadAppsPanel() {
    const p = panels.apps;
    p.innerHTML = '';
    let data;
    try { data = await api('/app/info'); }
    catch (e) { p.append(el('p', { class: 'muted-sm' }, '读取失败：' + e.message)); return; }

    const panel = el('div', { class: 'panel' },
      el('h3', {}, '📱 客户端安装包'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' },
        '上传手机/平板版与 TV 版的 APK。网页左侧栏会显示「下载 APP」入口；已安装的 APP 启动时会向本机比对版本号，发现新版就提示下载并直接调起系统安装。'));
    p.append(panel);

    const kindName = { phone: '手机 / 平板版', tv: 'TV 版' };
    for (const kind of ['phone', 'tv']) {
      const m = data.items[kind];
      const box = el('div', { class: 'app-admin-card' });
      box.append(el('div', { class: 'app-admin-head' },
        el('b', {}, kindName[kind]),
        m ? el('span', { class: 'app-tag' }, `v${m.version || '?'}（${m.code || 0}）`) : el('span', { class: 'app-tag off' }, '未上传')));
      if (m) {
        box.append(el('div', { class: 'muted-sm' }, `${fmtSize(m.size)} · ${new Date(m.at).toLocaleString('zh-CN')} 上传 · md5 ${String(m.md5 || '').slice(0, 8)}`));
        box.append(el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' },
          el('button', { class: 'btn sm ghost', onclick: e => saveFile(A(`/api/app/download/${kind}`), `fnbookshelf-${kind}-${m.version}.apk`, e.currentTarget) }, '⬇ 下载'),
          el('button', { class: 'btn sm ghost danger-text', onclick: async () => {
            if (!confirm(`删除已上传的${kindName[kind]}安装包？`)) return;
            try { await api('/app/' + kind, { method: 'DELETE' }); loadAppsPanel(); } catch (err) { alert(err.message); }
          } }, '删除')));
      }
      // 上传区
      const fileInput = el('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive' });
      const verInput = el('input', { placeholder: '版本号，例如 1.9.0', value: m ? m.version : '', style: 'width:150px' });
      const stat = el('span', { class: 'muted-sm' });
      const upBtn = el('button', { class: 'btn sm', onclick: async () => {
        const f = (fileInput.files || [])[0];
        if (!f) return alert('请先选择 APK 文件');
        const ver = (verInput.value || '').trim().replace(/[^\d.]/g, '');
        if (!ver) return alert('请填写版本号（例如 1.9.0）');
        if (f.size > 120 * 1024 * 1024) return alert('安装包超过 120MB');
        upBtn.disabled = true; stat.textContent = '读取文件…';
        try {
          const b64 = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result).split(',')[1] || '');
            fr.onerror = () => rej(new Error('读取文件失败'));
            fr.readAsDataURL(f);
          });
          stat.textContent = '上传中…';
          const parts = ver.split('.').map(n => parseInt(n, 10) || 0);
          const code = (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
          await api('/app/upload', { method: 'POST', body: JSON.stringify({ kind, data: b64, version: ver, code, name: f.name }) });
          notify(`${kindName[kind]} ${ver} 已上传`);
          loadAppsPanel();
        } catch (err) { alert(err.message); upBtn.disabled = false; stat.textContent = ''; }
      } }, '⬆ 上传');
      box.append(el('div', { class: 'app-up-row' }, fileInput, verInput, upBtn, stat));
      panel.append(box);
    }
    panel.append(el('p', { class: 'muted-sm', style: 'margin-top:12px' },
      '提示：版本号要与 APK 内一致（构建脚本会写进 AndroidManifest 的 versionName/versionCode），否则 APP 会一直提示有新版。'));
  }

  // ---------- 1.9.0：找书通知（用户搜不到书时发来的） ----------
  async function loadNotesPanel() {
    const p = panels.notes;
    p.innerHTML = '';
    let data;
    try { data = await api('/notifications'); }
    catch (e) { p.append(el('p', { class: 'muted-sm' }, '读取失败：' + e.message)); return; }
    const panel = el('div', { class: 'panel' },
      el('h3', {}, `📣 找书通知（${(data.items || []).length}）`),
      el('p', { class: 'muted-sm', style: 'margin-bottom:12px' },
        '用户在书库里搜不到书时，可以一键把搜索词发给你。这里能看出书库缺什么，按这些词去补书最直接。'));
    if (!(data.items || []).length) {
      panel.append(el('p', { class: 'muted-sm' }, '暂时没有通知。'));
    } else {
      const list = el('div', { class: 'note-list' });
      for (const n of data.items) {
        list.append(el('div', { class: 'note-row' },
          el('span', { class: 'note-q' }, n.q),
          el('span', { class: 'muted-sm' }, `${n.byEmail || '—'} · ${new Date(n.at).toLocaleString('zh-CN')}${n.scope === 'collection' ? ' · 专题内' : ''}`)));
      }
      panel.append(list);
      panel.append(el('button', { class: 'btn sm ghost danger-text', style: 'margin-top:12px', onclick: async () => {
        if (!confirm('清空全部找书通知？')) return;
        try { await api('/notifications', { method: 'DELETE' }); loadNotesPanel(); } catch (e) { alert(e.message); }
      } }, '清空全部'));
    }
    p.append(panel);
  }

  // ---------- 删除审核 ----------
  async function loadDeletions() {
    const p = panels.deletions;
    const data = await api('/deletions');
    p.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, `删除申请（待处理 ${data.pending}）`),
      el('p', { class: 'muted-sm', style: 'margin-bottom:12px' }, '所有删除都会先进入这里。确认后文件会被移动到应用数据目录的回收站（不会立即物理销毁），可随时从回收站取出。'));
    if (!data.items.length) panel.append(el('p', { class: 'muted-sm' }, '暂无删除申请。'));
    for (const d of data.items) {
      const statusText = { pending: '⏳ 待确认', approved: '✅ 已删除', rejected: '↩ 已拒绝' }[d.status] || d.status;
      const usageLines = (d.usage || []).map(u => `${u.email}：书签 ${u.bookmarks} 个、笔记 ${u.notes} 条`).join('；');
      const row = el('div', { class: 'del-row' },
        el('div', { class: 'del-main' },
          el('div', { class: 'del-title' }, d.title + ' · ' + d.filename),
          el('div', { class: 'del-meta' },
            `${d.requestedByEmail || d.requestedBy} 申请于 ${new Date(d.requestedAt).toLocaleString('zh-CN')}`,
            d.exists ? ` · ${fmtSize(d.size)}` : ' · 文件已不存在',
            d.note ? ` · 备注：${d.note}` : ''),
          usageLines ? el('div', { class: 'del-usage' }, '🔖 用户记录：' + usageLines) : null,
          el('div', { class: 'del-path' }, d.path || '')),
        el('div', { class: 'del-act' }, el('span', { class: 'del-status ' + d.status }, statusText)));
      if (d.status === 'pending') {
        row.querySelector('.del-act').append(
          el('button', { class: 'btn sm danger', onclick: async () => {
            const warn = usageLines ? `\n\n⚠️ 该版本上有用户书签/笔记：${usageLines}\n删除后这些记录将失效。` : '';
            if (!confirm(`确认删除文件？\n\n${d.path}${warn}\n\n文件会移入回收站，不会立刻物理删除。`)) return;
            try { await api(`/deletions/${d.id}/approve`, { method: 'POST' }); loadDeletions(); } catch (e) { alert(e.message); }
          } }, '确认删除'),
          el('button', { class: 'btn sm ghost', onclick: async () => { await api(`/deletions/${d.id}/reject`, { method: 'POST' }); loadDeletions(); } }, '拒绝'));
      }
      panel.append(row);
    }
    p.append(panel);

    const trash = await api('/trash');
    const keepDays = trash.keepDays || 30;
    const tp = el('div', { class: 'panel' }, el('h3', {}, `回收站（${trash.items.length} 个文件）`),
      el('p', { class: 'muted-sm', style: 'margin-bottom:10px' },
        `目录：${trash.dir} · 文件进入回收站 ${keepDays} 天后自动删除，删除前都可以「恢复」回原目录。`));
    if (!trash.items.length) tp.append(el('p', { class: 'muted-sm' }, '回收站是空的。'));

    // 顶部操作：清空过期的 / 清空全部
    const headActs = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' });
    if (trash.items.length) {
      headActs.append(
        el('button', { class: 'btn sm ghost', onclick: async () => {
          try {
            const r = await api('/trash/empty', { method: 'POST', body: JSON.stringify({ expired: true }) });
            notify(r.removed ? `已清空 ${r.removed} 个过期文件` : '没有过期文件需要清理');
            loadDeletions();
          } catch (e) { alert(e.message); }
        } }, '🧹 清空过期文件'),
        el('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm(`清空回收站里的全部 ${trash.items.length} 个文件？\n\n此操作会物理删除文件，无法恢复。`)) return;
          try {
            const r = await api('/trash/empty', { method: 'POST', body: JSON.stringify({}) });
            notify(`已清空 ${r.removed} 个文件`);
            loadDeletions();
          } catch (e) { alert(e.message); }
        } }, '🗑 清空全部'));
    }
    tp.append(headActs);

    const now = Date.now();
    for (const t of trash.items.slice(0, 200)) {
      const leftDays = Math.max(0, Math.ceil(((t.expireAt || 0) - now) / 86400000));
      const expired = (t.expireAt || 0) <= now;
      const act = el('div', { class: 'trash-act' });
      act.append(
        el('button', { class: 'btn sm', title: t.path ? '恢复到原位置' : '恢复（找不到原路径时放到数据目录 restored/）', onclick: async e => {
          e.target.disabled = true;
          try {
            const r = await api(`/trash/${encodeURIComponent(t.name)}/restore`, { method: 'POST', body: JSON.stringify({ path: t.path || '' }) });
            notify('已恢复：' + (r.restored || r.original));
            loadDeletions();
          } catch (err) { alert(err.message); e.target.disabled = false; }
        } }, '↩ 恢复'),
        el('button', { class: 'btn sm danger', title: '从磁盘彻底删除这个文件', onclick: async () => {
          if (!confirm(`彻底删除「${t.original}」？\n\n文件将被物理删除，无法恢复。`)) return;
          try { await api(`/trash/${encodeURIComponent(t.name)}`, { method: 'DELETE' }); loadDeletions(); }
          catch (e) { alert(e.message); }
        } }, '🗑 清空'));
      tp.append(el('div', { class: 'trash-row' },
        el('div', { class: 'trash-main' },
          el('div', { class: 'trash-name' }, t.original || t.name),
          el('div', { class: 'trash-meta' },
            `${fmtSize(t.size)} · 删除于 ${new Date(t.at).toLocaleString('zh-CN')} · `,
            el('span', { class: expired ? 'danger-text' : '' }, expired ? '已过期，下次清理时删除' : `${leftDays} 天后自动删除`)),
          t.path ? el('div', { class: 'del-path' }, t.path) : null),
        act));
    }
    p.append(tp);
  }

  // ---------- 用户 ----------
  async function loadUsers() {
    const users = (await api('/users')).users;
    const p = panels.users;
    p.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, `用户管理（共 ${users.length} 人）`));
    const tbl = el('table', { class: 'table' });
    tbl.append(el('tr', {}, ...['邮箱', '角色', '状态', '注册时间', '操作'].map(h => el('th', {}, h))));
    for (const u of users) {
      const roleSel = el('select', {}, el('option', { value: 'user' }, '普通用户'), el('option', { value: 'admin' }, '管理员'));
      roleSel.value = u.role;
      roleSel.addEventListener('change', async () => { try { await api(`/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ role: roleSel.value }) }); loadUsers(); } catch (e) { alert(e.message); } });
      const actBtns = el('div', { style: 'display:flex;gap:6px' });
      if (u.status !== 'active') actBtns.append(el('button', { class: 'btn sm', onclick: async () => { await api(`/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ status: 'active' }) }); loadUsers(); } }, u.status === 'pending' ? '✓ 通过' : '启用'));
      else if (u.id !== state.user.id) actBtns.append(el('button', { class: 'btn sm ghost', onclick: async () => { await api(`/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ status: 'disabled' }) }); loadUsers(); } }, '禁用'));
      if (u.id !== state.user.id) actBtns.append(el('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`删除用户 ${u.email}？`)) { await api(`/users/${u.id}`, { method: 'DELETE' }); loadUsers(); } } }, '删除'));
      tbl.append(el('tr', {}, el('td', {}, u.email), el('td', {}, roleSel),
        el('td', {}, u.status === 'active' ? '✅ 正常' : u.status === 'pending' ? '⏳ 待审核' : '⛔ 已禁用'),
        el('td', {}, fmtDate(u.createdAt)), el('td', {}, actBtns)));
    }
    panel.append(tbl);
    p.append(panel);

    const regPanel = el('div', { class: 'panel' });
    const regSel = el('select', {},
      el('option', { value: 'auto' }, '开放注册（验证即用）'),
      el('option', { value: 'approve' }, '注册需管理员审核'),
      el('option', { value: 'closed' }, '关闭注册'));
    regSel.value = settings.registerMode || 'auto';
    regPanel.append(el('h3', {}, '注册策略'),
      el('div', { class: 'field', style: 'max-width:320px' }, regSel),
      el('button', { class: 'btn', onclick: async () => { await save({ registerMode: regSel.value }); alert('已保存'); } }, '保存'));
    p.append(regPanel);
  }

  // ---------- 统计 ----------
  async function loadStats() {
    const p = panels.stats;
    p.innerHTML = '';
    const data = await api('/stats/users');
    const total = data.users.reduce((a, u) => a + u.totalSec, 0);
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, '全体用户阅读统计'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:12px' }, `累计阅读 ${fmtDur(total)} · 共 ${data.users.length} 位用户 · 今日 AI 调用 ${data.aiTodayTotal} 次`));
    const tbl = el('table', { class: 'table' });
    tbl.append(el('tr', {}, ...['邮箱', '角色', '累计时长', '打开次数', '涉及图书', '今日 AI', '最近在读'].map(h => el('th', {}, h))));
    for (const u of data.users) {
      tbl.append(el('tr', {},
        el('td', {}, u.email),
        el('td', {}, u.role === 'admin' ? '管理员' : '普通用户'),
        el('td', {}, fmtDur(u.totalSec)),
        el('td', {}, String(u.opened || 0)),
        el('td', {}, String(u.books || 0) + ' 本'),
        el('td', {}, String(u.aiToday || 0) + ' 次'),
        el('td', {}, u.lastBook || '—')));
    }
    panel.append(tbl);
    p.append(panel);
  }

  // ---------- TTS ----------
  function ttsPanel() {
    const p = panels.tts;
    p.innerHTML = '';
    const t = settings.tts || {};
    const panel = el('div', { class: 'panel' }, el('h3', {}, '语音朗读（TTS）'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' }, '默认使用浏览器本地语音，完全离线、无需配置。如需更自然的音色，可接入 OpenAI 兼容语音接口或微软 Azure 语音。'));

    const enabledCb = el('input', { type: 'checkbox' }); enabledCb.checked = t.enabled !== false;
    panel.append(el('label', { class: 'check-line', style: 'margin-bottom:12px' }, enabledCb, '启用语音朗读（关闭后所有用户的阅读器不再显示朗读按钮）'));

    const engineSel = el('select', {},
      el('option', { value: 'browser' }, '浏览器本地语音（离线，免费）'),
      el('option', { value: 'openai' }, 'OpenAI 兼容语音接口'),
      el('option', { value: 'azure' }, '微软 Azure 语音'));
    engineSel.value = t.engine || 'browser';
    panel.append(el('div', { class: 'field', style: 'max-width:420px' }, el('label', {}, '朗读引擎'), engineSel));

    const openaiBox = el('div', { class: 'subpanel' });
    openaiBox.append(el('h4', {}, 'OpenAI 兼容语音'));
    {
      const i = el('input', { placeholder: 'https://api.openai.com/v1' }); i.value = (t.openai || {}).baseUrl || ''; openaiBox.baseUrl = i;
      openaiBox.append(el('div', { class: 'field' }, el('label', {}, '接口地址'), i));
      const k = el('input', { type: 'password', placeholder: '留空表示不修改' }); k.value = (t.openai || {}).apiKey || ''; openaiBox.apiKey = k;
      openaiBox.append(el('div', { class: 'field' }, el('label', {}, 'API Key'), k));
      const mi = el('input', { placeholder: 'tts-1' }); mi.value = (t.openai || {}).model || 'tts-1'; openaiBox.model = mi;
      const vs = el('select', {}, ...['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(v => el('option', { value: v }, v)));
      vs.value = (t.openai || {}).voice || 'alloy'; openaiBox.voice = vs;
      openaiBox.append(el('div', { class: 'two-col' },
        el('div', { class: 'field' }, el('label', {}, '模型'), mi),
        el('div', { class: 'field' }, el('label', {}, '音色'), vs)));
    }
    const azureBox = el('div', { class: 'subpanel' });
    azureBox.append(el('h4', {}, 'Azure 语音'));
    {
      const ri = el('input', { placeholder: 'eastasia' }); ri.value = (t.azure || {}).region || ''; azureBox.region = ri;
      const ki = el('input', { type: 'password', placeholder: '留空表示不修改' }); ki.value = (t.azure || {}).key || ''; azureBox.key = ki;
      azureBox.append(el('div', { class: 'two-col' },
        el('div', { class: 'field' }, el('label', {}, '区域'), ri),
        el('div', { class: 'field' }, el('label', {}, '订阅 Key'), ki)));
      const vs = el('select', {}, ...['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural'].map(v => el('option', { value: v }, v)));
      vs.value = (t.azure || {}).voice || 'zh-CN-XiaoxiaoNeural'; azureBox.voice = vs;
      azureBox.append(el('div', { class: 'field', style: 'max-width:420px' }, el('label', {}, '音色'), vs));
    }
    const rateInput = el('input', { type: 'number', step: '0.05', min: '0.5', max: '2.5', value: String(t.rate || 1) });
    const autoNext = el('input', { type: 'checkbox' }); autoNext.checked = t.autoNext !== false;

    const showEngine = () => {
      openaiBox.style.display = engineSel.value === 'openai' ? '' : 'none';
      azureBox.style.display = engineSel.value === 'azure' ? '' : 'none';
    };
    engineSel.addEventListener('change', showEngine);
    showEngine();

    const testBtn = el('button', { class: 'btn ghost', onclick: async e => {
      e.target.disabled = true; e.target.textContent = '合成中…';
      try {
        const res = await fetch(A('/api/settings/tts-test'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
          body: JSON.stringify({ text: '飞牛书屋语音朗读测试，这是一段示例音频。' })
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || '合成失败');
        }
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        audio.play();
      } catch (err) { alert(err.message); }
      e.target.disabled = false; e.target.textContent = '试听';
    } });

    panel.append(openaiBox, azureBox,
      el('div', { class: 'two-col' },
        el('div', { class: 'field' }, el('label', {}, '默认语速（0.5–2.5）'), rateInput),
        el('label', { class: 'check-line', style: 'margin-top:26px' }, autoNext, '朗读时自动翻到下一页')),
      el('div', { style: 'display:flex;gap:10px;margin-top:6px' },
        el('button', { class: 'btn', onclick: async () => {
          const body = {
            tts: {
              enabled: enabledCb.checked,
              engine: engineSel.value, rate: rateInput.value, autoNext: autoNext.checked,
              openai: { baseUrl: openaiBox.baseUrl.value, apiKey: openaiBox.apiKey.value, model: openaiBox.model.value, voice: openaiBox.voice.value },
              azure: { region: azureBox.region.value, key: azureBox.key.value, voice: azureBox.voice.value }
            }
          };
          await save(body);
          state.site = null; // 让阅读器重新拉取 TTS 开关状态
          alert('已保存');
        } }, '保存'),
        testBtn));
    p.append(panel);
  }

  // ---------- AI ----------
  function aiPanel() {
    const p = panels.ai;
    p.innerHTML = '';
    const a = settings.ai || {};
    const panel = el('div', { class: 'panel' }, el('h3', {}, 'AI 阅读助手'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' },
        '配置后可为用户提供三项能力：① 书库内智能找书 ② 阅读时结合上下文答疑 ③ 外文段落翻译。所有调用都限定在书籍范围内，并受每人每日次数限制。'));

    const enabled = el('input', { type: 'checkbox' }); enabled.checked = !!a.enabled;
    const baseUrl = el('input', { placeholder: 'https://api.openai.com/v1' }); baseUrl.value = a.baseUrl || '';
    const apiKey = el('input', { type: 'password', placeholder: '留空表示不修改' }); apiKey.value = a.apiKey || '';
    const model = el('input', { placeholder: 'gpt-4o-mini' }); model.value = a.model || '';
    const limit = el('input', { type: 'number', min: '0', max: '2000', value: String(a.dailyLimit || 40) });
    const maxTokens = el('input', { type: 'number', min: '100', max: '1200', value: String(a.maxTokens || 600) });
    const temp = el('input', { type: 'number', step: '0.05', min: '0', max: '1.2', value: String(a.temperature == null ? 0.3 : a.temperature) });
    const fRecommend = el('input', { type: 'checkbox' }); fRecommend.checked = a.recommend !== false;
    const fAsk = el('input', { type: 'checkbox' }); fAsk.checked = a.ask !== false;
    const fTranslate = el('input', { type: 'checkbox' }); fTranslate.checked = a.translate !== false;
    const fStrict = el('input', { type: 'checkbox' }); fStrict.checked = a.strict !== false;

    panel.append(
      el('label', { class: 'check-line' }, enabled, '启用 AI 功能'),
      el('div', { class: 'two-col' },
        el('div', { class: 'field' }, el('label', {}, '接口地址（OpenAI 兼容）'), baseUrl),
        el('div', { class: 'field' }, el('label', {}, '模型'), model)),
      el('div', { class: 'field' }, el('label', {}, 'API Key'), apiKey),
      el('div', { class: 'three-col' },
        el('div', { class: 'field' }, el('label', {}, '每人每日次数'), limit),
        el('div', { class: 'field' }, el('label', {}, '单次最大输出 token'), maxTokens),
        el('div', { class: 'field' }, el('label', {}, '温度'), temp)),
      el('div', { class: 'field' }, el('label', {}, '开放能力'),
        el('div', { class: 'check-grid' },
          el('label', { class: 'check-line' }, fRecommend, '书库内智能找书'),
          el('label', { class: 'check-line' }, fAsk, '阅读上下文答疑'),
          el('label', { class: 'check-line' }, fTranslate, '段落/整页翻译'))),
      el('label', { class: 'check-line' }, fStrict, '严格边界：只回答书籍相关问题，拒绝无关与复杂请求（推荐开启）'),
      el('p', { class: 'muted-sm', style: 'margin:10px 0' }, '边界策略：单次提问超过 320 字、包含多个子问题、或涉及编程/代写/算术/生活服务等问题时直接拒绝，不消耗配额。'),
      el('div', { style: 'display:flex;gap:10px' },
        el('button', { class: 'btn', onclick: async () => {
          await save({
            ai: {
              enabled: enabled.checked, baseUrl: baseUrl.value, apiKey: apiKey.value, model: model.value,
              dailyLimit: limit.value, maxTokens: maxTokens.value, temperature: temp.value,
              recommend: fRecommend.checked, ask: fAsk.checked, translate: fTranslate.checked, strict: fStrict.checked
            }
          });
          alert('已保存');
        } }, '保存'),
        el('button', { class: 'btn ghost', onclick: async e => {
          e.target.disabled = true; e.target.textContent = '测试中…';
          try {
            const r = await api('/settings/ai-test', { method: 'POST', body: '{}' });
            alert(`连接成功\n模型：${r.model}\n返回：${r.reply}\n今日全站调用：${r.quotaToday} 次`);
          } catch (err) { alert('连接失败：' + err.message); }
          e.target.disabled = false; e.target.textContent = '测试连接';
        } }, '测试连接')));
    p.append(panel);
  }

  // ---------- 邮箱 / HTTPS / 数据 ----------
  function mailPanel() {
    const p = panels.mail;
    p.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    const f = {};
    const mk = (key, label, type, val, ph) => {
      f[key] = el('input', { type: type || 'text', placeholder: ph || '' });
      if (val) f[key].value = val;
      return el('div', { class: 'field' }, el('label', {}, label), f[key]);
    };
    panel.append(el('h3', {}, '发件邮箱（SMTP）配置'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' }, '用于向用户发送登录验证码。推荐 QQ 邮箱（smtp.qq.com，端口 465）或 163 邮箱，需使用授权码作为密码。'),
      mk('host', 'SMTP 服务器', 'text', settings.smtp.host, 'smtp.qq.com'),
      el('div', { style: 'display:flex;gap:12px' },
        el('div', { class: 'field', style: 'width:140px' }, el('label', {}, '端口'), (() => { f.port = el('input', { type: 'number' }); f.port.value = settings.smtp.port || 465; return f.port; })()),
        el('div', { class: 'field', style: 'width:140px' }, el('label', {}, '加密'), (() => { f.secure = el('select', {}, el('option', { value: 'true' }, 'SSL (465)'), el('option', { value: 'false' }, 'STARTTLS (587)')); f.secure.value = String(settings.smtp.secure !== false); return f.secure; })())),
      mk('user', '账号', 'text', settings.smtp.user, 'user@qq.com'),
      mk('pass', '密码 / 授权码', 'password', settings.smtp.pass, 'SMTP 授权码'),
      mk('from', '发件人地址（可选，默认同账号）', 'text', settings.smtp.from),
      el('div', { style: 'display:flex;gap:10px' },
        el('button', { class: 'btn', onclick: async () => {
          try {
            await save({ smtp: { host: f.host.value, port: f.port.value, secure: f.secure.value === 'true', user: f.user.value, pass: f.pass.value, from: f.from.value } });
            mailPanel(); alert('已保存');
          } catch (e) { alert(e.message); }
        } }, '保存配置'),
        el('button', { class: 'btn ghost', onclick: async e => {
          e.target.disabled = true; e.target.textContent = '发送中…';
          try { await api('/settings/smtp-test', { method: 'POST', body: JSON.stringify({ to: f.user.value, pass: f.pass.value }) }); alert('测试邮件已发送，请查收'); }
          catch (err) { alert('发送失败：' + err.message); }
          e.target.disabled = false; e.target.textContent = '发送测试邮件';
        } }, '发送测试邮件')));
    p.append(panel);
  }

  function securityPanel() {
    const p = panels.security;
    p.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    const modeSel = el('select', {},
      el('option', { value: 'self' }, '自签名证书（默认，首次访问需手动信任）'),
      el('option', { value: 'custom' }, '自定义证书（粘贴 PEM）'),
      el('option', { value: 'off' }, '关闭 HTTPS（不推荐）'));
    modeSel.value = settings.https.mode;
    const certTa = el('textarea', { rows: '5', placeholder: '-----BEGIN CERTIFICATE-----' });
    const keyTa = el('textarea', { rows: '5', placeholder: '-----BEGIN PRIVATE KEY-----' });
    for (const t of [certTa, keyTa]) { t.style.fontFamily = 'monospace'; t.style.width = '100%'; }
    const wrap1 = el('div', { class: 'field' }, el('label', {}, '证书 (cert PEM)'), certTa);
    const wrap2 = el('div', { class: 'field' }, el('label', {}, '私钥 (key PEM)'), keyTa);
    const showTa = () => { wrap1.style.display = wrap2.style.display = modeSel.value === 'custom' ? '' : 'none'; };
    modeSel.addEventListener('change', showTa); showTa();
    panel.append(el('h3', {}, 'HTTPS 加密访问'),
      el('div', { class: 'field', style: 'max-width:420px' }, el('label', {}, '证书模式'), modeSel), wrap1, wrap2,
      el('button', { class: 'btn', onclick: async () => {
        try {
          const body = { https: { mode: modeSel.value } };
          if (modeSel.value === 'custom') {
            body.https.cert = certTa.value.trim(); body.https.key = keyTa.value.trim();
            if (!body.https.cert || !body.https.key) return alert('请粘贴证书与私钥');
          }
          await save(body);
          alert('已保存，新配置将在应用重启后完全生效');
        } catch (e) { alert(e.message); }
      } }, '保存'),
      el('p', { class: 'muted-sm', style: 'margin-top:12px' }, '如需在飞牛桌面入口中免警告访问，建议为 NAS 申请正式证书后粘贴到上方。'));
    p.append(panel);

    // ---------- 1.7.0：登录与权限 ----------
    const sec = Object.assign({ tokenTtlHours: 24, collaborativeLibrary: false, frameAncestors: '' }, settings.security || {});
    const ttlInput = el('input', { type: 'number', min: '1', max: '168', value: String(sec.tokenTtlHours || 24), style: 'max-width:120px' });
    const faInput = el('input', { type: 'text', placeholder: 'https://nas.example.com:5666（空格分隔多个）', value: sec.frameAncestors || '' });
    const collab = el('input', { type: 'checkbox' });
    collab.checked = !!sec.collaborativeLibrary;
    const p2 = el('div', { class: 'panel' },
      el('h3', {}, '登录与权限'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' },
        '登录令牌默认 24 小时有效，可在 1–168 小时之间调整；服务端会随请求静默续期，正常使用不会被打断。「退出登录」现在会真正吊销服务端令牌，「退出所有设备」会让所有已签发的令牌立即失效。'),
      el('div', { class: 'field', style: 'max-width:260px' }, el('label', {}, '登录有效期（小时）'), ttlInput),
      el('div', { class: 'field' }, el('label', {}, '允许被哪些页面 iframe 嵌入（留空=仅同主机任意端口，即飞牛桌面）'), faInput),
      el('label', { style: 'display:flex;gap:8px;align-items:center;margin:10px 0;font-size:13.5px' },
        collab, el('span', {}, '允许普通用户管理书库（设置封面 / 合并版本 / 分离版本）——默认只有管理员可操作')),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
        el('button', { class: 'btn', onclick: async e => {
          e.target.disabled = true;
          try {
            await save({ security: {
              tokenTtlHours: Number(ttlInput.value) || 24,
              collaborativeLibrary: collab.checked,
              frameAncestors: faInput.value.trim()
            } });
            alert('已保存');
          } catch (err) { alert(err.message); }
          e.target.disabled = false;
        } }, '保存安全设置'),
        el('button', { class: 'btn ghost', onclick: () => logoutAll() }, '🚪 退出所有设备'),
        el('button', { class: 'btn ghost', onclick: async e => {
          e.target.disabled = true;
          try {
            const r = await api('/logs/audit?limit=50');
            const box = p2.querySelector('.audit-out');
            box.innerHTML = '';
            if (!r.items.length) { box.append(el('p', { class: 'muted-sm' }, '还没有记录。')); }
            for (const it of r.items) {
              box.append(el('div', { class: 'kv' },
                el('span', {}, new Date(it.at).toLocaleString('zh-CN')),
                el('div', {}, `${it.action} · ${it.byEmail || '—'} · ${it.target || ''}`)));
            }
          } catch (err) { alert(err.message); }
          e.target.disabled = false;
        } }, '📜 查看敏感操作记录')));
    p2.append(el('div', { class: 'audit-out' }));
    p.append(p2);
  }

  function dataPanel() {
    const p = panels.data;
    p.innerHTML = '';
    const panel = el('div', { class: 'panel' },
      el('h3', {}, '应用数据存放位置'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' },
        '所有数据（书库索引、封面、笔记、统计、语音缓存、回收站）默认保存在应用自身目录下，不占用飞牛系统盘。也可以迁移到 NAS 上任意数据盘。'),
      el('div', { class: 'kv' }, el('span', {}, '当前数据目录'), el('code', {}, storage.dataDir || '—')),
      el('div', { class: 'kv' }, el('span', {}, '缓存目录'), el('code', {}, storage.cacheDir || '—')),
      el('div', { class: 'kv' }, el('span', {}, '回收站'), el('code', {}, storage.trashDir || '—')));
    const input = el('input', { placeholder: '/vol1/1000/apps/fnbookshelf-data', style: 'flex:1' });
    panel.append(
      el('div', { class: 'field' }, el('label', {}, '迁移到新目录（绝对路径，需已存在或可创建）'), input),
      el('button', { class: 'btn', onclick: async () => {
        const dir = input.value.trim();
        if (!dir) return alert('请输入路径');
        if (!confirm(`将数据迁移到：\n${dir}\n\n会复制 data.json、封面与证书，然后需要重启应用生效。继续？`)) return;
        try {
          const r = await api('/storage/move', { method: 'POST', body: JSON.stringify({ dir }) });
          alert(`已迁移到：${r.dataDir}\n配置已写入：${r.pointer}\n\n请在应用中心重启「飞牛书屋」后生效。`);
        } catch (e) { alert(e.message); }
      } }, '开始迁移'),
      el('p', { class: 'muted-sm', style: 'margin-top:10px' }, '提示：迁移只复制，不删除原目录；确认新目录工作正常后可手动清理旧数据。'));
    p.append(panel);

    // ---------- 1.6.3：存储自检（封面 EACCES 崩溃的自查入口） ----------
    const diag = el('div', { class: 'panel' }, el('h3', {}, '🩺 存储自检'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:12px' },
        '检查数据目录是否可写、封面与图书文件是否可读。数据目录若是从旧安装拷贝来的，文件属主可能是 root，本进程（package 用户）读不了，会表现为封面空白、下载失败或进程崩溃。'));
    const diagBody = el('div', {});
    diag.append(diagBody);
    diag.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
      el('button', { class: 'btn sm', onclick: () => refreshDiag() }, '🔄 重新检查'),
      el('button', { class: 'btn sm ghost', onclick: async () => {
        try {
          const r = await api('/system/storage/repair', { method: 'POST' });
          alert(`已修正 ${r.chmodDirs} 个目录、${r.chmodFiles} 个文件` + (r.failed.length ? `\n\n仍有 ${r.failed.length} 个失败（属主不是本进程，需要 root 处理）：\n` + r.failed.slice(0, 5).join('\n') : ''));
          refreshDiag();
        } catch (e) { alert(e.message); }
      } }, '🔧 尝试修复权限'),
      el('button', { class: 'btn sm ghost', onclick: e => saveFile(A('/api/system/download-test' + tokenQ()), '飞牛书屋-下载测试.txt', e.currentTarget) }, '⬇ 测试下载')));
    diag.append(el('p', { class: 'muted-sm', style: 'margin-top:10px' },
      '「测试下载」会取回一个几十字节的小文件：能落盘说明浏览器本身允许下载，问题只在具体文件；仍然失败说明是浏览器/沙箱拦了下载（常见于自签名证书或嵌在飞牛桌面的 iframe 里）。'));
    p.append(diag);
    refreshDiag();

    function refreshDiag() {
      diagBody.innerHTML = '';
      api('/system/storage').then(a => {
        const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('div', {}, v));
        diagBody.append(
          kv('数据目录', el('code', {}, a.dataDir)),
          kv('进程 UID / GID', `${a.uid == null ? '—' : a.uid} / ${a.gid == null ? '—' : a.gid}`),
          kv('可写', a.writable ? '✅ 可写' : '❌ 不可写（' + a.error + '）'),
          kv('封面文件', `${a.covers.total} 个，其中 ${a.covers.unreadable} 个不可读`),
          kv('图书文件', `${a.books.total} 个，其中 ${a.books.unreadable} 个不可读`));
        if (a.covers.sample) diagBody.append(el('p', { class: 'muted-sm' }, '不可读封面示例：' + a.covers.sample));
        if (a.books.sample) diagBody.append(el('p', { class: 'muted-sm' }, '不可读图书示例：' + a.books.sample));
      }).catch(e => diagBody.append(el('p', { class: 'muted-sm' }, '自检失败：' + e.message)));
    }
  }

  // ---------- 系统日志 / 崩溃报告 ----------
  function logsPanel() {
    const p = panels.logs;
    p.innerHTML = '';
    const panel = el('div', { class: 'panel' }, el('h3', {}, '📋 系统日志与崩溃取证'),
      el('p', { class: 'muted-sm', style: 'margin-bottom:14px' },
        '日志按天分文件保存，最多保留 2 天，仅保存在本机，不会发送到任何邮箱。扫描时会持续记录进度与内存占用；若进程被系统强制终止，下次启动可在此还原崩溃现场。'));
    const status = el('div', { class: 'subpanel' });
    const acts = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:12px 0' },
      el('button', { class: 'btn sm', onclick: refresh }, '🔄 刷新日志'));
    const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('div', {}, v));
    const crashBox = el('div');
    const pre = el('div', { class: 'scan-log', style: 'max-height:420px;margin-top:8px' });

    panel.append(status, acts, el('h3', { style: 'margin-top:18px' }, '上次崩溃 / 异常退出'), crashBox,
      el('h3', { style: 'margin-top:18px' }, '最近日志'), pre);
    p.append(panel);

    async function refresh() {
      let d;
      try { d = await api('/logs'); } catch (e) { pre.textContent = '读取日志失败：' + e.message; return; }
      status.innerHTML = '';
      status.append(
        kv('日志保留', `最近 ${d.keepDays} 天 · 当前 ${d.files.length} 个文件（${d.files.map(f => f.day + ' ' + Math.round(f.size / 1024) + 'KB').join('、') || '无'}）`),
        kv('错误 / 阻塞', `${(d.errors || []).length} 条错误记录`),
        kv('日志外发', '已关闭（仅本机保存）'),
        kv('定时扫描', d.autoScan && d.autoScan.enabled === false ? '已停用（可在「扫描与刮削」里开启）'
          : (d.autoScan && d.autoScan.nextAt ? `下次 ${new Date(d.autoScan.nextAt).toLocaleString('zh-CN')}（周期设置在「扫描与刮削」里）` : '尚未设定')),
        kv('当前扫描', d.scan && d.scan.running
          ? `进行中：${d.scan.phase || ''} ${d.scan.scanned}/${d.scan.total}${d.scan.rssMB ? ` · 内存 ${d.scan.rssMB}MB` : ''}${d.scan.lastBook ? ` · 《${d.scan.lastBook}》` : ''}`
          : (d.scan && d.scan.more ? '空闲（还有未完成的分批，将自动续扫）' : '空闲')),
        kv('后台刮削', (() => {
          const w = d.scrapeWorker;
          if (!w) return '未启用';
          if (!w.enabled) return '已关闭（后台不开刮削）';
          const tail = `待补全 ${w.pending} 本 · 已完成 ${w.done} / 未命中 ${w.failed}`;
          if (w.running) return `正在补全《${w.current || ''}》 · ${tail}`;
          if (w.paused === 'scanning') return `让路中（扫描进行中） · ${tail}`;
          if (w.paused === 'memory') return `内存偏高，已暂停 · ${tail}`;
          return `空闲 · ${tail}`;
        })())
      );
      crashBox.innerHTML = '';
      if (d.crash) {
        const ex = d.crash.extra || {};
        const scene = [];
        if (ex.lastBook) scene.push(`最后处理《${ex.lastBook}》`);
        if (ex.total) scene.push(`进度 ${ex.scanned || 0}/${ex.total} 本`);
        if (ex.rssMB) scene.push(`当时内存约 ${ex.rssMB}MB`);
        const box = el('div', { class: 'boot-hint' }, el('div', {}, `${d.crash.time} · ${d.crash.reason}`));
        if (d.crash.message) box.append(el('div', { style: 'margin-top:6px' }, d.crash.message));
        if (scene.length) box.append(el('div', { style: 'margin-top:6px' }, '崩溃现场：' + scene.join(' · ')));
        box.append(el('div', { class: 'muted-sm', style: 'margin-top:4px' },
          `当时阶段：${d.crash.context || '—'} · 重启时内存 RSS ${d.crash.memoryMB ? d.crash.memoryMB.rss : '?'}MB · 运行 ${d.crash.uptimeSec || 0} 秒`));
        crashBox.append(box);
      } else crashBox.append(el('p', { class: 'muted-sm' }, '暂无崩溃记录，应用运行正常。'));
      pre.textContent = (d.lines || []).slice().reverse().map(l =>
        `[${new Date(l.t).toLocaleString('zh-CN')}] ${l.level.padEnd(5)} ${l.scope} · ${l.ctx || ''} · ${l.msg}`
      ).join('\n') || '暂无日志';
    }
    logsPanel.refresh = refresh;
    refresh();
  }

  main.append(tabs, ...Object.values(panels));
  switchTab('library');
  await loadLibraryPanel();
  await loadUsers();
  await loadStats();
  await loadDeletions();
  ttsPanel(); aiPanel(); mailPanel(); securityPanel(); dataPanel(); logsPanel();
  switchTab('library');
}

// ===== 启动 =====
(async function init() {
  try {
    if (state.token) {
      try { state.user = (await api('/me')).user; }
      catch (_) { state.user = null; state.token = ''; localStorage.removeItem('fb_token'); }
    }
    try { state.site = await api('/site'); } catch (_) {}
    state.canEdit = !!(state.site && state.site.canEdit) || !!(state.user && state.user.role === 'admin');
    await render();
  } catch (e) { fatal(e); }
})();
