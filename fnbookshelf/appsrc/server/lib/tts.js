// TTS：浏览器本地语音（无需服务端） / OpenAI 兼容语音接口 / Azure 语音服务
// 服务端只负责在线引擎的合成与缓存，音频落在应用数据目录，可离线回放。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

function post(url, headers, body, timeout) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('TTS 接口地址无效')); }
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Length': data.length }, headers), timeout: timeout || 30000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ buf, type: res.headers['content-type'] || 'audio/mpeg' });
        else {
          let msg = buf.toString('utf8').slice(0, 300);
          try { const j = JSON.parse(msg); msg = j.error && (j.error.message || j.error) || msg; } catch (_) {}
          reject(new Error(`TTS 接口返回 ${res.statusCode}：${msg}`));
        }
      });
    });
    req.on('error', e => reject(new Error('TTS 请求失败：' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS 请求超时')); });
    req.write(data);
    req.end();
  });
}

function azureSsml(text, voice, rate) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pct = Math.round(((Number(rate) || 1) - 1) * 100);
  const rateStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">` +
    `<voice name="${esc(voice || 'zh-CN-XiaoxiaoNeural')}"><prosody rate="${rateStr}">${esc(text)}</prosody></voice></speak>`;
}

/**
 * 合成一段文本
 * @returns {Promise<{file:string, type:string, cached:boolean}>}
 */
async function synthesize(text, cfg, cacheDir) {
  text = String(text || '').trim();
  if (!text) throw new Error('朗读内容为空');
  text = text.slice(0, 1200);
  const engine = cfg.engine || 'browser';
  const key = crypto.createHash('sha1')
    .update([engine, text, cfg.voice || '', cfg.rate || 1,
      cfg.openai && cfg.openai.model, cfg.azure && cfg.azure.voice].join('|')).digest('hex');
  fs.mkdirSync(cacheDir, { recursive: true });
  const ext = engine === 'openai' ? '.mp3' : '.mp3';
  const file = path.join(cacheDir, key + ext);
  if (fs.existsSync(file) && fs.statSync(file).size > 500) return { file, type: 'audio/mpeg', cached: true };

  let buf, type = 'audio/mpeg';
  if (engine === 'openai') {
    const o = cfg.openai || {};
    if (!o.apiKey) throw new Error('尚未配置 OpenAI 语音接口的 API Key');
    const base = String(o.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const r = await post(`${base}/audio/speech`, {
      'Content-Type': 'application/json', 'Authorization': 'Bearer ' + o.apiKey
    }, {
      model: o.model || 'tts-1',
      input: text,
      voice: o.voice || 'alloy',
      speed: Math.max(0.25, Math.min(4, Number(cfg.rate) || 1)),
      response_format: 'mp3'
    });
    buf = r.buf; type = r.type;
  } else if (engine === 'azure') {
    const a = cfg.azure || {};
    if (!a.key || !a.region) throw new Error('尚未配置 Azure 语音服务的 Key 与区域');
    const r = await post(`https://${a.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'Ocp-Apim-Subscription-Key': a.key,
      'User-Agent': 'fnbookshelf'
    }, azureSsml(text, a.voice, cfg.rate));
    buf = r.buf; type = r.type;
  } else {
    throw new Error('当前为浏览器本地朗读模式，无需服务端合成');
  }
  fs.writeFileSync(file, buf);
  // 缓存上限 300 条
  try {
    const files = fs.readdirSync(cacheDir).map(f => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }));
    if (files.length > 300) {
      files.sort((a, b) => a.t - b.t).slice(0, files.length - 300)
        .forEach(x => { try { fs.unlinkSync(path.join(cacheDir, x.f)); } catch (_) {} });
    }
  } catch (_) {}
  return { file, type: type || 'audio/mpeg', cached: false };
}

/** 对外暴露的可用引擎与模型清单（供管理后台与阅读器选择） */
function engines(cfg) {
  const list = [{ id: 'browser', name: '浏览器本地语音（离线、免费）', models: ['系统语音包'] }];
  list.push({ id: 'openai', name: 'OpenAI 兼容语音接口', models: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'] });
  list.push({ id: 'azure', name: '微软 Azure 语音', models: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural', 'zh-CN-XiaoyiNeural'] });
  const cur = (cfg && cfg.engine) || 'browser';
  return { current: cur, list };
}

module.exports = { synthesize, engines };
