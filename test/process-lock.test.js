'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { once } = require('events');
const { acquirePidLock, releasePidLock } = require('../platform/process-lock');
const { createTestEnv } = require('../scripts/isolated-env');

const dir = process.env.MADMODEL_STATE_DIR;
const workerPath = path.join(dir, 'lock-worker.cjs');
fs.writeFileSync(workerPath, `
  const lock = require(${JSON.stringify(require.resolve('../platform/process-lock'))});
  process.on('message', async ({ command, file }) => {
    try {
      if (command === 'release') {
        lock.releasePidLock(file);
        process.send({ released: true });
      } else process.send(await lock.acquirePidLock(file));
    } catch (e) { process.send({ error: e.message }); }
  });
  process.send({ ready: true });
`);

async function worker(t) {
  const child = fork(workerPath, [], { env: createTestEnv(dir), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  });
  await once(child, 'message');
  return child;
}
async function ask(child, command, file) {
  const reply = once(child, 'message');
  child.send({ command, file });
  const [value] = await reply;
  assert.equal(value.error, undefined);
  return value;
}

test('八个进程争用旧锁，任一轮只能有一个持有者', { timeout: 30000 }, async t => {
  const workers = await Promise.all(Array.from({ length: 8 }, () => worker(t)));
  const file = path.join(dir, 'contended.lock');
  fs.writeFileSync(file, 'invalid-stale-pid');
  for (let round = 0; round < 8; round++) {
    const result = await Promise.all(workers.map(child => ask(child, 'acquire', file)));
    assert.equal(result.filter(r => r.ok).length, 1, `第 ${round + 1} 轮必须恰有一个持有者`);
    const winner = workers[result.findIndex(r => r.ok)];
    assert.equal(Number(fs.readFileSync(file, 'utf8')), winner.pid);
    const stillHeld = await Promise.all(workers.map(child => ask(child, 'acquire', file)));
    assert.ok(stillHeld.every(r => !r.ok), '其他进程与持有者自身都不能再次取得同一锁');
    await ask(winner, 'release', file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(`${file}.holders`).length, 0);
  }
});

test('持锁进程被强制结束后，下一进程可恢复且不清理存活记录', { timeout: 10000 }, async t => {
  const child = await worker(t);
  const file = path.join(dir, 'crashed.lock');
  assert.equal((await ask(child, 'acquire', file)).ok, true);
  assert.equal((await acquirePidLock(file)).ok, false);
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  // 模拟同一死亡进程在出票阶段崩溃的另一条残留。
  fs.writeFileSync(path.join(`${file}.holders`, `${child.pid}.aaaa.json`), JSON.stringify({ choosing: true, ticket: 0 }));
  assert.equal((await acquirePidLock(file)).ok, true);
  assert.equal(fs.readdirSync(`${file}.holders`).length, 1);
  releasePidLock(file);
  assert.equal(fs.readdirSync(`${file}.holders`).length, 0);
});

test('旧版存活 PID 阻止获取；他方 release 不能删除持有者锁', { timeout: 10000 }, async t => {
  const child = await worker(t);
  const file = path.join(dir, 'legacy.lock');
  fs.writeFileSync(file, String(child.pid));
  assert.deepEqual(await acquirePidLock(file), { ok: false, pid: child.pid });
  releasePidLock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), String(child.pid));
});
