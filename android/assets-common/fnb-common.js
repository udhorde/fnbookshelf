/*
 * 飞牛书屋客户端公共注入脚本。
 * 网页里的 saveFile() 是 fetch → Blob → <a download>，WebView 对 blob: 下载不做事，
 * 这里把点击截下来，改由原生保存到系统「下载」目录。
 */
(function () {
  if (window.__fnbSaveHook) return;

  function toast(msg) {
    try { FNB.toast(msg); } catch (e) { }
  }

  function saveDataUrl(dataUrl, name) {
    var comma = dataUrl.indexOf(',');
    if (comma < 0) { toast('下载失败：内容为空'); return; }
    var meta = dataUrl.slice(5, comma);
    var mime = meta.split(';')[0] || '';
    var body = dataUrl.slice(comma + 1);
    var size = Math.floor(body.length * 3 / 4);
    var err = FNB.dlBegin(name, mime, size);
    if (err) { toast('保存失败：' + err); return; }
    var STEP = 192 * 1024, ok = true;
    for (var i = 0; i < body.length; i += STEP) {
      if (!FNB.dlChunk(body.substr(i, STEP))) { ok = false; break; }
    }
    if (ok) FNB.dlEnd(); else FNB.dlAbort();
  }

  function saveBlob(blob, name) {
    if (!blob || !blob.size) { toast('下载失败：文件内容为空'); return; }
    toast('正在保存《' + name + '》…');
    var reader = new FileReader();
    reader.onload = function () { saveDataUrl(String(reader.result || ''), name); };
    reader.onerror = function () { toast('读取文件内容失败'); };
    reader.readAsDataURL(blob);
  }

  document.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== document && !(node.tagName === 'A' && node.hasAttribute('download'))) {
      node = node.parentNode;
    }
    if (!node || node === document) return;
    var href = node.getAttribute('href') || '';
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    var name = node.getAttribute('download') || 'book.bin';
    if (href.indexOf('blob:') === 0) {
      fetch(href).then(function (r) { return r.blob(); })
        .then(function (b) { saveBlob(b, name); })
        .catch(function (err) { toast('下载失败：' + (err && err.message ? err.message : err)); });
      return;
    }
    if (href.indexOf('data:') === 0) { saveDataUrl(href, name); return; }
    try {
      var abs = new URL(href, location.href).toString();
      FNB.downloadUrl(abs, name);
    } catch (err) {
      toast('下载地址不合法');
    }
  }, true);

  // 装好才打标记，注入过早时可被下一次注入重试
  window.__fnbSaveHook = 1;
})();
