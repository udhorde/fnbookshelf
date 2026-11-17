// 极简并发闸门（1.5.0）
// 目的：多用户同时打开上百 MB 的书时，限制「同时进行的重活」数量。
// 重活 = 解析压缩包条目 / 逐页渲染 PPT / 合并图片 PDF。
// 排队是异步的，不会阻塞事件循环；等待者按先来后到唤醒。
'use strict';

function createGate(max) {
  let active = 0;
  const queue = [];
  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    async run(fn) {
      if (active >= max) await new Promise(resolve => queue.push(resolve));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        const next = queue.shift();
        if (next) next();
      }
    }
  };
}

module.exports = { createGate };
