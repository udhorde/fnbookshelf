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
