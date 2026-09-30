// 原子写入与目录事件唤醒。读方只会看到完整记录或文件不存在。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 临时文件必须每次唯一:固定 ${pid}.tmp 在同一进程内并发写同一目标时
// 互相覆盖(rename 抢跑会装错内容),随机后缀消除该共享名
function stagingFile(file, tag) {
  return `${file}.${tag}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// mode 0o600 在创建时就收紧权限(POSIX 下 umask 不影响显式 mode 的属主位),
// 避免"先 0644 后 chmod"之间出现世界可读的窗口。
// 失败时清掉暂存文件:Windows 上 rename 覆盖被占用目标会 EPERM,而调用方
// 可能反复重试(如 dumpFailed 随失败的请求),不清会在状态目录里堆积孤儿 .tmp
function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = stagingFile(file, 'w');
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 未建成或已被清理 */ }
    throw e;
  }
}

// ===== 续期等待:到期调度 + 文件事件唤醒 =====
// Watch directories so atomic file replacement does not detach the listener.
function createFileWakeup(files) {
  const directories = new Map();
  const watchers = [];
  const mtimes = new Map(); // basename → 上次事件时的 mtime(伪事件过滤)
  const normalize = name => process.platform === 'win32' ? name.toLowerCase() : name;
  let changed = false;
  let pending = null;
  let closed = false;

  for (const file of files) {
    const directory = path.dirname(file);
    if (!directories.has(directory)) directories.set(directory, new Set());
    directories.get(directory).add(normalize(path.basename(file)));
  }

  function wake() {
    changed = true;
    if (pending) pending('changed');
  }

  for (const [directory, names] of directories) {
    try {
      const watcher = fs.watch(directory, { persistent: false }, (_, name) => {
        if (name === null) { wake(); return; } // 无名事件(目录级):保守唤醒
        const norm = normalize(String(name));
        if (!names.has(norm)) return;
        // Windows/NTFS 的伪事件过滤:读取文件会更新 atime 且延迟最多 1 小时
        // 落盘,fs.watch 会把 atime 更新当事件上报(FILE_NOTIFY_CHANGE_LAST_
        // ACCESS)。守护自己的每小时例行读取正好触发延迟刷盘,伪事件会让
        // 调度器多跑一圈(日志双行)。mtime 未变即伪事件,忽略——真实写入
        // (原子替换)必然改变 mtime;文件被删等 stat 失败则保守唤醒。
        // 附带收益:Windows 对一次写入常发双事件,此处顺带去重
        try {
          const mtime = fs.statSync(path.join(directory, String(name))).mtimeMs;
          const prev = mtimes.get(norm);
          mtimes.set(norm, mtime);
          if (prev !== undefined && prev === mtime) return;
        } catch (e) { /* stat 失败:保守唤醒 */ }
        wake();
      });
      // The timer remains active if the directory disappears or watching fails.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch (error) { /* Timer fallback, including missing credentials directories. */ }
  }

  return {
    reset() { changed = false; },
    wait(ms) {
      if (closed) return Promise.resolve('closed');
      if (changed) return Promise.resolve('changed');
      return new Promise(resolve => {
        const timer = setTimeout(() => finish('timeout'), ms);
        const finish = reason => {
          clearTimeout(timer);
          pending = null;
          resolve(reason);
        };
        pending = finish;
      });
    },
    close() {
      closed = true;
      for (const watcher of watchers) watcher.close();
      if (pending) pending('closed');
    },
  };
}

module.exports = { atomicWrite, createFileWakeup };
