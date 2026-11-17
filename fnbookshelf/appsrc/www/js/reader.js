/* 飞牛书屋阅读器 1.2.0
   支持 EPUB / PDF / MOBI / TXT / CBZ / PPTX(逐页转图片 PDF)
   设置面板参照主流阅读器：字号、字体和间距、背景色板 + 底纹
*/
'use strict';

(function () {
  // ---------------- 常量 ----------------
  const BG_PRESETS = [
    { id: 'paper', name: '纸白', bg: '#ffffff', fg: '#1f2328' },
    { id: 'ink', name: '墨黑', bg: '#000000', fg: '#c9ccd1' },
    { id: 'cream', name: '米黄', bg: '#f7f1e3', fg: '#4a3f35' },
    { id: 'mint', name: '豆绿', bg: '#dcecd9', fg: '#2f4436' },
    { id: 'sky', name: '雾蓝', bg: '#e3eef8', fg: '#27394d' },
    { id: 'rose', name: '藕粉', bg: '#fbe6e9', fg: '#54383d' },
    { id: 'gray', name: '浅灰', bg: '#eceef1', fg: '#33383f' },
    { id: 'coal', name: '深灰', bg: '#1b1d21', fg: '#c2c6cc' },
    { id: 'navy', name: '藏青', bg: '#182538', fg: '#c3cfe0' },
    { id: 'sand', name: '沙色', bg: '#efe3cd', fg: '#4b3d2a' },
    { id: 'coffee', name: '深咖', bg: '#33261e', fg: '#dfcdb8' },
    { id: 'pearl', name: '珍珠', bg: '#f4f4f2', fg: '#2c2f33' }
  ];
  const TEXTURES = [
    { id: 'none', name: '无' },
    { id: 'paper', name: '纸张' },
    { id: 'grid', name: '网格' },
    { id: 'dots', name: '点阵' },
    { id: 'stripe', name: '条纹' }
  ];
  const FONTS = [
    { id: 'serif', name: '宋体 / 衬线', css: '"Noto Serif SC", "Songti SC", SimSun, Georgia, serif' },
    { id: 'sans', name: '黑体 / 无衬线', css: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif' },
    { id: 'kai', name: '楷体', css: '"Kaiti SC", KaiTi, STKaiti, serif' }
  ];
  const DEFAULT_CFG = {
    fontSize: 19, lineHeight: 1.9, theme: 'paper', texture: 'none',
    font: 'serif', paraSpace: 0.6, rate: 1, ttsEngine: 'browser', ttsVoice: ''
  };

  function loadCfg() {
    let cfg = Object.assign({}, DEFAULT_CFG);
    try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem('fb_reader2') || '{}')); } catch (_) {}
    const site = (state.site && state.site.reader) || {};
    for (const k of Object.keys(site)) if (cfg[k] === DEFAULT_CFG[k] && site[k] !== undefined) cfg[k] = site[k];
    return cfg;
  }
  function saveCfg(cfg) { try { localStorage.setItem('fb_reader2', JSON.stringify(cfg)); } catch (_) {} }
  const presetOf = id => BG_PRESETS.find(b => b.id === id) || BG_PRESETS[0];
  const isDarkBg = id => ['ink', 'coal', 'navy', 'coffee'].includes(id);

  // ---------------- 工具 ----------------
  const h = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; n.append(kid.nodeType ? kid : document.createTextNode(kid)); }
    return n;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------- 主入口 ----------------
  // 当前打开的阅读器实例的关闭句柄（路由跳转时需要强制关闭遮罩）
  let liveClose = null;
  // 1.9.0：卡顿时连点不同版本，会叠出好几层阅读器，要按好几次返回才回到书库。
  // 这里用两个开关兜住：opening 挡住「还没打开完又点一次」，histPushed 让多层复用同一条历史记录。
  let opening = false;
  let histPushed = false;

  async function open(b, opts) {
    opts = opts || {};
    if (opening) return;   // 正在打开过程中又点了一次（卡顿时的连点）：忽略，等第一次打开完成
    if (liveClose) {
      // 已经有阅读器开着：静默收掉旧实例，保证屏幕上永远只有一层
      try { liveClose(true); } catch (_) {}
      document.querySelectorAll('.reader').forEach(n => n.remove());
    }
    opening = true;
    // 兜底：万一中途抛错没走到结尾，8 秒后也要解锁，否则阅读器再也打不开
    setTimeout(() => { opening = false; }, 8000);
    let data;
    try {
      data = await api(`/books/${b.id}/read${tokenQ()}`);
    } catch (e) {
      opening = false;
      throw e;
    }
    // 每次打开都拉取站点配置，保证管理员刚切换的 TTS 开关立即生效
    try { state.site = await api('/site'); } catch (_) { state.site = state.site || {}; }
    const cfg = loadCfg();
    document.body.style.overflow = 'hidden';

    const root = h('div', { class: 'reader', 'data-theme': cfg.theme, 'data-texture': cfg.texture });
    const bar = h('div', { class: 'rd-bar' });
    const body = h('div', { class: 'rd-body' });
    const titleEl = h('div', { class: 'rd-title', title: data.title }, data.title);
    const posEl = h('span', { class: 'rd-pos' }, '');

    let closed = false;
    let anns = [];
    let curLoc = {};
    let pendingSel = null;
    let rendition = null, book = null;
    let pdfDoc = null, pdfPage = 1, pdfZoom = 0, pdfMode = 'single', pdfRendered = new Set();
    let mobiFrames = [], mobiSections = [], mobiLoaded = 0;
    let toc = Array.isArray(data.toc) ? data.toc.slice() : [];
    let txtView = null, txtParas = [], txtBase = 0, txtTotal = 0, txtGotoLine = null;
    // 1.9.3：页面级 __fnbBack 的备份，必须与 close() 同作用域（open() 里赋值、close() 里还原）
    let prevFnbBack = null;

    const prev = data.progress || {};
    pdfPage = prev.page || 1;
    if (prev.zoom) pdfZoom = prev.zoom;

    try { anns = (await api(`/books/${b.id}/annotations`)).annotations || []; } catch (_) { anns = []; }

    // ---------------- 主题 ----------------
    function applyTheme() {
      const p = presetOf(cfg.theme);
      root.dataset.theme = cfg.theme;
      root.dataset.texture = cfg.texture || 'none';
      root.style.setProperty('--rd-bg', p.bg);
      root.style.setProperty('--rd-fg', p.fg);
      root.style.setProperty('--rd-fs', cfg.fontSize + 'px');
      root.style.setProperty('--rd-lh', String(cfg.lineHeight));
      root.style.setProperty('--rd-font', (FONTS.find(f => f.id === cfg.font) || FONTS[0]).css);
      root.style.setProperty('--rd-para', cfg.paraSpace + 'em');
      // 1.9.0：PDF/扫描版的亮度与对比度（老扫描件的底色发灰、字发虚，调一下能舒服很多）
      root.style.setProperty('--rd-pdf-b', String(cfg.pdfBright ?? 1));
      root.style.setProperty('--rd-pdf-c', String(cfg.pdfContrast ?? 1));
      root.style.setProperty('--rd-surface', isDarkBg(cfg.theme) ? 'rgba(28,30,34,.96)' : 'rgba(255,255,255,.97)');
      root.style.setProperty('--rd-line', isDarkBg(cfg.theme) ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.1)');
      root.style.setProperty('--rd-muted', isDarkBg(cfg.theme) ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.5)');
      if (rendition) {
        try {
          rendition.themes.override('color', p.fg);
          rendition.themes.override('background', 'transparent');
          rendition.themes.fontSize(cfg.fontSize + 'px');
          rendition.themes.override('line-height', String(cfg.lineHeight));
          rendition.themes.font((FONTS.find(f => f.id === cfg.font) || FONTS[0]).css);
        } catch (_) {}
      }
      mobiFrames.forEach(decorateFrame);
      if (pdfDoc && pdfMode === 'scroll') relayoutPdf();
      if (pdfDoc && pdfMode === 'single') renderPdfPage().catch(() => {});
    }

    // ---------------- 进度 / 心跳 ----------------
    const saveProgress = p => {
      Object.assign(curLoc, p);
      api(`/progress/${b.id}`, { method: 'POST', body: JSON.stringify(p) }).catch(() => {});
    };
    api('/reading/heartbeat', { method: 'POST', body: JSON.stringify({ bookId: b.id, opened: true, seconds: 0 }) }).catch(() => {});
    let lastBeat = Date.now();
    const beatTimer = setInterval(() => {
      if (closed) return;
      const now = Date.now();
      const sec = Math.min(60, Math.round((now - lastBeat) / 1000));
      lastBeat = now;
      if (sec > 0) api('/reading/heartbeat', { method: 'POST', body: JSON.stringify({ bookId: b.id, seconds: sec }) }).catch(() => {});
    }, 15000);

    // ---------------- 工具栏 ----------------
    const tocBtn = h('button', { class: 'rd-ic', title: '目录 (T)' }, '☰');
    const aiBtn = h('button', { class: 'rd-ic', title: 'AI 助手' }, '✦');
    const setBtn = h('button', { class: 'rd-ic', title: '阅读设置' }, 'Aa');
    const bmBtn = h('button', { class: 'rd-ic', title: '添加书签 (B)' }, '🔖');
    const noteBtn = h('button', { class: 'rd-ic', title: '书签与笔记' }, '✎');
    const ttsBtn = h('button', { class: 'rd-ic', title: '朗读 (P)' }, '🔊');
    const fullBtn = h('button', { class: 'rd-ic', title: '单页全屏 (F)' }, '⤢');
    const exitBtn = h('button', { class: 'rd-ic', title: '退出 (Esc)' }, '✕');

    bar.append(tocBtn, titleEl, posEl, h('div', { class: 'rd-grow' }), aiBtn, setBtn, bmBtn, noteBtn, ttsBtn, fullBtn, exitBtn);

    // ---------------- 侧栏：目录 ----------------
    const tocPanel = h('aside', { class: 'rd-drawer rd-toc' });
    const tocList = h('div', { class: 'rd-drawer-body' });
    tocPanel.append(h('div', { class: 'rd-drawer-head' },
      h('span', {}, '目录'), h('span', { class: 'rd-toc-count' }, ''),
      h('button', { class: 'rd-x', onclick: () => toggleDrawer(tocPanel, false) }, '✕')), tocList);

    function renderToc() {
      tocList.innerHTML = '';
      const count = tocList.parentNode.querySelector('.rd-toc-count');
      if (count) count.textContent = toc.length ? String(toc.length) : '';
      if (!toc.length) {
        tocList.append(h('div', { class: 'rd-empty' },
          h('p', {}, '这本书还没有目录。'),
          h('button', { class: 'btn sm', onclick: async e => {
            e.target.disabled = true; e.target.textContent = '生成中…';
            try {
              const r = await api(`/books/${b.id}/toc`, { method: 'POST', body: '{}' });
              toc = r.toc || [];
              renderToc();
            } catch (err) { alert(err.message); }
            e.target.disabled = false; e.target.textContent = '为本书建立目录';
          } }, '为本书建立目录')));
        return;
      }
      toc.forEach((t, i) => {
        const item = h('div', { class: 'rd-toc-item lv' + (t.level || 1), onclick: () => { goToc(t); toggleDrawer(tocPanel, false); } },
          h('span', { class: 'rd-toc-label' }, t.label));
        tocList.append(item);
      });
    }

    function goToc(t) {
      if (rendition) {
        try {
          if (t.href) return rendition.display(t.href);
          if (t.cfi) return rendition.display(t.cfi);
          if (t.idx != null && book) {
            const spineItem = book.spine.get(t.idx);
            if (spineItem) return rendition.display(spineItem.href);
          }
        } catch (_) {}
      }
      if (pdfDoc && t.page) { pdfPage = t.page; if (pdfMode === 'scroll') scrollToPdfPage(t.page); else renderPdfPage(); return; }
      if (txtView && t.line != null) {
        // 1.8.0：文本分块加载，目标段落可能还没渲染 → 交给 buildText 里的跳转函数
        if (txtGotoLine) txtGotoLine(t.line);
        else {
          const p = txtParas[t.line - txtBase];
          if (p) p.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
        return;
      }
    }

    // ---------------- 侧栏：笔记 ----------------
    const annPanel = h('aside', { class: 'rd-drawer rd-ann' });
    const annList = h('div', { class: 'rd-drawer-body' });
    const annCount = h('span', { class: 'rd-badge' }, '');
    function refreshAnnBadge() {
      annCount.textContent = anns.length ? String(anns.length) : '';
      noteBtn.textContent = anns.length ? '✎' + anns.length : '✎';
    }
    function renderAnnList() {
      annList.innerHTML = '';
      if (!anns.length) {
        annList.append(h('div', { class: 'rd-empty' }, h('p', {}, '还没有书签和笔记。'), h('p', { class: 'sm' }, '选中正文可高亮或记笔记。')));
        return;
      }
      const group = { bookmark: '书签', highlight: '高亮', note: '笔记' };
      for (const type of ['bookmark', 'highlight', 'note']) {
        const list = anns.filter(a => a.type === type).sort((x, y) => y.createdAt - x.createdAt);
        if (!list.length) continue;
        annList.append(h('div', { class: 'rd-ann-group' }, group[type] + ' · ' + list.length));
        for (const a of list) {
          const del = h('button', { class: 'rd-ann-del', title: '删除', onclick: async e => {
            e.stopPropagation();
            try {
              await api(`/books/${b.id}/annotations/${a.id}`, { method: 'DELETE' });
              anns = anns.filter(x => x.id !== a.id);
              if (rendition && a.cfi) { try { rendition.annotations.remove(a.cfi, 'highlight'); } catch (_) {} }
              renderAnnList(); refreshAnnBadge();
            } catch (err) { alert(err.message); }
          } }, '✕');
          const item = h('div', { class: 'rd-ann-item', onclick: () => jumpTo(a) },
            h('div', { class: 'rd-ann-meta' }, a.page ? `第 ${a.page} 页` : (a.percent != null ? Math.round(a.percent * 100) + '%' : (a.pos != null ? '位置记录' : ''))),
            a.quote ? h('div', { class: 'rd-ann-quote' }, a.quote) : null,
            a.note ? h('div', { class: 'rd-ann-note' }, a.note) : null, del);
          annList.append(item);
        }
      }
    }
    function jumpTo(a) {
      if (rendition && a.cfi) { rendition.display(a.cfi); return; }
      if (pdfDoc && a.page) { pdfPage = a.page; if (pdfMode === 'scroll') scrollToPdfPage(a.page); else renderPdfPage(); return; }
      if (a.pos != null) body.scrollTop = a.pos;
    }
    const exportBtn = h('button', { class: 'btn sm ghost' }, '导出笔记');
    exportBtn.addEventListener('click', exportNotes);
    annPanel.append(h('div', { class: 'rd-drawer-head' },
      h('span', {}, '书签与笔记'), annCount,
      h('div', { class: 'rd-grow' }), exportBtn,
      h('button', { class: 'rd-x', onclick: () => toggleDrawer(annPanel, false) }, '✕')), annList);

    function exportNotes() {
      if (!anns.length) return alert('还没有书签或笔记');
      const lines = [`# 《${data.title}》 阅读笔记`, '', `- 作者：${b.author || '未知'}`, `- 导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
      const names = { bookmark: '## 书签', highlight: '## 高亮', note: '## 笔记' };
      for (const type of ['bookmark', 'highlight', 'note']) {
        const list = anns.filter(a => a.type === type);
        if (!list.length) continue;
        lines.push(names[type], '');
        for (const a of list.sort((x, y) => x.createdAt - y.createdAt)) {
          lines.push(`- ${new Date(a.createdAt).toLocaleDateString('zh-CN')}${a.page ? `（第 ${a.page} 页）` : ''}`);
          if (a.quote) lines.push(`  > ${a.quote.replace(/\n/g, ' ')}`);
          if (a.note) lines.push(`  ${a.note.replace(/\n/g, ' ')}`);
          lines.push('');
        }
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${data.title}-笔记.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    }

    // ---------------- 设置面板（字号 / 字体和间距 / 背景 + 底纹） ----------------
    const sheet = h('div', { class: 'rd-sheet' });
    const fsVal = h('span', { class: 'rd-fs-val' }, String(cfg.fontSize));
    const bgRow = h('div', { class: 'rd-bg-row' });
    const txRow = h('div', { class: 'rd-tx-row' });

    function renderBg() {
      bgRow.innerHTML = '';
      for (const p of BG_PRESETS) {
        bgRow.append(h('button', {
          class: 'rd-bg' + (cfg.theme === p.id ? ' on' : ''), title: p.name,
          style: `background:${p.bg};color:${p.fg}`,
          onclick: () => { cfg.theme = p.id; saveCfg(cfg); applyTheme(); renderBg(); }
        }, h('span', {}, p.fg === '#1f2328' ? '' : '')));
      }
      txRow.innerHTML = '';
      for (const t of TEXTURES) {
        txRow.append(h('button', {
          class: 'rd-tx' + (cfg.texture === t.id ? ' on' : ''), onclick: () => {
            cfg.texture = t.id; saveCfg(cfg); applyTheme(); renderBg();
          }
        }, t.name));
      }
    }

    sheet.append(
      h('div', { class: 'rd-sheet-head' },
        h('span', {}, '阅读设置'),
        h('div', { class: 'rd-grow' }),
        h('button', { class: 'rd-x', onclick: () => toggleSheet(false) }, '✕')),
      h('div', { class: 'rd-sheet-body' },
        h('div', { class: 'rd-sec' },
          h('div', { class: 'rd-sec-t' }, '字号'),
          h('div', { class: 'rd-fs-row' },
            h('button', { class: 'rd-fs-btn', onclick: () => bumpFont(-1) }, '−'),
            fsVal,
            h('button', { class: 'rd-fs-btn', onclick: () => bumpFont(1) }, '＋'),
            h('button', { class: 'rd-more-btn', onclick: () => toggleAdv(true) }, '字体和间距'))),
        h('div', { class: 'rd-sec' },
          h('div', { class: 'rd-sec-t' }, '背景'),
          bgRow,
          h('div', { class: 'rd-sec-sub' }, '底纹'), txRow),
        // 1.9.0：PDF / 扫描版的亮度、对比度（只作用于页面图像，不影响界面）
        h('div', { class: 'rd-sec' },
          h('div', { class: 'rd-sec-t' }, 'PDF 亮度 / 对比度'),
          h('div', { class: 'rd-tone-row' },
            h('span', { class: 'rd-tone-l' }, '亮度'),
            h('input', {
              type: 'range', min: '0.5', max: '1.8', step: '0.02', class: 'rd-range',
              value: String(cfg.pdfBright ?? 1),
              oninput: e => {
                cfg.pdfBright = +e.target.value; saveCfg(cfg);
                root.style.setProperty('--rd-pdf-b', String(cfg.pdfBright));
                e.target.nextSibling.textContent = Math.round(cfg.pdfBright * 100) + '%';
              }
            }),
            h('span', { class: 'rd-range-v' }, Math.round((cfg.pdfBright ?? 1) * 100) + '%')),
          h('div', { class: 'rd-tone-row' },
            h('span', { class: 'rd-tone-l' }, '对比度'),
            h('input', {
              type: 'range', min: '0.6', max: '2.2', step: '0.02', class: 'rd-range',
              value: String(cfg.pdfContrast ?? 1),
              oninput: e => {
                cfg.pdfContrast = +e.target.value; saveCfg(cfg);
                root.style.setProperty('--rd-pdf-c', String(cfg.pdfContrast));
                e.target.nextSibling.textContent = Math.round(cfg.pdfContrast * 100) + '%';
              }
            }),
            h('span', { class: 'rd-range-v' }, Math.round((cfg.pdfContrast ?? 1) * 100) + '%')),
          h('button', {
            class: 'rd-more-btn',
            onclick: () => {
              cfg.pdfBright = 1; cfg.pdfContrast = 1; saveCfg(cfg);
              root.style.setProperty('--rd-pdf-b', '1');
              root.style.setProperty('--rd-pdf-c', '1');
              notify('已恢复默认');
            }
          }, '恢复默认'))),
      h('div', { class: 'rd-adv' },
        h('div', { class: 'rd-adv-head' }, h('span', {}, '字体与间距'), h('button', { class: 'rd-x', onclick: () => toggleAdv(false) }, '✕')),
        h('div', { class: 'rd-sec' }, h('div', { class: 'rd-sec-t' }, '字体'),
          (() => {
            const wrap = h('div', { class: 'rd-font-row' });
            for (const f of FONTS) {
              wrap.append(h('button', {
                class: 'rd-font' + (cfg.font === f.id ? ' on' : ''), style: 'font-family:' + f.css,
                onclick: () => { cfg.font = f.id; saveCfg(cfg); applyTheme(); wrap.querySelectorAll('.rd-font').forEach(x => x.classList.remove('on')); wrap.children[FONTS.indexOf(f)].classList.add('on'); }
              }, f.name));
            }
            return wrap;
          })()),
        h('div', { class: 'rd-sec' }, h('div', { class: 'rd-sec-t' }, '行距'),
          h('input', { type: 'range', min: '1.2', max: '2.6', step: '0.05', value: String(cfg.lineHeight), class: 'rd-range', oninput: e => { cfg.lineHeight = +e.target.value; saveCfg(cfg); applyTheme(); e.target.nextSibling.textContent = cfg.lineHeight.toFixed(2); } }),
          h('span', { class: 'rd-range-v' }, cfg.lineHeight.toFixed(2))),
        h('div', { class: 'rd-sec' }, h('div', { class: 'rd-sec-t' }, '段间距'),
          h('input', { type: 'range', min: '0', max: '1.5', step: '0.1', value: String(cfg.paraSpace), class: 'rd-range', oninput: e => { cfg.paraSpace = +e.target.value; saveCfg(cfg); applyTheme(); } }))
      )
    );

    function bumpFont(d) {
      cfg.fontSize = clamp(cfg.fontSize + d, 12, 42);
      fsVal.textContent = String(cfg.fontSize);
      saveCfg(cfg); applyTheme();
      if (pdfDoc) { pdfZoom = 0; renderPdfPage().catch(() => {}); }
    }
    function toggleSheet(show) {
      sheet.classList.toggle('open', show === undefined ? !sheet.classList.contains('open') : show);
      if (sheet.classList.contains('open')) toggleDrawer(null);
    }
    function toggleAdv(show) { sheet.classList.toggle('rd-adv-open', show); }

    // ---------------- 抽屉 ----------------
    function toggleDrawer(panel, show) {
      for (const p of [tocPanel, annPanel, aiPanel]) {
        if (!p) continue;
        const on = p === panel && (show === undefined ? !p.classList.contains('open') : show);
        p.classList.toggle('open', on);
      }
      body.classList.toggle('drawer-open', !!document.querySelector('.rd-drawer.open'));
      setTimeout(() => { if (pdfDoc) { relayoutPdf(); } if (rendition) { try { rendition.resize(); } catch (_) {} } }, 260);
    }

    // ---------------- AI 面板 ----------------
    const aiPanel = h('aside', { class: 'rd-drawer rd-ai' });
    const aiLog = h('div', { class: 'rd-ai-log' });
    const aiInput = h('textarea', { class: 'rd-ai-input', rows: '2', placeholder: '就这本书提问，例如：这一章想表达什么？' });
    const aiQuota = h('span', { class: 'rd-ai-quota' }, '');
    const aiSend = h('button', { class: 'btn sm' }, '发送');
    let aiHistory = [];
    let aiEnabled = false;

    aiPanel.append(
      h('div', { class: 'rd-drawer-head' },
        h('span', {}, '✦ 阅读助手'), aiQuota,
        h('div', { class: 'rd-grow' }),
        h('button', { class: 'rd-x', onclick: () => toggleDrawer(aiPanel, false) }, '✕')),
      h('div', { style: 'font-size:11px;color:#94a3b8;padding:6px 12px;border-bottom:1px solid rgba(148,163,184,.2)' },
        '仅发送当前页附近的文字片段（≤1200 字），不会上传整本书内容'),
      aiLog,
      h('div', { class: 'rd-ai-foot' },
        h('div', { class: 'rd-ai-tips' },
          h('button', { class: 'rd-chip', onclick: () => askAi('用三句话概括这一页/这一章的内容') }, '概括本页'),
          h('button', { class: 'rd-chip', onclick: () => askAi('这一页里有哪些关键概念？简单解释一下') }, '解释概念'),
          h('button', { class: 'rd-chip', onclick: () => translatePage() }, '翻译本页')),
        aiInput, aiSend)
    );
    aiSend.addEventListener('click', () => askAi(aiInput.value));
    aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askAi(aiInput.value); });

    function aiSay(role, text, extra) {
      const row = h('div', { class: 'rd-ai-msg ' + role },
        h('div', { class: 'rd-ai-who' }, role === 'user' ? '我' : (role === 'ai' ? '助手' : '提示')),
        h('div', { class: 'rd-ai-text' }, text));
      if (extra) row.append(h('div', { class: 'rd-ai-extra' }, extra));
      aiLog.append(row);
      aiLog.scrollTop = aiLog.scrollHeight;
      return row;
    }

    const AI_CTX_LIMIT = 1200; // 只发送当前页片段，绝不上传整本书
    const clipCtx = t => String(t || '').replace(/[ \t]+/g, ' ').slice(0, AI_CTX_LIMIT);
    async function aiContext() {
      // 取当前阅读位置附近的文字（严格截断，服务端还有 1500 字硬上限）
      try {
        if (rendition) {
          const c = rendition.getContents()[0];
          const t = c && c.content && c.content.body ? c.content.body.innerText : '';
          return clipCtx(t);
        }
        if (pdfDoc) {
          const start = Math.max(1, pdfPage);
          const parts = [];
          for (let p = start; p < start + 2 && p <= pdfDoc.numPages; p++) {
            const pg = await pdfDoc.getPage(p);
            const tc = await pg.getTextContent();
            parts.push(tc.items.map(i => i.str).join(' '));
          }
          return clipCtx(parts.join('\n'));
        }
        if (txtView) {
          const all = txtParas.map(p => p.textContent);
          const idx = Math.max(0, txtParas.findIndex(p => p.getBoundingClientRect().top > 0));
          return clipCtx(all.slice(Math.max(0, idx - 2), idx + 12).join('\n'));
        }
        if (mobiFrames.length) {
          const f = mobiFrames[Math.min(mobiFrames.length - 1, 0)];
          try { return clipCtx(f.contentDocument.body.innerText); } catch (_) {}
        }
      } catch (_) {}
      return '';
    }

    async function askAi(q) {
      q = String(q || '').trim();
      if (!q) return;
      if (!aiEnabled) { aiSay('sys', '管理员尚未开启 AI 阅读助手。可在「管理后台 → AI 设置」中配置接口后使用。'); return; }
      aiSay('user', q);
      aiInput.value = '';
      const thinking = aiSay('ai', '思考中…');
      thinking.classList.add('thinking');
      try {
        const ctx = await aiContext();
        const r = await api('/ai/ask', {
          method: 'POST',
          body: JSON.stringify({ bookId: b.id, question: q, context: ctx, history: aiHistory.slice(-4) })
        });
        thinking.remove();
        if (r.refused) {
          aiSay('sys', r.answer);
        } else {
          aiSay('ai', r.answer);
          aiHistory.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
          if (r.quota) aiQuota.textContent = `今日 ${r.quota.left}/${r.quota.limit}`;
        }
      } catch (e) {
        thinking.remove();
        aiSay('sys', e.message);
      }
    }

    async function translatePage() {
      if (!aiEnabled) { aiSay('sys', '管理员尚未开启 AI 功能。'); return; }
      const ctx = await aiContext();
      if (!ctx) return aiSay('sys', '当前页面没有可提取的文字（可能是扫描件或图片）。');
      const row = aiSay('user', '翻译本页');
      const thinking = aiSay('ai', '翻译中…');
      try {
        const r = await api('/ai/translate', { method: 'POST', body: JSON.stringify({ text: ctx.slice(0, 1500), target: 'zh' }) });
        thinking.remove();
        aiSay('ai', r.text);
        if (r.quota) aiQuota.textContent = `今日 ${r.quota.left}/${r.quota.limit}`;
      } catch (e) { thinking.remove(); aiSay('sys', e.message); }
    }

    // ---------------- 轻提示 ----------------
    function rdToast(msg) {
      const t = h('div', { class: 'rd-toast' }, msg);
      root.append(t);
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 1900);
    }

    /**
     * 禁止打开书籍内部指向外部网站的链接（1.5.0）
     * 只放行书内相对跳转（如 chapter3.xhtml#sec2）与页内锚点；http/https、mailto、tel、
     * javascript: 等一律拦截，避免读者在阅读器里被带到站外页面。
     */
    function guardExternalLinks(doc) {
      if (!doc || doc.__fbLinkGuard) return;
      doc.__fbLinkGuard = true;
      const block = e => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        const href = String(a.getAttribute('href') || '').trim();
        if (!href || href.startsWith('#')) return;
        const external = /^(?:https?:)?\/\//i.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href);
        if (!external) return;   // 书内相对链接交给 epub.js 自己处理
        e.preventDefault();
        e.stopPropagation();
        rdToast('已禁止打开外部链接');
      };
      doc.addEventListener('click', block, true);
      doc.addEventListener('auxclick', block, true);
    }

    // ---------------- 选区工具条 ----------------
    const selBar = h('div', { class: 'rd-sel' });
    selBar.style.display = 'none';
    const selTextEl = h('span', { class: 'rd-sel-text' }, '');
    let selTranslating = false;
    function showSel(text, extra) {
      pendingSel = Object.assign({ text }, extra || {});
      selTextEl.textContent = '“' + text.slice(0, 28) + (text.length > 28 ? '…' : '') + '”';
      selBar.style.display = '';
      clearTimeout(showSel._t);
      showSel._t = setTimeout(() => { selBar.style.display = 'none'; }, 9000);
    }
    const doHighlight = async () => {
      if (!pendingSel) return;
      try {
        const r = await api(`/books/${b.id}/annotations`, {
          method: 'POST',
          body: JSON.stringify({ type: 'highlight', cfi: pendingSel.cfi, page: pendingSel.page, pos: pendingSel.pos, quote: pendingSel.text, color: '#fde68a' })
        });
        anns.push(r.annotation); refreshAnnBadge(); renderAnnList();
        if (rendition && pendingSel.cfi) applyEpubHighlight(r.annotation);
      } catch (e) { alert(e.message); }
      pendingSel = null; selBar.style.display = 'none';
    };
    const doNote = async () => {
      if (!pendingSel) return;
      const note = prompt('写下你的想法：', '');
      if (note === null) return;
      try {
        const r = await api(`/books/${b.id}/annotations`, {
          method: 'POST',
          body: JSON.stringify({ type: note.trim() ? 'note' : 'highlight', cfi: pendingSel.cfi, page: pendingSel.page, pos: pendingSel.pos, quote: pendingSel.text, note: note.trim(), color: '#fde68a' })
        });
        anns.push(r.annotation); refreshAnnBadge(); renderAnnList();
        if (rendition && pendingSel.cfi) applyEpubHighlight(r.annotation);
      } catch (e) { alert(e.message); }
      pendingSel = null; selBar.style.display = 'none';
    };
    const doTranslateSel = async () => {
      if (!pendingSel || selTranslating) return;
      if (!aiEnabled) return alert('管理员尚未开启 AI 功能');
      selTranslating = true;
      const text = pendingSel.text;
      toggleDrawer(aiPanel, true);
      aiSay('user', '翻译：' + text.slice(0, 40));
      const thinking = aiSay('ai', '翻译中…');
      try {
        const r = await api('/ai/translate', { method: 'POST', body: JSON.stringify({ text: text.slice(0, 1500), target: 'zh' }) });
        thinking.remove();
        aiSay('ai', r.text);
      } catch (e) { thinking.remove(); aiSay('sys', e.message); }
      selTranslating = false;
      selBar.style.display = 'none';
    };
    selBar.append(selTextEl,
      h('button', { class: 'rd-sel-btn', onclick: doHighlight }, '高亮'),
      h('button', { class: 'rd-sel-btn', onclick: doNote }, '笔记'),
      h('button', { class: 'rd-sel-btn', onclick: doTranslateSel }, '翻译'),
      h('button', { class: 'rd-sel-btn', onclick: () => { const t = pendingSel && pendingSel.text; selBar.style.display = 'none'; if (t) { toggleDrawer(aiPanel, true); askAi('请解释这段话的意思：「' + t.slice(0, 120) + '」'); } } }, 'AI 解释'));

    function applyEpubHighlight(a) {
      try { rendition.annotations.highlight(a.cfi, { id: a.id }, null, 'user-hl', { fill: a.color || '#fde68a', 'fill-opacity': '0.45' }); } catch (_) {}
    }

    // ---------------- TTS ----------------
    const ttsBar = h('div', { class: 'rd-tts' });
    ttsBar.style.display = 'none';
    const ttsState = {
      active: false, paused: false, chunks: [], idx: 0, audio: null, watchdog: null,
      engine: 'browser', voice: '', voiceName: '', rate: cfg.rate || 1
    };
    const ttsPlay = h('button', { class: 'tts-btn', title: '播放/暂停' }, '⏸');
    const ttsInfo = h('span', { class: 'tts-info' }, '');
    const ttsRateBtn = h('button', { class: 'tts-chip' }, (ttsState.rate).toFixed(1) + '×');
    const ttsModelBtn = h('button', { class: 'tts-chip' }, '本地语音');
    const ttsPrev = h('button', { class: 'tts-btn sm', title: '上一段' }, '⏮');
    const ttsNext = h('button', { class: 'tts-btn sm', title: '下一段' }, '⏭');
    const ttsClose = h('button', { class: 'tts-btn sm', title: '停止' }, '✕');

    ttsBar.append(h('span', { class: 'tts-dot' }), ttsInfo, ttsPrev, ttsPlay, ttsNext, ttsRateBtn, ttsModelBtn, ttsClose);

    async function ttsInit() {
      const en = await api('/tts/config').catch(() => null);
      if (!en) return;
      ttsState.engine = en.engine;
      const map = { browser: '本地语音', openai: '在线语音', azure: 'Azure 语音' };
      ttsModelBtn.textContent = map[en.engine] || en.engine;
      ttsState.voice = (en.models && en.models[0]) || '';
      ttsModelBtn.title = '当前语音引擎：' + en.engine;
    }
    ttsModelBtn.addEventListener('click', async () => {
      const cfgSrv = await api('/tts/config').catch(() => null);
      if (!cfgSrv) { alert('无法获取语音配置'); return; }
      openTtsMenu(cfgSrv);
    });

    // 语音引擎/音色弹出菜单（替代浏览器原生 prompt）
    function openTtsMenu(cfgSrv) {
      const old = document.querySelector('.tts-menu');
      if (old) old.remove();
      const menu = h('div', { class: 'tts-menu' });
      const title = h('div', { class: 'tts-menu-t' }, '语音引擎');
      menu.append(title);
      for (const e of cfgSrv.engines) {
        const row = h('button', { class: 'tts-menu-i' + (e.id === ttsState.engine ? ' on' : '') },
          h('span', { class: 'tts-menu-n' }, e.name),
          e.ready === false ? h('span', { class: 'tts-menu-b' }, '未配置') : null);
        row.addEventListener('click', () => {
          ttsState.engine = e.id;
          ttsModelBtn.textContent = e.name;
          menu.querySelectorAll('.tts-menu-i').forEach(x => x.classList.remove('on'));
          row.classList.add('on');
          if (ttsState.active) { stopTts(); startTts(); }
        });
        menu.append(row);
      }
      if (ttsState.engine === 'browser' && 'speechSynthesis' in window) {
        const voices = (window.speechSynthesis.getVoices() || []).filter(v => /^zh/i.test(v.lang));
        if (voices.length > 1) {
          menu.append(h('div', { class: 'tts-menu-t' }, '系统音色'));
          for (const v of voices.slice(0, 8)) {
            const row = h('button', { class: 'tts-menu-i' + (ttsState.voiceName === v.name ? ' on' : '') }, v.name);
            row.addEventListener('click', () => {
              ttsState.voiceName = v.name;
              menu.querySelectorAll('.tts-menu-i').forEach(x => x.classList.remove('on'));
              row.classList.add('on');
              if (ttsState.active) { stopTts(); startTts(); }
            });
            menu.append(row);
          }
        }
      }
      const close = h('button', { class: 'tts-menu-x' }, '完成');
      close.addEventListener('click', () => menu.remove());
      menu.append(close);
      document.body.append(menu);
      setTimeout(() => document.addEventListener('click', function off(ev) {
        if (!menu.contains(ev.target) && ev.target !== ttsModelBtn) { menu.remove(); document.removeEventListener('click', off); }
      }), 0);
    }

    ttsRateBtn.addEventListener('click', () => {
      const opts = [0.75, 1, 1.25, 1.5, 1.75, 2];
      const i = opts.indexOf(ttsState.rate);
      ttsState.rate = opts[(i + 1) % opts.length];
      ttsRateBtn.textContent = ttsState.rate.toFixed(2).replace(/0$/, '') + '×';
      if (ttsState.engine === 'browser' && window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); speakCurrent(); }
    });
    ttsPlay.addEventListener('click', () => {
      if (!ttsState.active) { startTts(); return; }
      if (ttsState.engine === 'browser') {
        if (ttsState.paused) { window.speechSynthesis.resume(); ttsState.paused = false; ttsPlay.textContent = '⏸'; }
        else { window.speechSynthesis.pause(); ttsState.paused = true; ttsPlay.textContent = '▶'; }
      } else if (ttsState.audio) {
        if (ttsState.audio.paused) { ttsState.audio.play(); ttsPlay.textContent = '⏸'; }
        else { ttsState.audio.pause(); ttsPlay.textContent = '▶'; }
      }
    });
    ttsNext.addEventListener('click', () => { ttsState.idx++; playChunk(); });
    ttsPrev.addEventListener('click', () => { ttsState.idx = Math.max(0, ttsState.idx - 1); playChunk(); });
    ttsClose.addEventListener('click', () => stopTts());

    function ttsChunksFromText(text) {
      const raw = String(text || '').replace(/\r/g, '').split(/\n+/).map(s => s.trim()).filter(Boolean);
      const out = [];
      for (const para of raw) {
        if (para.length <= 110) { out.push(para); continue; }
        const parts = para.split(/(?<=[。！？!?；;…])/);
        let buf = '';
        for (const p of parts) {
          if ((buf + p).length > 110 && buf) { out.push(buf); buf = p; }
          else buf += p;
        }
        if (buf) out.push(buf);
      }
      return out;
    }

    /**
     * 1.9.2：判断一段取到的文字是不是「真正文」。
     * PDF 扫描件的页面上只有图片，但阅读器的翻页按钮、页码、提示语也是文字，
     * 直接整块取进来就会出现「能朗读，但读的是 ◀ ▶ 6/120」这种怪事。
     */
    function meaningfulText(s) {
      let t = String(s || '').replace(/[\s\u3000]+/g, '');
      if (!t) return '';
      // 纯符号 / 页码 / 图标
      if (!/[\u4e00-\u9fa5A-Za-z\u3040-\u30ff\uac00-\ud7af]{2,}/.test(t)) return '';
      // 形如 6/120、第 6 页、- 6 -
      if (/^(第)?\d+(\/\d+)?(页)?$/.test(t)) return '';
      // 去掉只有一两个汉字的碎块（多为 UI 标签）
      if (t.length < 8) return '';
      return String(s).trim();
    }

    // 按当前视图收集正文；返回值带 kind，供 startTts 给出针对性提示
    async function currentPageText() {
      const parts = [];
      const add = t => { const v = meaningfulText(t); if (v) parts.push(v); };
      let kind = '';
      try {
        if (rendition) {
          kind = 'epub';
          const c = rendition.getContents()[0];
          add(c && c.content && c.content.body ? c.content.body.innerText : '');
        } else if (pdfDoc) {
          kind = 'pdf';
          const pg = await pdfDoc.getPage(pdfPage);
          const tc = await pg.getTextContent();
          // 只拼有内容的字符串项；图片页 items 为空 → parts 仍为空 → 走「无文本层」提示
          const pageText = (tc.items || []).map(i => (i.str || '') + (i.hasEOL ? '\n' : '')).join('');
          add(pageText);
        } else if (txtView) {
          kind = 'txt';
          // 分块阅读时 txtView 里只有当前一屏附近的段落，先取全部已加载段落
          if (txtParas && txtParas.length) add(txtParas.map(n => n.innerText).join('\n'));
          else add(txtView.innerText);
        } else if (mobiFrames.length) {
          kind = 'mobi';
          const f = mobiFrames[mobiLoaded - 1] || mobiFrames[0];
          try { add(f.contentDocument.body.innerText); } catch (_) {}
        } else if (slideCards.length) {
          kind = 'ppt';
          // PPT：一页里可能多个文本框，逐个取
          const card = slideCards[Math.min(slideIdx, slideCards.length - 1)];
          if (card) add(card.innerText || card.textContent || '');
        }
        // 兜底：正文容器整体取一次（覆盖 cbz 文字页、docx 片段等）
        if (!parts.length && !kind && body) { kind = 'other'; add(body.innerText); }
      } catch (_) {}
      currentPageText.kind = kind;
      return parts.join('\n');
    }

    async function startTts() {
      const text = await currentPageText();
      const kind = currentPageText.kind || '';
      const chunks = ttsChunksFromText(text);
      if (!chunks.length) {
        // 1.9.2：把「为什么没有文字」说清楚——扫描版 PDF / 图片页根本没有文本层，
        // 光说「当前页面没有可朗读的文字」用户会以为是功能坏了。
        let why = '当前页面没有可朗读的文字';
        if (kind === 'pdf') {
          why = '这一页没有文本层（多半是扫描件或图片页），无法朗读。\n可以翻到有文字的页面试试，或用支持 OCR 的版本。';
        } else if (kind === 'ppt') {
          why = '这一页幻灯片里只有图片或图形，没有可朗读的文字。';
        } else if (kind === 'epub') {
          why = '这一页没有可朗读的文字（可能是纯图片排版）。';
        }
        return alert(why);
      }
      ttsState.chunks = chunks;
      ttsState.idx = 0;
      ttsState.active = true;
      ttsState.paused = false;
      ttsBar.style.display = '';
      ttsPlay.textContent = '⏸';
      ttsBtn.classList.add('on');
      playChunk();
    }

    async function playChunk() {
      if (!ttsState.active) return;
      const chunk = ttsState.chunks[ttsState.idx];
      if (chunk == null) return stopTts();
      ttsInfo.textContent = `${ttsState.idx + 1}/${ttsState.chunks.length}`;
      ttsInfo.title = chunk;
      if (ttsState.engine === 'browser') {
        if (!('speechSynthesis' in window)) { alert('浏览器不支持本地语音合成'); return stopTts(); }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(chunk);
        u.lang = 'zh-CN';
        u.rate = ttsState.rate;
        const voices = window.speechSynthesis.getVoices();
        const v = (ttsState.voiceName && voices.find(x => x.name === ttsState.voiceName)) || voices.find(x => /zh[-_]CN/i.test(x.lang) && x.localService) || voices.find(x => /^zh/i.test(x.lang));
        if (v) u.voice = v;
        u.onend = () => { if (!ttsState.active || ttsState.paused) return; ttsState.idx++; playChunk(); };
        u.onerror = () => { if (ttsState.active) { ttsState.idx++; playChunk(); } };
        window.speechSynthesis.speak(u);
      } else {
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
            body: JSON.stringify({ text: chunk, rate: ttsState.rate, engine: ttsState.engine })
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '语音合成失败');
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          if (ttsState.audio) { ttsState.audio.pause(); URL.revokeObjectURL(ttsState.audio.src); }
          const audio = new Audio(url);
          ttsState.audio = audio;
          audio.onended = () => { if (ttsState.active) { ttsState.idx++; playChunk(); } };
          await audio.play();
        } catch (e) { alert(e.message); stopTts(); }
      }
    }

    function stopTts() {
      ttsState.active = false;
      try { window.speechSynthesis.cancel(); } catch (_) {}
      if (ttsState.audio) { try { ttsState.audio.pause(); } catch (_) {} }
      ttsBar.style.display = 'none';
      ttsBtn.classList.remove('on');
    }

    // ---------------- 通用操作 ----------------
    async function addBookmark() {
      try {
        const r = await api(`/books/${b.id}/annotations`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'bookmark', cfi: curLoc.cfi, page: pdfDoc ? pdfPage : curLoc.page,
            pos: Math.round(body.scrollTop), quote: (curLoc.percent != null ? Math.round(curLoc.percent * 100) + '%' : '')
          })
        });
        anns.push(r.annotation); refreshAnnBadge(); renderAnnList();
        bmBtn.textContent = '✓';
        setTimeout(() => { bmBtn.textContent = '🔖'; }, 1200);
      } catch (e) { alert(e.message); }
    }

    function toggleFullscreen() {
      root.classList.toggle('immersive');
      if (!root.classList.contains('immersive')) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } else {
        if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
      }
      setTimeout(() => { if (pdfDoc) relayoutPdf(); if (rendition) try { rendition.resize(); } catch (_) {} }, 300);
    }

    function close(fromHistory) {
      if (closed) return;
      closed = true;
      liveClose = null;
      clearInterval(beatTimer);
      const sec = Math.min(180, Math.round((Date.now() - lastBeat) / 1000));
      if (sec >= 3) {
        try {
          // 1.7.0：写操作不再把令牌拼进 URL，改用带 Authorization 的 keepalive 请求
          fetch('/api/reading/heartbeat', {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
            body: JSON.stringify({ bookId: b.id, seconds: sec })
          }).catch(() => {});
        } catch (_) {
          try {
            navigator.sendBeacon(`/api/reading/heartbeat?token=${encodeURIComponent(state.token)}`,
              new Blob([JSON.stringify({ bookId: b.id, seconds: sec })], { type: 'application/json' }));
          } catch (_) {}
        }
      }
      stopTts();
      // 1.9.3：destroy 系列各自 try 包住，但**绝不能因为某一项报错就跳过后面的移除**。
      // 之前的 ReferenceError 就发生在 root.remove() 之前，结果外框留在屏幕上、内容已被清空、页面卡死。
      try { if (rendition) rendition.destroy(); } catch (_) {}
      try { if (pdfDoc) pdfDoc.destroy(); } catch (_) {}
      try { if (book) book.destroy && book.destroy(); } catch (_) {}
      try { if (pptViewer) pptViewer.destroy(); } catch (_) {}
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (_) {}
      if (fitOnResize) {
        try {
          window.removeEventListener('resize', fitOnResize);
          window.removeEventListener('orientationchange', fitOnResize);
        } catch (_) {}
        fitOnResize = null;
      }
      try { window.removeEventListener('hashchange', onHashChange); } catch (_) {}
      try { window.removeEventListener('popstate', onPopState); } catch (_) {}
      // 1.9.2：阅读器关闭后要「还原」页面级的返回处理器，而不是留个 null——
      // 以前这里置 null，APP 返回键就退化成 web.goBack()，于是变成回「上一个页面」而不是「上一层」。
      try { if (prevFnbBack) window.__fnbBack = prevFnbBack; } catch (_) {}
      // ---- 以下三步是「一定要执行」的收尾：移除外框、清掉残留工具条、恢复页面滚动 ----
      try { root.remove(); } catch (_) {}
      root.style.display = 'none';   // 万一 remove 因宿主环境异常失败，至少别挡住下层页面
      try { document.querySelectorAll('.ppv-hud, .rd-pdfbar, .rd-tts').forEach(n => n.remove()); } catch (_) {}
      document.body.style.overflow = '';
      try { document.removeEventListener('keydown', onKey); } catch (_) {}
      try { window.removeEventListener('resize', onResize); } catch (_) {}
      // 主动关闭（不是按返回触发的）时，把刚才压的那条历史记录弹掉，
      // 否则遥控器再按返回会「原地不动」看着像失灵。
      // 注意：如果 hash 已经变了（用户是点了别处导航进来的），就不要再 back 了，否则会来回跳。
      if (pushed) {
        pushed = false;
        if (!fromHistory && location.hash === openHash) {
          histPushed = false;
          try { history.back(); } catch (_) {}
        }
      }
      opening = false;
    }
    liveClose = close;

    function onKey(e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = e.key;
      if (k === 'Escape') { close(); return; }
      if (k === 't' || k === 'T') return toggleDrawer(tocPanel);
      if (k === 'b' || k === 'B') return addBookmark();
      if (k === 'f' || k === 'F') return toggleFullscreen();
      if (k === 'p' || k === 'P') { if (!(state.site && state.site.tts && state.site.tts.enabled === false)) { if (ttsState.active) stopTts(); else startTts(); } return; }
      if (k === '+' || k === '=') { bumpFont(1); return; }
      if (k === '-') { bumpFont(-1); return; }
      // 1.9.0：TV 端方向键交给遥控器空间导航（用来在页码/缩放这些控件之间移动焦点），
      // 不再同时翻页——以前按一下方向键既挪高亮又翻一页，调页码时会连续跳好几页。
      // 例外：沉浸态下按「↑」先把顶栏叫出来，否则电视上找不到任何控件。
      if (window.__FNB_TV__ && k === 'ArrowUp' && root.classList.contains('immersive')) {
        root.classList.remove('immersive');
        return;
      }
      if (window.__FNB_TV__ && (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'ArrowUp' || k === 'ArrowDown')) return;
      if (k === 'ArrowRight' || k === 'PageDown') { nextPage(); return; }
      if (k === 'ArrowLeft' || k === 'PageUp') { prevPage(); return; }
    }
    function nextPage() {
      setImmersiveHint();
      if (rendition) return rendition.next();
      if (pdfDoc) { if (pdfMode === 'single' && pdfPage < pdfDoc.numPages) { pdfPage++; renderPdfPage(); } return; }
      body.scrollTop = body.scrollTop + body.clientHeight * 0.9;
    }
    function prevPage() {
      if (rendition) return rendition.prev();
      if (pdfDoc) { if (pdfMode === 'single' && pdfPage > 1) { pdfPage--; renderPdfPage(); } return; }
      body.scrollTop = body.scrollTop - body.clientHeight * 0.9;
    }
    function setImmersiveHint() { /* 预留：翻页时的沉浸提示 */ }

    let resizeT = null;
    function onResize() {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (closed) return;
        if (rendition) { try { rendition.resize(); } catch (_) {} }
        if (pdfDoc) relayoutPdf();
        mobiFrames.forEach(f => { try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 8) + 'px'; } catch (_) {} });
      }, 220);
    }
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);

    // ================= 1.8.4：视口自检 =================
    // 老 WebView（电视、旧盒子）不支持 position:fixed 的 inset 简写时，.reader 会退化成
    // 普通块级元素被排到页面底部：正文一片空白，只有内部的 fixed 页码条还飘在屏幕上。
    // 这里打开后立刻量一次尺寸，发现没铺满就强制用内联样式兜住。
    let fitOnResize = null;
    let fittedOnce = false;
    function ensureViewport() {
      const fit = () => {
        if (closed || !root.isConnected) return;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!vw || !vh) return;
        const r = root.getBoundingClientRect();
        // 已经铺满就什么都不做。注意：不能把之前写上的内联样式收回去，
        // 收回后在老 WebView 上会立刻再次塌掉，然后又被这里判成「坏了」，来回抖。
        const broken = r.width < vw * 0.9 || r.height < vh * 0.7 || r.top > 4 || r.left > 4;
        if (broken) {
          root.style.position = 'fixed';
          root.style.top = '0';
          root.style.left = '0';
          root.style.width = vw + 'px';
          root.style.height = vh + 'px';
          root.style.zIndex = '2147483000';
          root.style.display = 'flex';
          root.style.flexDirection = 'column';
          // 铺满之后要有一次 resize 通知：PDF/PPT 的缩放是挂载那一刻按容器宽度算的，
          // 那时容器还是 0 宽，不重算就会显示成很小一张。
          if (!fittedOnce) {
            fittedOnce = true;
            setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (_) {} }, 80);
          }
        }
        // 正文区再兜一层：父级有了确定高度后 flex:1 一般就够，这里只在它仍近于 0 时动
        if (body.getBoundingClientRect().height < 80) {
          body.style.height = Math.max(120, vh - (bar.offsetHeight || 46)) + 'px';
        }
      };
      fit();
      requestAnimationFrame(fit);
      setTimeout(fit, 60);
      setTimeout(fit, 320);
      setTimeout(fit, 1200);
      fitOnResize = fit;
      window.addEventListener('resize', fitOnResize);
      window.addEventListener('orientationchange', fitOnResize);
      // 供客户端返回键判断「网页里是否还有一层要关」
      // 1.9.2：记住页面级的返回处理器，关闭时还原（否则 APP 返回键会退化成浏览历史）
      // 1.9.3：这里必须写在外层变量上（见 prevFnbBack 声明处）。
      //   之前用 const 声明在 open() 内部，close() 访问到的是「未定义标识符」，
      //   直接抛 ReferenceError —— 又因为它在 root.remove() 之前，于是出现
      //   「外框还在、内容已被 destroy 清空、页面卡死」的经典 bug。
      prevFnbBack = window.__fnbBack;
      window.__fnbBack = () => {
        if (closed) return false;
        const m = document.querySelector('.modal-mask');
        if (m) return false; // 弹窗自己处理
        close();
        return true;
      };
    }

    // 地址栏/侧栏切换（返回上一层）时把阅读器一起收掉，避免它留在屏幕上不消失
    const openHash = location.hash;
    let pushed = false;
    function onHashChange() {
      if (!closed && location.hash !== openHash) { pushed = false; histPushed = false; close(true); }
    }
    window.addEventListener('hashchange', onHashChange);

    // 压一条同地址的历史记录：电视遥控器按「返回」时先关阅读器，而不是直接退掉详情页
    // 1.9.0：如果上一次的阅读器已经压过一条（例如从版本列表换了一本再打开），复用那一条，
    // 否则点几次就多几条历史，遥控器要按好几次返回才出得去。
    if (!histPushed) {
      try { history.pushState({ fnbReader: 1 }, '', location.href); histPushed = true; } catch (_) {}
    }
    pushed = true;
    function onPopState() {
      if (!closed) { pushed = false; histPushed = false; close(true); }
    }
    window.addEventListener('popstate', onPopState);

    // ================= 渲染各格式 =================
    root.append(bar, body, tocPanel, annPanel, aiPanel, sheet, selBar, ttsBar);
    document.body.append(root);
    opening = false;   // 已经挂上屏幕，后续允许换书再开（open 会先收掉这一层）
    // 1.9.0：TV 端打开就进沉浸全屏（电视上没人手动点全屏按钮），按「↑」可以叫出顶栏
    if (window.__FNB_TV__) {
      root.classList.add('immersive');
      try {
        if (!document.fullscreenElement && root.requestFullscreen) {
          const p = root.requestFullscreen();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (_) {}
    }
    ensureViewport();
    applyTheme();
    renderBg();
    renderToc();
    refreshAnnBadge();
    renderAnnList();
    // 管理员关闭 TTS 时不显示朗读入口
    const ttsOff = state.site && state.site.tts && state.site.tts.enabled === false;
    if (ttsOff) { ttsBtn.style.display = 'none'; }
    else ttsInit();
    api('/ai/config').then(c => {
      aiEnabled = !!c.enabled;
      aiQuota.textContent = c.quota ? `今日 ${c.quota.left}/${c.quota.limit}` : '';
      if (!aiEnabled) aiBtn.classList.add('off');
    }).catch(() => { aiBtn.classList.add('off'); });

    tocBtn.addEventListener('click', () => toggleDrawer(tocPanel));
    noteBtn.addEventListener('click', () => { renderAnnList(); toggleDrawer(annPanel); });
    aiBtn.addEventListener('click', () => {
      toggleDrawer(aiPanel);
      if (!aiLog.childElementCount) {
        aiSay('sys', aiEnabled
          ? '只就当前这本书回答：情节、概念、写作手法与段落翻译。无关问题或过于复杂的请求会被拒绝，且不消耗每日额度。'
          : '管理员尚未开启 AI 功能。开启后即可结合本书上下文答疑与翻译。');
      }
    });
    setBtn.addEventListener('click', () => toggleSheet());
    bmBtn.addEventListener('click', addBookmark);
    ttsBtn.addEventListener('click', () => { if (ttsState.active) stopTts(); else startTts(); });
    fullBtn.addEventListener('click', toggleFullscreen);
    exitBtn.addEventListener('click', close);

    body.addEventListener('click', e => {
      if (sheet.classList.contains('open') && !sheet.contains(e.target) && e.target !== setBtn) toggleSheet(false);
    });

    // ---------- EPUB ----------
    let currentCfi = prev.cfi || null;

    async function buildEpub() {
      const view = h('div', { id: 'epub-view', class: 'rd-content' });
      body.append(view);
      view.innerHTML = '';
      book = ePub(data.url, { openAs: 'epub' });
      rendition = book.renderTo(view, {
        width: '100%', height: '100%',
        flow: 'scrolled',
        manager: 'continuous',
        spread: 'none',
        allowScriptedContent: true
      });
      // 书内所有指向外部网站的链接一律拦截（只允许书内章节跳转）
      try { rendition.hooks.content.register(contents => guardExternalLinks(contents.document)); } catch (_) {}
      rendition.on('rendered', (section, vw) => { try { guardExternalLinks(vw && vw.document); } catch (_) {} });
      try {
        await rendition.display(currentCfi || undefined);
      } catch (e) {
        try { await rendition.display(); } catch (_) {
          view.append(h('div', { class: 'rd-empty' }, h('p', {}, 'EPUB 解析失败：' + (e.message || '文件结构异常'))));
        }
      }
      for (const a of anns) if (a.type !== 'bookmark' && a.cfi) applyEpubHighlight(a);

      rendition.on('relocated', loc => {
        if (!loc || !loc.start) return;
        const pct = Math.round((loc.start.percentage || 0) * 100);
        posEl.textContent = pct + '%';
        currentCfi = loc.start.cfi;
        saveProgress({ cfi: loc.start.cfi, pct });
        highlightToc(loc.start.href);
      });
      rendition.on('selected', (cfiRange, contents) => {
        let text = '';
        try { text = contents.window.getSelection().toString(); } catch (_) {}
        if (!text.trim()) return;
        showSel(text.trim().slice(0, 400), { cfi: cfiRange });
      });
      // 移动端滑动翻页
      attachSwipe(view);
    }

    function rebuildEpub() {
      const keep = currentCfi;
      try { rendition && rendition.destroy(); } catch (_) {}
      body.innerHTML = '';
      buildEpub().then(() => { if (keep) { try { rendition.display(keep); } catch (_) {} } });
    }

    function highlightToc(href) {
      if (!href) return;
      const clean = String(href).split('#')[0];
      const items = [...tocList.querySelectorAll('.rd-toc-item')];
      items.forEach(i => i.classList.remove('on'));
      const idx = toc.findIndex(t => t.href && String(t.href).split('#')[0] === clean);
      if (idx >= 0 && items[idx]) {
        items[idx].classList.add('on');
        const panel = tocList.parentElement;
        if (panel && panel.classList.contains('open')) items[idx].scrollIntoView({ block: 'center' });
      }
    }

    // ---------- PDF ----------
    const pdfWrap = h('div', { class: 'rd-pdf' });
    const pdfCtrl = h('div', { class: 'rd-pdfbar' });
    let pdfObserver = null;

    // 视图状态：pdfFit=按宽度/整页；pdfSpread=双页并排
    let pdfFit = 'width';
    let pdfSpread = false;

    function pdfMetrics() {
      const w = (body.clientWidth || 900) - 48;
      const hgt = (body.clientHeight || 700) - 28;
      const gap = pdfSpread ? 14 : 0;
      return { w: Math.max(160, (pdfSpread ? (w - gap) / 2 : w)), h: Math.max(160, hgt) };
    }

    function pdfScaleFor(page, zoom) {
      const vp1 = page.getViewport({ scale: 1 });
      const m = pdfMetrics();
      const fitW = m.w / vp1.width;
      const fitPage = Math.min(fitW, m.h / vp1.height);
      const base = pdfFit === 'page' ? fitPage : fitW;
      return zoom ? base * zoom : base;
    }

    /** 让 PDF 页面跟随阅读主题：灰度页把白底变透明（露出主题底色+底纹）、黑字变前景色；彩色页原样保留 */
    function recolorPdfCanvas(canvas) {
      if (!canvas || !canvas.width) return;
      let img;
      try {
        const c2 = canvas.getContext('2d', { willReadFrequently: true });
        img = c2.getImageData(0, 0, canvas.width, canvas.height);
        canvas.__ctx2 = c2;
      } catch (_) { return; }
      const d = img.data;
      // 采样：彩色像素比例高 = 插图/漫画页，保持原色
      const total = d.length / 4;
      const step = Math.max(1, Math.floor(total / 4000)) * 4;
      let colorful = 0, sampled = 0;
      for (let i = 0; i < d.length; i += step) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 26) colorful++;
        sampled++;
      }
      if (sampled && colorful / sampled > 0.02) { canvas.classList.add('pdf-colorful'); return; }
      const p = presetOf(cfg.theme);
      const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
      const bg = hex(p.bg), fg = hex(p.fg);
      // 灰度 → 颜色查表：v=0（黑字）→ 前景色；v=255（白纸）→ 透明（露出主题底色与底纹）
      const lut = new Uint8ClampedArray(256 * 4);
      for (let v = 0; v < 256; v++) {
        const t = v / 255;
        lut[v * 4] = Math.round(fg[0] + (bg[0] - fg[0]) * t);
        lut[v * 4 + 1] = Math.round(fg[1] + (bg[1] - fg[1]) * t);
        lut[v * 4 + 2] = Math.round(fg[2] + (bg[2] - fg[2]) * t);
        lut[v * 4 + 3] = v >= 250 ? Math.round((255 - v) / 5 * 255) : 255;
      }
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
        const o = v * 4;
        d[i] = lut[o]; d[i + 1] = lut[o + 1]; d[i + 2] = lut[o + 2];
        if (lut[o + 3] < d[i + 3]) d[i + 3] = lut[o + 3];
      }
      canvas.__ctx2.putImageData(img, 0, 0);
      canvas.classList.add('pdf-themed');
    }

    async function renderPdfPage() {
      if (!pdfDoc) return;
      pdfWrap.innerHTML = '';
      const ratio = window.devicePixelRatio > 1 ? Math.min(2.5, window.devicePixelRatio) : 1.4;
      const row = h('div', { class: 'rd-pdf-row' });
      pdfWrap.append(row);
      const nums = pdfSpread ? [pdfPage, pdfPage + 1] : [pdfPage];
      for (const n of nums) {
        if (n > pdfDoc.numPages) break;
        const pg = await pdfDoc.getPage(n);
        const scale = pdfScaleFor(pg, pdfZoom);
        const vp = pg.getViewport({ scale: scale * ratio });
        const canvas = h('canvas', { class: 'rd-page', 'data-page': n });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = Math.floor(vp.width / ratio) + 'px';
        canvas.style.height = Math.floor(vp.height / ratio) + 'px';
        row.append(canvas);
        await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        recolorPdfCanvas(canvas);
      }
      const shown = pdfSpread && pdfPage < pdfDoc.numPages ? `${pdfPage}-${pdfPage + 1}` : String(pdfPage);
      pdfCtrl.querySelector('.pg-no').textContent = `${shown} / ${pdfDoc.numPages}`;
      posEl.textContent = `${shown}/${pdfDoc.numPages}`;
      saveProgress({ page: pdfPage, pages: pdfDoc.numPages, pct: Math.round(pdfPage / pdfDoc.numPages * 100), zoom: pdfZoom });
    }

    function pdfPagesText(page) { return page; }  // 占位，保持接口一致

    async function renderPdfScroll() {
      pdfWrap.innerHTML = '';
      pdfRendered.clear();
      if (pdfObserver) pdfObserver.disconnect();
      const firstPage = await pdfDoc.getPage(1);
      // 连续滚动始终按显示宽度铺满（整页视图只作用于单页/双页）
      const m = pdfMetrics();
      const vp0 = firstPage.getViewport({ scale: 1 });
      const scale = (m.w / vp0.width) * (pdfZoom || 1);
      const vp1 = firstPage.getViewport({ scale });
      const ratio = window.devicePixelRatio > 1 ? Math.min(2.5, window.devicePixelRatio) : 1.4;

      pdfObserver = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const holder = en.target;
          const p = Number(holder.dataset.page);
          if (pdfRendered.has(p)) continue;
          pdfRendered.add(p);
          (async () => {
            try {
              const pg = await pdfDoc.getPage(p);
              // 1.9.3：每页比例可能不同（A4 与横向页混排），渲染前先把占位比例改成这一页的真实比例
              const vpU = pg.getViewport({ scale: 1 });
              holder.style.paddingBottom = (vpU.height / vpU.width * 100).toFixed(3) + '%';
              const vp = pg.getViewport({ scale: scale * ratio });
              const canvas = h('canvas', { class: 'rd-page' });
              canvas.width = Math.floor(vp.width);
              canvas.height = Math.floor(vp.height);
              canvas.style.width = '100%';
              holder.innerHTML = '';
              holder.append(canvas);
              await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
              // 画好之后收掉占位高度，让高度真正由 canvas 决定（避免 padding 与 canvas 叠加）
              holder.style.paddingBottom = '';
              holder.style.height = 'auto';
              recolorPdfCanvas(canvas);
            } catch (_) {}
          })();
        }
      }, { root: body, rootMargin: '600px 0px' });

      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const holder = h('div', { class: 'rd-pdf-slot', 'data-page': p });
        // 1.9.3：占位高度改用「宽高比」表达（padding-bottom 百分比相对自身宽度算），
        // 这样实际宽度被 max-width:1100px 收窄时，占位高度会同步缩小，不会在页面底部多出一大块灰底。
        // 第一页的比例先兜着，每页渲染时再用该页真实比例覆盖。
        holder.style.width = Math.round(vp1.width) + 'px';
        holder.style.paddingBottom = (vp1.height / vp1.width * 100).toFixed(3) + '%';
        holder.style.height = '0px';
        pdfWrap.append(holder);
        pdfObserver.observe(holder);
      }
      // 进度观察
      const seen = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (en.isIntersecting) {
            const p = Number(en.target.dataset.page);
            pdfPage = p;
            pdfCtrl.querySelector('.pg-no').textContent = `${p} / ${pdfDoc.numPages}`;
            posEl.textContent = `${p}/${pdfDoc.numPages}`;
            saveProgress({ page: p, pages: pdfDoc.numPages, pct: Math.round(p / pdfDoc.numPages * 100) });
          }
        }
      }, { root: body, threshold: 0.55 });
      [...pdfWrap.children].forEach(c => seen.observe(c));
      if (pdfPage > 1) scrollToPdfPage(pdfPage, false);
    }

    function scrollToPdfPage(p, smooth) {
      const slot = pdfWrap.querySelector(`[data-page="${p}"]`);
      if (slot) slot.scrollIntoView({ block: 'start', behavior: smooth === false ? 'auto' : 'smooth' });
    }

    function switchPdfMode(mode) {
      pdfMode = mode;
      body.classList.toggle('pdf-scroll', mode === 'scroll');
      body.classList.toggle('pdf-spread', mode === 'spread');
      // 1.5.0：底部浮动条常显（它同时提供 适合宽度/整页视图/双页 三种视图切换，任何模式都要能点）
      pdfCtrl.style.display = '';
      relayoutPdf();
    }

    function relayoutPdf() {
      if (!pdfDoc) return;
      if (pdfMode === 'scroll') renderPdfScroll().catch(() => {});
      else renderPdfPage().catch(() => {});
    }

    async function buildPdf(url, isImagePdf) {
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js'; } catch (_) {}
      const loading = h('div', { class: 'rd-loading' }, isImagePdf ? '正在打开页面图片…' : '正在加载 PDF…');
      body.append(loading);
      // 1.5.0：按需分块取数据（disableAutoFetch），上百 MB 的 PDF 不再整本拉进浏览器内存
      const task = pdfjsLib.getDocument({ url, rangeChunkSize: 131072, disableAutoFetch: true, disableStream: false });
      task.onProgress = p => { if (p && p.total) loading.textContent = `正在加载 PDF… ${Math.round(p.loaded / p.total * 100)}%`; };
      pdfDoc = await task.promise;
      loading.remove();
      pdfPage = clamp(pdfPage || 1, 1, pdfDoc.numPages);

      const prevB = h('button', { class: 'rd-pz', title: '上一页' }, '◀');
      const nextB = h('button', { class: 'rd-pz', title: '下一页' }, '▶');
      const pgNo = h('span', { class: 'pg-no' }, '');

      // ---- 视图控制：− / 适合宽度 / + / 整页视图 / 双页 ----
      const zoomBy = f => { pdfZoom = clamp((pdfZoom || 1) * f, 0.4, 4); syncPdf(); };
      function setFit(kind) {
        pdfFit = kind; pdfZoom = 0;
        pdfSpread = false;
        pdfMode = kind === 'page' ? 'single' : 'scroll';
        syncPdf();
      }
      function toggleSpread() {
        pdfSpread = !pdfSpread;
        pdfFit = 'width'; pdfZoom = 0;
        pdfMode = pdfSpread ? 'spread' : 'single';
        if (pdfSpread && pdfPage % 2 === 0) pdfPage = Math.max(1, pdfPage - 1);
        syncPdf();
      }
      function makeGroup() {
        const zOut = h('button', { class: 'rd-pz', title: '缩小' }, '−');
        const zIn = h('button', { class: 'rd-pz', title: '放大' }, '＋');
        const fitW = h('button', { class: 'rd-pz wide', title: '按显示宽度缩放（点此恢复）' }, '适合宽度');
        const fitP = h('button', { class: 'rd-pz wide', title: '一次显示整页' }, '整页视图');
        const spr = h('button', { class: 'rd-pz wide', title: '两页并排显示' }, '双页');
        const pct = h('span', { class: 'zoom-pct' }, '');
        zOut.onclick = () => zoomBy(1 / 1.2);
        zIn.onclick = () => zoomBy(1.2);
        fitW.onclick = () => setFit('width');
        fitP.onclick = () => setFit('page');
        spr.onclick = () => toggleSpread();
        return { zOut, zIn, fitW, fitP, spr, pct };
      }
      const g1 = makeGroup();
      const g2 = makeGroup();
      const sepA = h('span', { class: 'rd-pz-sep' });
      const sepB = h('span', { class: 'rd-pz-sep' });
      pdfCtrl.append(prevB, pgNo, nextB, sepA, g1.zOut, g1.fitW, g1.zIn, g1.pct, sepB, g1.fitP, g1.spr);

      prevB.addEventListener('click', () => {
        const step = pdfSpread ? 2 : 1;
        if (pdfPage > 1) { pdfPage = Math.max(1, pdfPage - step); if (pdfSpread && pdfPage % 2 === 0) pdfPage--; renderPdfPage(); }
      });
      nextB.addEventListener('click', () => {
        const step = pdfSpread ? 2 : 1;
        if (pdfPage < pdfDoc.numPages) { pdfPage = Math.min(pdfDoc.numPages, pdfPage + step); if (pdfSpread && pdfPage % 2 === 0) pdfPage = Math.max(1, pdfPage - 1); renderPdfPage(); }
      });

      /** 同步按钮状态与标签，然后重新排版 */
      function syncPdf() {
        for (const g of [g1, g2]) {
          g.fitW.classList.toggle('on', !pdfZoom && pdfMode === 'scroll' && pdfFit === 'width');
          g.fitP.classList.toggle('on', !pdfZoom && pdfMode === 'single' && pdfFit === 'page');
          g.spr.classList.toggle('on', pdfSpread);
          // 按钮文案固定为“适合宽度”，缩放比例单独显示，避免按钮名随缩放变化而失去可读性
          g.pct.textContent = pdfZoom ? Math.round(pdfZoom * 100) + '%' : '';
          g.pct.style.display = pdfZoom ? '' : 'none';
        }
        switchPdfMode(pdfMode);
      }

      body.append(pdfWrap, pdfCtrl);
      pdfCtrl.classList.add('show');
      // 顶栏再放一组（手机在不便点底部浮动条时也能切换）
      const topZoom = h('div', { class: 'rd-topzoom' }, g2.zOut, g2.fitW, g2.zIn, g2.pct, g2.fitP, g2.spr);
      bar.insertBefore(topZoom, posEl.nextSibling);

      pdfMode = 'scroll'; pdfFit = 'width'; pdfSpread = false;
      syncPdf();
      posEl.textContent = `${pdfPage}/${pdfDoc.numPages}`;
      // pdf.js 自带大纲 → 目录
      try {
        const outline = await pdfDoc.getOutline();
        if (outline && outline.length) {
          const flat = [];
          const walk = async (nodes, level) => {
            for (const n of nodes) {
              let page = 0;
              try {
                let dest = n.dest;
                if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
                if (Array.isArray(dest) && dest[0]) page = (await pdfDoc.getPageIndex(dest[0])) + 1;
              } catch (_) {}
              flat.push({ label: String(n.title || '').slice(0, 80), level, page });
              if (n.items && n.items.length) await walk(n.items, level + 1);
            }
          };
          await walk(outline, 1);
          if (flat.length && (toc.length < flat.length)) {
            toc = flat;
            renderToc();
            api(`/books/${b.id}/toc`, { method: 'POST', body: JSON.stringify({ toc: flat, source: 'pdf-outline' }) }).catch(() => {});
          }
        }
      } catch (_) {}
      attachSwipe(pdfWrap);
    }

    // ---------- 纯文本 / Word（1.8.0：分块按需加载，大文件不再卡死） ----------
    // 以前是 fetch 整本 → TextDecoder 整本 → 每行一个 <p>，几十 MB 的 TXT 直接把页面卡住；
    // 现在只向服务端要「当前视口附近」的几十段，滚到边上再续，内存占用与文件大小无关。
    async function buildText() {
      const CHUNK = 80;
      const hint = h('div', { class: 'rd-doc-hint' });
      const loadingEl = h('div', { class: 'rd-loading' }, '正在读取…');
      txtView = h('div', { class: 'rd-text-content' });
      body.append(hint, txtView, loadingEl);

      let kind = 'text', base = 0, busy = false, encoding = '';

      const fetchRange = (from, count) => api(`/books/${b.id}/text?from=${from}&count=${count || CHUNK}`);

      function makePara(item, abs) {
        const lv = item.l | 0;
        const tag = kind === 'html' && lv ? 'h' + Math.min(4, lv + 1) : 'p';
        const node = kind === 'html' ? h(tag, { html: item.v }) : h(tag, {}, item.v);
        node.setAttribute('data-line', String(abs));
        node.setAttribute('data-idx', String(abs - base));
        return node;
      }

      function appendItems(items, from) {
        const frag = document.createDocumentFragment();
        items.forEach((it, i) => {
          const node = makePara(it, from + i);
          txtParas.push(node);
          frag.append(node);
        });
        txtView.append(frag);
      }

      async function loadFrom(from, scrollTo) {
        const r = await fetchRange(from);
        kind = r.kind === 'html' ? 'html' : 'text';
        txtTotal = r.total;
        encoding = r.encoding || '';
        txtView.innerHTML = '';
        txtParas = [];
        base = from;
        txtBase = from;
        appendItems(r.items, from);
        if (scrollTo != null) {
          const node = txtParas[scrollTo - from];
          if (node) node.scrollIntoView({ block: 'start' });
        }
        return r;
      }

      async function loadMore() {
        if (busy) return false;
        const next = base + txtParas.length;
        if (next >= txtTotal) return false;
        busy = true;
        try {
          const r = await fetchRange(next);
          appendItems(r.items, next);
          txtTotal = r.total;
          return r.items.length > 0;
        } catch (_) { return false; }
        finally { busy = false; }
      }

      async function loadPrev() {
        if (busy || base <= 0) return;
        const from = Math.max(0, base - CHUNK);
        busy = true;
        try {
          const r = await fetchRange(from, base - from);
          const nodes = r.items.map((it, i) => makePara(it, from + i));
          const frag = document.createDocumentFragment();
          nodes.forEach(n => frag.append(n));
          const prevH = body.scrollHeight, prevTop = body.scrollTop;
          txtView.insertBefore(frag, txtView.firstChild);
          txtParas = nodes.concat(txtParas);
          base = from;
          txtBase = from;
          body.scrollTop = prevTop + (body.scrollHeight - prevH);
        } catch (_) {}
        finally { busy = false; }
      }

      function firstVisible() {
        if (!txtParas.length) return base;
        const top = body.getBoundingClientRect().top;
        for (let i = 0; i < txtParas.length; i++) {
          if (txtParas[i].getBoundingClientRect().top >= top + 4) return base + i;
        }
        return base + txtParas.length - 1;
      }

      async function fillScreen() {
        let guard = 0;
        while (guard++ < 10 && txtParas.length && body.scrollHeight <= body.clientHeight + 240) {
          const more = await loadMore();
          if (!more) break;
        }
      }

      // 目录跳转：目标不在已加载窗口里就先按行号重载
      txtGotoLine = async (n) => {
        if (n >= base && n < base + txtParas.length) {
          const node = txtParas[n - base];
          if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        }
        const from = Math.max(0, n - 5);
        await loadFrom(from, n);
        await fillScreen();
      };

      try {
        let from = 0, jump = null;
        if (prev.line != null && prev.line > 0) {
          // 新版进度直接记录段落序号
          from = Math.max(0, prev.line - 5);
          jump = prev.line;
        } else if (prev.pct) {
          // 老进度只有百分比：先问总数，再换算成段落位置
          const probe = await fetchRange(0, 1);
          txtTotal = probe.total;
          const est = Math.round((txtTotal * Math.min(100, Number(prev.pct) || 0)) / 100);
          if (est > 5) { from = Math.max(0, est - 5); jump = est; }
        }
        await loadFrom(from, jump);
        loadingEl.remove();
        if (!txtTotal) {
          hint.textContent = '这个文件里没有可显示的正文。';
        } else {
          hint.textContent = `${kind === 'html' ? 'Word 文档' : '纯文本'} · 共 ${txtTotal.toLocaleString()} 段` + (encoding ? ` · 编码 ${encoding}` : '');
        }
        await fillScreen();
      } catch (e) {
        loadingEl.textContent = '读取失败：' + e.message;
      }

      let lastSave = 0;
      body.addEventListener('scroll', () => {
        const st = body.scrollTop;
        if (st + body.clientHeight > body.scrollHeight - 700) loadMore().then(m => { if (m) fillScreen(); });
        if (st < 320) loadPrev();
        const now = Date.now();
        if (now - lastSave > 1200) {
          lastSave = now;
          const first = firstVisible();
          const pct = txtTotal ? Math.round((first / txtTotal) * 100) : 0;
          saveProgress({ line: first, pct, pos: Math.round(st) });
        }
      }, { passive: true });

      attachSelection(body);
      if (!toc.length) api(`/books/${b.id}/toc`, { method: 'POST', body: '{}' }).then(r => { toc = r.toc || []; renderToc(); }).catch(() => {});
    }

    // ---------- MOBI ----------
    function decorateFrame(frame) {
      try {
        const doc = frame.contentDocument;
        if (!doc || doc.__decorated) return;
        doc.__decorated = true;
        const p = presetOf(cfg.theme);
        const style = doc.createElement('style');
        style.textContent = `
          html,body{background:transparent !important;color:${p.fg} !important;}
          body{font-size:${cfg.fontSize}px !important;line-height:${cfg.lineHeight} !important;
               font-family:${(FONTS.find(f => f.id === cfg.font) || FONTS[0]).css} !important;
               padding:0 4px !important;margin:0 !important;}
          p{margin:0 0 ${cfg.paraSpace}em !important;}
          img{max-width:100% !important;height:auto !important;}
          a{color:${isDarkBg(cfg.theme) ? '#93c5fd' : '#2563eb'} !important;}
          ::selection{background:#fde68a;color:#111;}`;
        doc.head.append(style);
        guardExternalLinks(doc);
        const resize = () => { try { frame.style.height = Math.max(200, doc.documentElement.scrollHeight + 8) + 'px'; } catch (_) {} };
        resize();
        setTimeout(resize, 500);
        doc.addEventListener('mouseup', () => {
          const sel = doc.getSelection();
          const text = (sel && sel.toString().trim()) || '';
          if (text) showSel(text.slice(0, 400), { pos: Math.round(body.scrollTop) });
        });
      } catch (_) {}
    }

    async function buildMobi() {
      const loading = h('div', { class: 'rd-loading' }, '正在解析 MOBI…');
      const view = h('div', { class: 'rd-mobi' });
      body.append(loading, view);
      try {
        const mod = await import('/vendor/foliate/mobi.js');
        const blob = await (await fetch(data.url)).blob();
        const unzlib = async bytes => {
          try {
            const ds = new DecompressionStream('deflate');
            return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
          } catch (_) { return bytes; }
        };
        const mb = await new mod.MOBI({ unzlib }).open(new File([blob], b.filename || 'book.mobi'));
        mobiSections = (mb.sections || []).filter(s => s && typeof s.load === 'function');
        // foliate toc
        try {
          const t = mb.toc || [];
          if (t.length) {
            const flat = [];
            const walk = (nodes, level) => {
              for (const n of nodes) {
                if (n.label) flat.push({ label: String(n.label).replace(/<[^>]+>/g, '').slice(0, 80), level, idx: n.href ? mobiSections.findIndex(s => s.id === n.href || s.href === n.href) : undefined });
                if (n.subitems && n.subitems.length) walk(n.subitems, level + 1);
              }
            };
            walk(t, 1);
            if (flat.length) { toc = flat; renderToc(); }
          }
        } catch (_) {}
      } catch (e) {
        loading.textContent = 'MOBI 解析失败：' + e.message;
        return;
      }
      loading.remove();
      if (!mobiSections.length) {
        view.append(h('div', { class: 'rd-empty' }, h('p', {}, '该 MOBI 未能解析出正文（可能加密或格式特殊）')));
        return;
      }
      async function loadMore(n) {
        for (let i = 0; i < n && mobiLoaded < mobiSections.length; i++, mobiLoaded++) {
          try {
            const url = await mobiSections[mobiLoaded].load();
            const frame = h('iframe', { class: 'rd-mobi-frame', scrolling: 'no' });
            frame.src = url;
            frame.addEventListener('load', () => decorateFrame(frame));
            view.append(frame);
            mobiFrames.push(frame);
          } catch (_) {}
        }
      }
      await loadMore(Math.min(3, mobiSections.length));
      body.addEventListener('scroll', () => {
        saveProgress({ pos: Math.round(body.scrollTop), pct: Math.round(body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight) * 100) });
        if (body.scrollTop > body.scrollHeight - body.clientHeight * 2 && mobiLoaded < mobiSections.length) loadMore(2);
      });
      if (prev.pos) body.scrollTop = prev.pos;
      posEl.textContent = 'MOBI';
    }

    // ---------- CBZ ----------
    async function buildCbz() {
      const view = h('div', { class: 'rd-imgview' });
      body.append(view);
      for (let i = 0; i < data.pages; i++) view.append(h('img', { src: `/api/books/${b.id}/cbz/${i}${tokenQ()}`, loading: 'lazy' }));
      if (prev.pos) body.scrollTop = prev.pos;
      body.addEventListener('scroll', () => saveProgress({ pos: Math.round(body.scrollTop), pct: Math.round(body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight) * 100) }));
    }

    // ---------- PPT：逐页栅格化 → 图片 PDF ----------
    let slideCards = [], slideIdx = 0;

    function wrapLines(ctx, text, maxWidth) {
      const lines = [];
      let line = '';
      for (const ch of String(text)) {
        if (ch === '\n') { lines.push(line); line = ''; continue; }
        const test = line + ch;
        if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = ch; }
        else line = test;
      }
      if (line) lines.push(line);
      return lines;
    }

    function drawSlide(canvas, slide, W, H, scale) {
      const ctx = canvas.getContext('2d');
      canvas.width = Math.round(W * scale);
      canvas.height = Math.round(H * scale);
      ctx.scale(scale, scale);
      ctx.fillStyle = slide.bg || '#ffffff';
      ctx.fillRect(0, 0, W, H);
      const imgs = [];
      for (const it of slide.items) {
        if (it.type === 'rect') {
          ctx.save();
          if (it.rot) { ctx.translate(it.x + it.w / 2, it.y + it.h / 2); ctx.rotate(it.rot * Math.PI / 180); ctx.translate(-(it.x + it.w / 2), -(it.y + it.h / 2)); }
          ctx.fillStyle = it.fill;
          if (it.ellipse) {
            ctx.beginPath();
            ctx.ellipse(it.x + it.w / 2, it.y + it.h / 2, it.w / 2, it.h / 2, 0, 0, Math.PI * 2);
            ctx.fill();
          } else if (it.round) {
            const r = Math.min(12, it.w / 2, it.h / 2);
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(it.x, it.y, it.w, it.h, r);
            else ctx.rect(it.x, it.y, it.w, it.h);
            ctx.fill();
          } else ctx.fillRect(it.x, it.y, it.w, it.h);
          if (it.stroke && it.strokeW) { ctx.strokeStyle = it.stroke; ctx.lineWidth = it.strokeW; ctx.strokeRect(it.x, it.y, it.w, it.h); }
          ctx.restore();
        } else if (it.type === 'text') {
          let y = it.y + 4;
          // 估算总高度用于垂直居中
          const est = it.paras.reduce((n, p) => n + (p.size || 18) * 1.4, 0);
          if (it.anchor === 'ctr') y = it.y + Math.max(0, (it.h - est) / 2) + 4;
          else if (it.anchor === 'b') y = it.y + Math.max(0, it.h - est) + 4;
          for (const p of it.paras) {
            const size = p.size || 18;
            ctx.font = `${p.italic ? 'italic ' : ''}${p.bold ? '700 ' : '400 '}${size}px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`;
            ctx.fillStyle = p.color || '#1f2937';
            ctx.textBaseline = 'top';
            const indent = p.bullet ? '• ' : (p.level ? '    '.repeat(p.level) : '');
            const lines = wrapLines(ctx, indent + (p.text || ''), it.w);
            for (const ln of lines) {
              let x = it.x + 4;
              const w = ctx.measureText(ln).width;
              if (p.align === 'center') x += (it.w - w) / 2;
              else if (p.align === 'right') x += it.w - w;
              ctx.fillText(ln, x, y);
              y += size * 1.38;
            }
            y += size * 0.18;
          }
        } else if (it.type === 'table') {
          ctx.font = `${it.size || 14}px "Microsoft YaHei",sans-serif`;
          ctx.fillStyle = '#1f2937';
          const rows = it.rows.length, cols = Math.max(...it.rows.map(r => r.length), 1);
          const cw = it.w / cols, chh = it.h / rows;
          it.rows.forEach((row, ri) => row.forEach((cell, ci) => {
            ctx.fillStyle = ri === 0 ? 'rgba(0,0,0,.06)' : '#ffffff';
            ctx.fillRect(it.x + ci * cw, it.y + ri * chh, cw, chh);
            ctx.strokeStyle = 'rgba(0,0,0,.15)';
            ctx.strokeRect(it.x + ci * cw, it.y + ri * chh, cw, chh);
            ctx.fillStyle = '#1f2937';
            const lines = wrapLines(ctx, cell, cw - 12);
            let ty = it.y + ri * chh + 8;
            for (const ln of lines.slice(0, Math.floor((chh - 10) / ((it.size || 14) * 1.3)))) {
              ctx.fillText(ln, it.x + ci * cw + 6, ty);
              ty += (it.size || 14) * 1.3;
            }
          }));
        } else if (it.type === 'image') {
          imgs.push(it);
        }
      }
      return Promise.all(imgs.map(it => new Promise(resolve => {
        const im = new Image();
        im.onload = () => {
          try {
            ctx.save();
            if (it.rot) { ctx.translate(it.x + it.w / 2, it.y + it.h / 2); ctx.rotate(it.rot * Math.PI / 180); ctx.translate(-(it.x + it.w / 2), -(it.y + it.h / 2)); }
            ctx.drawImage(im, it.x, it.y, it.w, it.h);
            ctx.restore();
          } catch (_) {}
          resolve();
        };
        im.onerror = () => resolve();
        im.src = it.src;
      })));
    }

    /** 1.6.2 及以前的「逐页绘制」兼容模式；1.6.3 起仅在直接渲染失败时作为兜底入口 */
    async function buildPptRender() {
      const shell = h('div', { class: 'rd-slides-shell' });
      const stage = h('div', { class: 'rd-stage' });
      const tip = h('div', { class: 'rd-slides-tip' }, '正在把幻灯片逐页转换为图片…');
      const prog = h('div', { class: 'rd-progress' }, h('i', {}));
      shell.append(tip, prog, stage);
      body.append(shell);

      let model;
      try {
        const res = await fetch(data.slidesUrl, { headers: { Authorization: 'Bearer ' + state.token } });
        model = await res.json();
        if (!res.ok) {
          tip.textContent = '读取幻灯片失败：' + (model.error || ('HTTP ' + res.status));
          return false;
        }
      } catch (e) {
        tip.textContent = '读取幻灯片失败：' + e.message;
        return false;
      }
      if (!model.slides || !model.slides.length) {
        tip.textContent = '这个文件里没有可渲染的页面（可能是纯图片的旧版 .ppt，已由后台转换处理）。';
        return false;
      }

      const W = model.width || 1280, H = model.height || 720;
      const scale = 2;
      const canvas = h('canvas', { class: 'rd-stage-canvas' });
      canvas.style.width = Math.min(W, shell.clientWidth - 40) + 'px';
      canvas.style.height = 'auto';
      stage.append(canvas);

      const images = [];
      for (let i = 0; i < model.slides.length; i++) {
        tip.textContent = `正在渲染第 ${i + 1} / ${model.slides.length} 页…`;
        prog.querySelector('i').style.width = Math.round((i / model.slides.length) * 86) + '%';
        await drawSlide(canvas, model.slides[i], W, H, scale);
        images.push(canvas.toDataURL('image/jpeg', 0.9));
        await sleep(30);
      }
      prog.querySelector('i').style.width = '92%';
      tip.textContent = '正在合成图片版 PDF 并保存到书籍目录…';
      try {
        const r = await api(`/books/${b.id}/slides/pdf`, { method: 'POST', body: JSON.stringify({ images }) });
        prog.querySelector('i').style.width = '100%';
        tip.innerHTML = `已生成 <b>${r.pages}</b> 页图片版 PDF${r.fallback ? '（原目录不可写，已保存到应用数据目录）' : '，已保存到书籍所在目录'}。正在打开…`;
        await sleep(700);
        shell.remove();
        // 转成 PDF 阅读
        await buildPdf(`/api/books/${b.id}/slidepdf${tokenQ()}`, true);
        aiSay('sys', '提示：PPT 已转换为逐页图片 PDF，可直接缩放、全屏与朗读。');
        return true;
      } catch (e) {
        tip.textContent = '生成失败：' + e.message;
        return false;
      }
    }

    // ---------- 1.6.3：PPT / PPTX 直接用浏览器渲染（支持旧版二进制 .ppt） ----------
    let pptViewer = null;

    async function buildPptNative() {
      body.innerHTML = '';
      posEl.textContent = '';
      const host = h('div', { class: 'ppv-host' });
      body.append(host);
      try {
        pptViewer = await PptViewer.mount(host, {
          url: `/api/books/${b.id}/file${tokenQ()}`,
          token: state.token || '',
          startPage: prev.page || 1,
          // 1.7.1：服务端只在「还没转换过 + 当前用户可写书库」时才给 saveUrl；
          // 已经转换过的书不再出现「存为 PDF」按钮（一个文件只转换一次）。
          pdfUrl: data.saveUrl || '',
          extraActions: data.imagePdfUrl ? [{ label: 'PDF 版', onClick: openImagePdf }] : [],
          onPage: (i, n) => {
            posEl.textContent = `${i + 1}/${n}`;
            saveProgress({ page: i + 1, pages: n, pct: Math.round((i + 1) / n * 100) });
          },
          onPdfSaved: async r => {
            const go = confirm(`已生成 ${r.pages} 页 PDF，并作为本书的新版本入库。${r.fallback ? '\n（书籍目录不可写，已保存到应用数据目录）' : ''}\n\n现在打开 PDF 版本吗？`);
            if (go) await openImagePdf();
          }
        });
        if (pptViewer.pages) {
          if (data.convertedPdf) {
            aiSay('sys', `已在浏览器里直接渲染 ${pptViewer.pages} 页。这本书已经生成过 PDF（${data.convertedPdf.filename}），同一个文件只转换一次；如需重新转换，请先在版本管理里删除该 PDF 版本。`);
          } else if (data.saveUrl) {
            aiSay('sys', `已在浏览器里直接渲染 ${pptViewer.pages} 页：可左右翻页、缩放、选中文字。点右下角「存为 PDF」可把当前渲染结果生成为本书的新版本。`);
          } else {
            aiSay('sys', `已在浏览器里直接渲染 ${pptViewer.pages} 页：可左右翻页、缩放、选中文字。`);
          }
        }
      } catch (e) {
        showPptFallback(e && e.message ? e.message : String(e));
      }
    }

    async function openImagePdf() {
      try { if (pptViewer) pptViewer.destroy(); } catch (_) {}
      pptViewer = null;
      body.innerHTML = '';
      posEl.textContent = '';
      await buildPdf(`/api/books/${b.id}/slidepdf${tokenQ()}`, true);
    }

    function showPptFallback(msg) {
      body.innerHTML = '';
      const box = h('div', { class: 'rd-empty', style: 'padding-top:9vh' },
        h('div', { class: 'big' }, '📄'),
        h('p', {}, '浏览器直接渲染失败'),
        h('p', { class: 'sm' }, msg || '未知原因'),
        h('button', { class: 'btn', style: 'margin-top:14px', onclick: () => buildPptNative() }, '↻ 重试直接渲染'));
      if (data.imagePdfUrl) {
        box.append(h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => openImagePdf() }, '📄 打开已生成的 PDF 版'), h('br'));
      }
      // 1.7.1：已经转换过就不再提供转换入口（同一个文件只转换一次）
      if (!data.convertedPdf && data.saveUrl) {
        box.append(
          h('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: () => bgConvert(box) }, '⚙ 后台转换为 PDF'),
          h('br'),
          h('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: () => { body.innerHTML = ''; buildPptRender(); } }, '🖥 逐页绘制（兼容模式）'),
          h('br'));
      } else if (data.convertedPdf) {
        box.append(h('p', { class: 'sm' }, `这本书已经生成过 PDF（${data.convertedPdf.filename}），同一个文件只转换一次。如需重新转换，请先在版本管理里删除该 PDF 版本。`));
      }
      box.append(dlBtn('⬇ 下载原文件', 'btn ghost', 'margin-top:10px'));
      body.append(box);
    }

    /** 兜底：服务端后台转换（原有链路，仍然保留） */
    async function bgConvert(box) {
      const status = h('p', { class: 'rd-conv-status' }, '正在启动后台任务…');
      box.append(status);
      try {
        const j = await api(`/books/${b.id}/convert`, { method: 'POST', body: JSON.stringify({}) });
        for (let i = 0; i < 240; i++) {
          await sleep(700);
          let s;
          try { s = await api('/convert/' + j.jobId); } catch (_) { continue; }
          status.textContent = s.message + (s.total ? `（${s.done}/${s.total}）` : '');
          if (s.state === 'done') {
            status.textContent = '✅ ' + s.message + '，正在打开…';
            await sleep(600);
            await openImagePdf();
            return;
          }
          if (s.state === 'failed') { status.textContent = '❌ ' + (s.error || '转换失败'); return; }
        }
        status.textContent = '任务仍在后台运行，稍后可在书籍详情页查看新版本。';
      } catch (e) {
        status.textContent = '启动失败：' + e.message;
      }
    }

    /** 下载原文件按钮：走 Blob 方式，避开自签名 HTTPS 下浏览器拦截 <a download>（1.6.2） */
    function dlBtn(text, cls, style) {
      return h('button', {
        class: cls, style,
        onclick: e => saveFile(`/api/books/${b.id}/file${tokenQ()}&download=1`, b.filename || '', e.currentTarget)
      }, text);
    }

    // ---------- 选区绑定（PDF 之外的容器） ----------
    function attachSelection(container) {
      container.addEventListener('mouseup', () => {
        const s = window.getSelection();
        const text = (s && s.toString().trim()) || '';
        if (!text) return;
        const node = s.anchorNode;
        if (!node || !container.contains(node.nodeType === 3 ? node.parentNode : node)) return;
        showSel(text.slice(0, 400), { page: pdfDoc ? pdfPage : undefined, pos: Math.round(body.scrollTop) });
      });
    }

    function attachSwipe(el) {
      let sx = 0, sy = 0, st = 0;
      el.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
      }, { passive: true });
      el.addEventListener('touchend', e => {
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Date.now() - st > 700) return;
        if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy)) return;
        if (dx < 0) nextPage(); else prevPage();
      }, { passive: true });
    }

    // ---------- 分发 ----------
    if (data.type === 'epub') await buildEpub();
    else if (data.type === 'pdf') await buildPdf(data.url, !!data.imagePdf);
    else if (data.type === 'text') await buildText();
    else if (data.type === 'mobi') await buildMobi();
    else if (data.type === 'cbz') await buildCbz();
    else if (data.type === 'ppt-convert') await buildPptNative();
    else {
      body.append(h('div', { class: 'rd-empty', style: 'padding-top:12vh' },
        h('div', { class: 'big' }, '📄'),
        h('p', {}, '该格式暂不支持在线阅读，可下载后用本地软件打开'),
        h('button', {
          class: 'btn',
          onclick: e => saveFile(data.url, b.filename || data.filename || '', e.currentTarget)
        }, '下载文件')));
    }
  }

  window.Reader = { open, BG_PRESETS, close: () => { if (liveClose) liveClose(); } };
})();
