// 清理本应用的残留进程（1.8.2.2）
//
// 背景：升级时旧进程可能卡在退出流程里（同步落盘 / exit 钩子），监听套接字还挂着
// 服务端口，新进程 listen 直接 EADDRINUSE。用户看到的就是「应用中心显示运行中，
// 网页一直转圈」，且只能重启 NAS 才能恢复。
//
// 这里在端口被占时扫一遍 /proc，只杀「确实是本应用」的进程：
//   命令行必须同时包含 fnbookshelf 与 server/app.js。
// 因此不会误杀 trim.photos 之类同样用 target/server/app.js 的其它 fnOS 应用，
// 也不会碰本应用里的其它 node 脚本（比如一次性转码工具）。
'use strict';
const fs = require('fs');

/**
 * @param {string} [procRoot] 默认 /proc（测试可传假目录）
 * @param {(pid:number, sig:string)=>void} [killer] 默认 process.kill
 * @returns {number[]} 被清理的 PID
 */
function killStaleAppProcesses(procRoot, killer) {
  if (process.platform === 'win32' && !procRoot) return [];
  const root = procRoot || '/proc';
  const kill = killer || ((pid, sig) => process.kill(pid, sig));
  const killed = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (_) { return killed; }
  for (const n of entries) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === process.pid) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`${root}/${n}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch (_) { continue; }
    if (!cmd || !/fnbookshelf/.test(cmd) || !/server\/app\.js/.test(cmd)) continue;
    try { kill(pid, 'SIGKILL'); killed.push(pid); } catch (_) {}
  }
  return killed;
}

module.exports = { killStaleAppProcesses };

/**
 * 找出正在监听某端口的进程（1.9.6）。
 * 报错只说「端口被占用」用户无从下手，这里给出进程名与 PID。
 * 做法：读 /proc/net/tcp{,6} 里 state=0A(LISTEN) 且本地端口匹配的 socket inode，
 * 再扫 /proc/<pid>/fd 反查谁持有该 socket。拿不到（权限不足/非 Linux）返回空数组。
 * @param {number|string} port
 * @returns {{pid:number,name:string}[]}
 */
function findPortHolder(port, procRoot) {
  const out = [];
  const root = procRoot || '/proc';
  if (process.platform === 'win32' && !procRoot) return out;
  const p = Number(port);
  if (!p) return out;
  const hex = p.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const f of [root + '/net/tcp', root + '/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== '0A') continue;           // 0A = LISTEN
      if (!c[1].endsWith(':' + hex)) continue;
      inodes.add(c[9]);
    }
  }
  if (!inodes.size) return out;
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (_) { return out; }
  for (const n of entries) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === process.pid) continue;
    let fds = [];
    try { fds = fs.readdirSync(`${root}/${n}/fd`); } catch (_) { continue; }
    let hit = false;
    for (const fd of fds) {
      let t = '';
      try { t = fs.readlinkSync(`${root}/${n}/fd/${fd}`); } catch (_) { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(t);
      if (m && inodes.has(m[1])) { hit = true; break; }
    }
    if (!hit) continue;
    let name = '';
    let cmd = '';
    try { name = fs.readFileSync(`${root}/${n}/comm`, 'utf8').trim(); } catch (_) {}
    try { cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch (_) {}
    // fnOS 的应用进程多半都叫 node，光报 comm 等于没说；从命令行里取应用名
    let app = '';
    const m1 = /\/var\/apps\/([^/\s]+)\//.exec(cmd);
    const m2 = /([^/\s]+)\/target\/server\/app\.js/.exec(cmd);
    if (m1) app = m1[1];
    else if (m2) app = m2[1];
    if (app === 'fnbookshelf') app = '飞牛书屋';
    out.push({ pid, name: app || name || '未知进程', cmd });
    if (out.length >= 3) break;
  }
  return out;
}

module.exports.findPortHolder = findPortHolder;
