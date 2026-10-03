// platform/process-lock.js
// 每个竞争者发布独立记录，按 Bakery 票号仲裁，不搬动他人的锁。
// 状态文件仍保存 PID，兼容 status 与旧版本；PID 被复用时保守视为存活。

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { atomicWrite } = require('./file-store');
const held = new Map();

function pidOf(content) {
  const pid = Number(String(content).trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function isAlive(pid) {
  // EPERM = 进程存在但无权发信号(他人/SYSTEM 进程):按存活处理——
  // 归入死进程会打破文件头"fail-safe 拒绝双跑"的承诺(PID 被系统进程
  // 复用时误判可接管)
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function remove(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function readParticipants(dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d+)\.[\da-f-]+\.json$/.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const pid = pidOf(match[1]);
    if (!isAlive(pid)) { remove(file); continue; }
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!entry || !Number.isSafeInteger(entry.ticket) || entry.ticket < 0 || typeof entry.choosing !== 'boolean') {
        throw new Error('锁记录损坏，请停止服务后清理对应的 .holders 目录。');
      }
      entries.push({ ...entry, name, pid });
    } catch (e) {
      if (e.code !== 'ENOENT') { e.lockPid = pid; throw e; }
    }
  }
  return entries;
}

async function retryFileAccess(action, pid) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { return action(); } catch (e) {
      // Windows 的打开/替换/删除窗口可能返回 EPERM。读取时重试整个快照，
      // 不能跳过未读出的票号，否则可能与持有者同时进入临界区。
      if (!(e.lockPid || pid) || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      if (Date.now() >= deadline) { e.code = 'LOCK_BUSY'; e.lockPid ||= pid; throw e; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function acquirePidLock(file) {
  file = path.resolve(file);
  if (held.has(file)) return { ok: false, pid: process.pid };
  const dir = `${file}.holders`;
  fs.mkdirSync(dir, { recursive: true });
  const name = `${process.pid}.${randomUUID()}.json`;
  const marker = path.join(dir, name);
  const state = { marker, acquired: false };
  held.set(file, state);
  try {
    // 先发布 choosing，再取票号。其他竞争者等 choosing 结束后比较。
    // 唯一文件名从不复用，清除死进程记录不会误删新持有者。
    await retryFileAccess(() => atomicWrite(marker, JSON.stringify({ choosing: true, ticket: 0 })), process.pid);
    const ticket = (await retryFileAccess(() => readParticipants(dir))).reduce((max, p) => Math.max(max, p.ticket), 0) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('锁票号超出范围，请停止服务后清理锁目录。');
    await retryFileAccess(() => atomicWrite(marker, JSON.stringify({ choosing: false, ticket })), process.pid);
    const deadline = Date.now() + 2000;
    for (;;) {
      const others = (await retryFileAccess(() => readParticipants(dir))).filter(p => p.name !== name);
      const choosing = others.find(p => p.choosing);
      if (choosing) {
        if (Date.now() >= deadline) return { ok: false, pid: choosing.pid };
        await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }
      const earlier = others.find(p => p.ticket < ticket || (p.ticket === ticket && p.name < name));
      if (earlier) return { ok: false, pid: earlier.pid };
      break;
    }
    // 只有仲裁成功者才能更新兼容 PID 文件；运行中的旧版本也会阻止获取。
    let previous = 0;
    try { previous = pidOf(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous && previous !== process.pid && isAlive(previous)) return { ok: false, pid: previous };
    await retryFileAccess(() => atomicWrite(file, String(process.pid)), process.pid);
    state.acquired = true;
    return { ok: true };
  } catch (e) {
    if (e.code === 'LOCK_BUSY') return { ok: false, pid: e.lockPid };
    throw e;
  } finally {
    if (!state.acquired) {
      await retryFileAccess(() => remove(marker), process.pid);
      held.delete(file);
    }
  }
}

function releasePidLock(file) {
  file = path.resolve(file);
  const state = held.get(file);
  if (!state) return;
  // 先清状态文件，再退票，避免新持有者撞见旧 PID。
  try {
    if (state.acquired && pidOf(fs.readFileSync(file, 'utf8')) === process.pid) remove(file);
  } catch { /* 残留 PID 可由同进程重取或死 PID 接管 */ }
  try { remove(state.marker); } catch { /* 死进程记录由下次获取清理 */ }
  held.delete(file);
}

process.once('exit', () => { for (const file of held.keys()) releasePidLock(file); });
module.exports = { pidOf, isAlive, acquirePidLock, releasePidLock };
