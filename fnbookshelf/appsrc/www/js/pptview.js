/* 飞牛书屋 1.6.3 —— PPT/PPTX 浏览器内直接渲染
 *
 * 引擎：@web-ppt/core 0.8.0（MIT，作者 unStone，随包放在 /vendor/webppt/）
 *   · 纯前端 ESM，无框架依赖，不联网、不上传文件
 *   · 同时支持 OOXML(.pptx) 与 1997–2003 二进制 .ppt（OfficeArt/CFB）
 *   · 输出自包含 SVG（图片内嵌为 data URL），可缩放、可选中文字
 *
 * 这样阅读 PPT 不再依赖服务端解析/转换，也不会因为 NAS 目录权限、
 * 内存或 LibreOffice 缺失而失败。
 */
'use strict';

(function () {
  const CORE_URL = '/vendor/webppt/core.js';
  let corePromise = null;

  function loadCore() {
    if (!corePromise) {
      corePromise = import(CORE_URL).catch(e => {
        corePromise = null;
        throw new Error('渲染引擎加载失败：' + (e && e.message ? e.message : e));
      });
    }
    return corePromise;
  }

  const h = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; n.append(kid.nodeType ? kid : document.createTextNode(kid)); }
    return n;
  };

  const fmtMB = n => (n / 1048576).toFixed(1) + ' MB';
  const idle = () => new Promise(r => setTimeout(r, 0));

  /**
   * 1.9.2：把引擎的英文占位文案换成人话。
   * 渲染引擎会把旧版 .ppt 里的 OLE 嵌入对象（Excel 表格截图、Word 文档块、
   * 早期公式/图表等）画成一个虚线框，中间写着「不支持编辑的旧版 OLE 对象」——
   * 用户看到这句会以为是软件坏了。这里改成不带技术词的中性说明。
   */
  const LABEL_MAP = [
    // 只认「不支持…OLE 对象」这类占位语，别把正文里偶然出现的 OLE 字样换掉
    [/(不支持|无法显示|无法编辑)?[^<]{0,8}旧版\s*OLE\s*对象/i, '嵌入对象（原文件里是表格/公式等外链内容，无法直接显示）'],
    [/不支持编辑的[^<]{0,20}/, '嵌入对象（原文件里是表格/公式等外链内容，无法直接显示）'],
    [/不支持的旧版形状.*?MSOSPT\s*(\d+)/i, '这个形状无法显示'],
    [/不支持的图表类型[:：]\s*(.+)/i, '图表无法显示（$1）'],
    [/图表渲染失败/, '图表无法显示']
  ];
  function friendlyLabel(svg) {
    if (!svg) return svg;
    // 只在含有「占位语特征」时才逐 text 节点替换，正常幻灯片直接原样返回（省开销）
    if (!/支持|OLE|MSOSPT|图表渲染失败/.test(svg)) return svg;
    return svg.replace(/(<text\b[^>]*>)([\s\S]*?)(<\/text>)/g, (m, a, body, c) => {
      const raw = body.replace(/<[^>]+>/g, '').trim();
      if (!raw) return m;
      for (const [re, to] of LABEL_MAP) {
        if (re.test(raw)) {
          const mm = raw.match(re);
          const rep = to.replace('$1', mm && mm[1] ? mm[1] : '');
          return a + rep + c;
        }
      }
      return m;
    });
  }

  /** 带进度地读取原文件（避免大文件时页面像卡死） */
  async function readFile(url, token, onBytes) {
    const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store' });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error('读取原文件失败（' + msg + '）');
    }
    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = await res.arrayBuffer();
      onBytes && onBytes(buf.byteLength, total);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      onBytes && onBytes(got, total);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  }

  /**
   * 把演示文稿挂载成可翻页的阅读视图
   * @param {HTMLElement} host 容器
   * @param {object} opts { url, token, startPage, pdfUrl, onStatus, onPage, onPdfSaved, onError }
   * @returns {Promise<{destroy:Function, goTo:Function, pages:number}>}
   */
  async function mount(host, opts) {
    opts = opts || {};
    const status = opts.onStatus || function () {};
    const onPage = opts.onPage || function () {};
    const onPdfSaved = opts.onPdfSaved || function () {};

    host.classList.add('ppv-host');
    host.innerHTML = '';
    const stage = h('div', { class: 'ppv-stage' });
    const tip = h('div', { class: 'ppv-tip' }, '正在加载渲染引擎…');
    host.append(stage, tip);

    let destroyed = false;
    const setTip = t => { if (!destroyed) { tip.textContent = t; tip.style.display = ''; } };
    const clearTip = () => { tip.style.display = 'none'; };

    try {
      status('正在加载渲染引擎…');
      const core = await loadCore();

      status('正在读取原文件…');
      const buf = await readFile(opts.url, opts.token, (got, total) => {
        setTip(total ? `正在读取原文件… ${fmtMB(got)} / ${fmtMB(total)}` : `正在读取原文件… ${fmtMB(got)}`);
      });
      if (destroyed) throw new Error('已关闭');

      setTip('正在解析幻灯片（旧版 .ppt 需要展开 OLE 结构，请稍候）…');
      await idle();
      const pres = await core.parse(buf);
      if (destroyed) throw new Error('已关闭');

      const slides = (pres && pres.slides) || [];
      if (!slides.length) throw new Error('这个文件里没有可渲染的页面');
      const W = pres.width || 960;
      const H = pres.height || 720;

      // ---------- 页面骨架 ----------
      const pageEls = [];
      const rendered = new Array(slides.length).fill(false);
      // 老 WebView 不认 aspect-ratio（Chrome 88+）时，占位页高度会塌成 0，
      // IntersectionObserver 就永远不触发，整本 PPT 一页都不渲染。用 padding-top 兜底。
      const hasAspect = !!(window.CSS && CSS.supports && CSS.supports('aspect-ratio', '16 / 9'));
      for (let i = 0; i < slides.length; i++) {
        const el = h('div', { class: 'ppv-page', 'data-i': i });
        if (hasAspect) el.style.aspectRatio = W + ' / ' + H;
        else el.style.paddingTop = (H / W * 100).toFixed(4) + '%';
        stage.append(el);
        pageEls.push(el);
      }
      clearTip();

      // ---------- 懒渲染队列 ----------
      let pumping = false;
      let queue = [];
      async function pump() {
        if (pumping) return;
        pumping = true;
        while (queue.length && !destroyed) {
          const i = queue.shift();
          if (rendered[i]) continue;
          try {
            const svg = await core.slideToSvgFile(pres, slides[i]);
            let text = typeof svg === 'string' ? svg : await svg.text();
            if (destroyed) break;
            text = friendlyLabel(text);
            pageEls[i].innerHTML = text;
            pageEls[i].classList.add('on');
            pageEls[i].style.aspectRatio = '';
            pageEls[i].style.paddingTop = '';
            rendered[i] = true;
          } catch (e) {
            pageEls[i].classList.add('bad');
            pageEls[i].textContent = `第 ${i + 1} 页渲染失败：${e && e.message ? e.message : e}`;
            rendered[i] = true;
          }
          await idle();
        }
        pumping = false;
        if (queue.length && !destroyed) pump();
      }
      function need(i) {
        if (i < 0 || i >= slides.length || rendered[i] || queue.includes(i)) return;
        queue.push(i);
        pump();
      }

      // ---------- 缩放 ----------
      const ZOOMS = [
        { id: 'screen', name: '适应屏幕' },
        { id: 'fit', name: '适应宽度' },
        { id: 'one', name: '100%' }
      ];
      let zoom = ZOOMS[0];
      function applyZoom() {
        // 容器宽度为 0（阅读器还没铺满、或刚挂载）时不能退回 280，否则大屏上幻灯片会缩成一小张
        const cw = host.clientWidth || document.documentElement.clientWidth || window.innerWidth || 0;
        const ch = window.innerHeight || document.documentElement.clientHeight || 0;
        const availW = Math.max(280, cw - 24);
        const availH = Math.max(240, ch - 150);
        let w;
        if (zoom.id === 'one') w = Math.min(W, availW);
        else if (zoom.id === 'fit') w = availW;
        else w = Math.min(availW, availH * W / H);
        pageEls.forEach(el => { el.style.width = w + 'px'; });
        zoomBtn.textContent = zoom.name;
      }

      // ---------- 页码 ----------
      let cur = 0;
      function setCurrent(i, scroll) {
        cur = Math.max(0, Math.min(slides.length - 1, i));
        posEl.textContent = `${cur + 1} / ${slides.length}`;
        onPage(cur, slides.length);
        if (scroll) {
          need(cur);
          pageEls[cur].scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      }

      // ---------- 浮动工具条 ----------
      const posEl = h('span', { class: 'ppv-pos' }, '1 / ' + slides.length);
      const prevBtn = h('button', { class: 'ppv-btn', title: '上一页', onclick: () => setCurrent(cur - 1, true) }, '‹');
      const nextBtn = h('button', { class: 'ppv-btn', title: '下一页', onclick: () => setCurrent(cur + 1, true) }, '›');
      const zoomBtn = h('button', { class: 'ppv-btn ppv-txt', title: '切换缩放', onclick: () => {
        zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length];
        applyZoom();
      } }, zoom.name);
      const pdfBtn = h('button', { class: 'ppv-btn ppv-txt', title: '在浏览器里逐页渲染并合成 PDF，作为本书的新版本' }, '存为 PDF');

      const acts = [prevBtn, posEl, nextBtn, h('span', { class: 'ppv-sep' }), zoomBtn];
      if (opts.pdfUrl) acts.push(pdfBtn);
      for (const a of (opts.extraActions || [])) {
        acts.push(h('button', { class: 'ppv-btn ppv-txt', title: a.title || '', onclick: a.onClick }, a.label));
      }
      const hud = h('div', { class: 'ppv-hud' }, acts);

      // ---------- 观察器 ----------
      const renderObs = new IntersectionObserver(es => {
        for (const e of es) if (e.isIntersecting) need(+e.target.dataset.i);
      }, { rootMargin: '1200px 0px' });
      pageEls.forEach(el => renderObs.observe(el));

      let lastPage = -1;
      const viewObs = new IntersectionObserver(es => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          const i = +e.target.dataset.i;
          if (i === lastPage) return;
          lastPage = i;
          cur = i;
          posEl.textContent = `${i + 1} / ${slides.length}`;
          onPage(i, slides.length);
        }
      }, { rootMargin: '-45% 0px -45% 0px' });
      pageEls.forEach(el => viewObs.observe(el));

      // ---------- 键盘 ----------
      function onKey(e) {
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); e.stopPropagation(); setCurrent(cur + 1, true); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); e.stopPropagation(); setCurrent(cur - 1, true); }
        else if (e.key === 'Home') { e.preventDefault(); setCurrent(0, true); }
        else if (e.key === 'End') { e.preventDefault(); setCurrent(slides.length - 1, true); }
      }
      document.addEventListener('keydown', onKey, true);

      let rt = null;
      const onResize = () => { clearTimeout(rt); rt = setTimeout(applyZoom, 150); };
      window.addEventListener('resize', onResize);

      // ---------- 存为 PDF：浏览器逐页光栅化 → 服务端合成并登记新版本 ----------
      let exporting = false;
      pdfBtn.addEventListener('click', async () => {
        if (exporting) return;
        if (slides.length > 320) return alert('页数过多（' + slides.length + ' 页），请改用后台转换。');
        exporting = true;
        const old = pdfBtn.textContent;
        pdfBtn.disabled = true;
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const images = [];
          for (let i = 0; i < slides.length; i++) {
            if (destroyed) return;
            pdfBtn.textContent = `${i + 1}/${slides.length}`;
            const blob = await core.slideToPng(pres, slides[i], 1.6);
            const bmp = await createImageBitmap(blob);
            canvas.width = bmp.width; canvas.height = bmp.height;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bmp, 0, 0);
            // 1.9.2：把引擎的「不支持编辑的旧版 OLE 对象」等英文占位盖掉，
            // 避免把技术提示烤进导出的 PDF
            try {
              const svgText = await core.slideToSvgFile(pres, slides[i]);
              const raw = typeof svgText === 'string' ? svgText : await svgText.text();
              if (/OLE|支持的旧版形状|不支持的图表/.test(raw)) {
                const hits = (raw.match(/<text\b[^>]*>[^<]*(?:OLE|支持的旧版形状|不支持的图表)[^<]*<\/text>/g) || []);
                let n = 0;
                for (const t of raw.matchAll(/<image\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)) n = Math.max(n, parseFloat(t[1]) || 0);
                // 简化处理：在每张图上按比例画一层半透明白 + 中性文字代价太高，
                // 这里只在页面右下角加一行说明，告诉读者这是源文件里的嵌入对象
                if (hits.length) {
                  const fs = Math.max(10, Math.round(canvas.width / 60));
                  ctx.font = fs + 'px sans-serif';
                  ctx.fillStyle = 'rgba(120,120,120,.9)';
                  ctx.textAlign = 'right';
                  ctx.fillText('⚠ 本页含 ' + hits.length + ' 处源文件嵌入对象，未能显示', canvas.width - fs, canvas.height - fs);
                }
              }
            } catch (_) {}
            if (bmp.close) bmp.close();
            images.push(canvas.toDataURL('image/jpeg', 0.88));
            await idle();
          }
          pdfBtn.textContent = '合成中…';
          const token = opts.token || '';
          const res = await fetch(opts.pdfUrl, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
            body: JSON.stringify({ images })
          });
          const r = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(r.error || ('HTTP ' + res.status));
          pdfBtn.textContent = '已生成 ✓';
          onPdfSaved(r);
          setTimeout(() => { pdfBtn.textContent = old; pdfBtn.disabled = false; }, 2500);
        } catch (e) {
          pdfBtn.textContent = old;
          pdfBtn.disabled = false;
          alert('生成 PDF 失败：' + (e && e.message ? e.message : e));
        } finally {
          exporting = false;
        }
      });

      host.append(hud);
      applyZoom();
      // 恢复上次阅读位置
      const start = Math.max(0, Math.min(slides.length - 1, (opts.startPage || 1) - 1));
      setCurrent(start, false);
      if (start > 0) setTimeout(() => setCurrent(start, true), 120);
      need(start);

      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        try { renderObs.disconnect(); } catch (_) {}
        try { viewObs.disconnect(); } catch (_) {}
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        try { if (pres && pres.dispose) pres.dispose(); } catch (_) {}
        host.innerHTML = '';
      };

      return { destroy, goTo: i => setCurrent(i, true), pages: slides.length };
    } catch (e) {
      if (destroyed) return { destroy() {}, goTo() {}, pages: 0 };
      host.innerHTML = '';
      throw e;
    }
  }

  window.PptViewer = { mount, loadCore };
})();
