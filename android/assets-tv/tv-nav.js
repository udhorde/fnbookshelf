/*
 * TV 端的遥控器空间导航。
 * 网页里的按钮大多是 div（没有 tabindex），原生方向键推不动焦点，
 * 这里自己维护一个「当前高亮元素」，方向键找几何上最近的邻居，确定键点击。
 * 输入框改成弹原生对话框（电视遥控器没有软键盘）。
 */
(function () {
  // 网页那边靠这个标记判断「现在是电视」：阅读器自动进沉浸全屏、方向键只挪焦点不翻页
  window.__FNB_TV__ = true;
  if (window.__tvNavReady) return;

  var SEL = 'a[href],button,input,select,textarea,[onclick],[tabindex],'
    + '.nav-item,.book-card,.col-card,.btn,.chip,.tag,.seg,.rd-toc-item,.col-card-new';
  var CLS = '__tvfocus';
  var cur = null;
  var waiting = {};
  var seq = 0;

  function style() {
    var s = document.createElement('style');
    s.id = '__tv_css';
    s.textContent = '.' + CLS + '{outline:3px solid #2563eb !important;outline-offset:3px !important;'
      + 'border-radius:12px !important;box-shadow:0 0 0 7px rgba(37,99,235,.20) !important;}'
      + '.__tv_num{display:none;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity || '1') === 0) return false;
    return true;
  }

  function list() {
    var out = [];
    // 必须用 Set：用普通对象做集合的话，所有 div 都会被转成 "[object HTMLDivElement]"
    // 当成同一个 key，除第一个外全被跳过，侧栏项和书卡就再也选不中了
    var seen = typeof Set === 'function' ? new Set() : null;
    var seenArr = seen ? null : [];
    var nodes = document.querySelectorAll(SEL);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (seen) {
        if (seen.has(el)) continue;
      } else {
        if (seenArr.indexOf(el) >= 0) continue;
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!visible(el)) continue;
      if (seen) seen.add(el); else seenArr.push(el);
      out.push(el);
    }
    return out;
  }

  function setCur(el, scroll) {
    if (cur && cur !== el) {
      try { cur.classList.remove(CLS); } catch (e) { }
    }
    cur = el;
    if (!el) return;
    try { el.classList.add(CLS); } catch (e) { }
    if (scroll !== false) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      } catch (e) {
        try { el.scrollIntoView(); } catch (e2) { }
      }
    }
  }

  function ensureCur() {
    if (cur && document.documentElement.contains(cur)) return cur;
    var all = list();
    if (!all.length) { cur = null; return null; }
    setCur(all[0], false);
    return cur;
  }

  function move(dir) {
    var all = list();
    if (!all.length) return false;
    var from = ensureCur();
    if (!from) return false;
    var a = from.getBoundingClientRect();
    var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === from) continue;
      var b = el.getBoundingClientRect();
      var bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
      var dx = bcx - acx, dy = bcy - acy;
      var main, cross;
      if (dir === 'left') { if (dx > -3) continue; main = -dx; cross = Math.abs(dy); }
      else if (dir === 'right') { if (dx < 3) continue; main = dx; cross = Math.abs(dy); }
      else if (dir === 'up') { if (dy > -3) continue; main = -dy; cross = Math.abs(dx); }
      else { if (dy < 3) continue; main = dy; cross = Math.abs(dx); }
      // 同一行/同一列（有重叠）的邻居要绝对优先，否则侧栏按↓ 会直接飞到右边的内容区
      var ovY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      var ovX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      var sameBand = (dir === 'left' || dir === 'right') ? ovY > 2 : ovX > 2;
      var score = sameBand ? (main + cross * 0.4) : (main + cross * 3 + 100000);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) return false;
    setCur(best);
    return true;
  }

  function askText(el) {
    var hint = el.getAttribute('placeholder') || el.getAttribute('aria-label')
      || el.getAttribute('title') || '请输入';
    var id = 'p' + (++seq);
    waiting[id] = el;
    try {
      FNB.prompt(hint, el.value || '', id);
    } catch (e) {
      try { el.focus(); } catch (e2) { }
    }
  }

  window.__fnbPrompt = function (id, text, ok) {
    var el = waiting[id];
    delete waiting[id];
    if (!el || !ok) return;
    try {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { }
  };

  // 排障用：命令行/测试里可以手动把高亮放到某个元素上
  window.__tvSetCur = function (el) { setCur(el, false); };

  // 1.9.0：进书籍详情页时，默认把高亮放到「开始阅读」上。
  // 详情页打开后是异步渲染的，所以给几次重试；只在刚进这一本时做一次，
  // 之后用户自己用方向键移动就不再抢焦点。
  function focusReadBtn() {
    var btns = document.querySelectorAll('.d-actions .btn, .d-actions button');
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent || '';
      if (t.indexOf('阅读') >= 0) {
        setCur(btns[i], true);
        return true;
      }
    }
    return false;
  }
  var lastBookHash = '';
  function checkBookDetail() {
    var m = (location.hash || '').match(/^#\/book\/([^?]+)/);
    var key = m ? m[1] : '';
    if (key === lastBookHash) return;
    lastBookHash = key;
    if (!key) return;
    var delays = [300, 700, 1200, 2000];
    for (var i = 0; i < delays.length; i++) {
      (function (d) {
        setTimeout(function () {
          if ((location.hash || '').indexOf('#/book/') !== 0) return;
          // 用户已经自己把高亮移进操作区了，就不要再抢回去
          var p = cur;
          while (p && p !== document.body) {
            if (p.className && String(p.className).indexOf('d-actions') >= 0) return;
            p = p.parentNode;
          }
          focusReadBtn();
        }, d);
      })(delays[i]);
    }
  }
  setInterval(checkBookDetail, 600);
  window.addEventListener('hashchange', checkBookDetail);

  function onKey(e) {
    var k = e.key;
    var dir = null;
    if (k === 'ArrowUp' || k === 'Up') dir = 'up';
    else if (k === 'ArrowDown' || k === 'Down') dir = 'down';
    else if (k === 'ArrowLeft' || k === 'Left') dir = 'left';
    else if (k === 'ArrowRight' || k === 'Right') dir = 'right';
    if (dir) {
      if (move(dir)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (k === 'Enter' || k === 'Select' || k === ' ') {
      var el = ensureCur();
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
        askText(el);
        return;
      }
      try { el.click(); } catch (err) { }
      // 点击后不立刻清高亮：页面若没跳转（比如点了个没反应的 div），高亮留在原地更符合直觉
      setTimeout(function () {
        if (!cur || !document.documentElement.contains(cur)) ensureCur();
      }, 400);
      return;
    }
  }

  document.addEventListener('keydown', onKey, true);

  // 页面结构变化（SPA 换路由）后，把高亮重新落到第一个可点元素上
  var mo = new MutationObserver(function () {
    if (cur && !document.documentElement.contains(cur)) {
      cur = null;
      setTimeout(function () { ensureCur(); }, 60);
    }
  });

  function boot() {
    if (!document.getElementById('__tv_css')) style();
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) { }
    setTimeout(function () {
      if (!cur) ensureCur();
    }, 400);
  }

  // 只有真正装好才打标记：注入时机太早（document 还没就绪）时留待下次重试
  try {
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
    window.__tvNavReady = 1;
  } catch (e) {
    try { document.addEventListener('DOMContentLoaded', boot); window.__tvNavReady = 1; } catch (e2) { }
  }
})();
