// test/logout-lock-gate.test.js — logout 第二道闸(锁 PID 探活)的错误处理。
//
// 为什么需要:该闸的职责是"watch 还在跑就拒绝清凭据"。原实现把读取锁文件的
// **所有**错误都当成"无锁文件 = 未运行",于是权限/IO 类错误会静默放行去清凭据
// ——恰在本该校验的场景下失效(2026-09-22 审阅指出)。
// paths.js 在 require 时读取环境变量,故用子进程 + MADMODEL_STATE_DIR 隔离
// 状态目录,不碰本机真实凭据。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 在临时状态目录里跑一段脚本,返回 { code, stdout, stderr }
function runInStateDir(setup, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmlogout-'));
  try {
    setup(dir);
    const runner = path.join(dir, 'runner.js');
    fs.writeFileSync(runner, 'globalThis.fetch = async () => ({ status: 200, json: async () => ({ proxy: "other" }) });\n' + script);
    try {
      const stdout = execFileSync(process.execPath, [runner], {
        cwd: ROOT,
        encoding: 'utf8',
        env: require('../scripts/isolated-env').createTestEnv(dir),
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (e) {
      return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('锁文件不存在(ENOENT):视为未运行,继续执行', () => {
  const r = runInStateDir(() => { /* 不建锁文件 */ }, `
    const { logout } = require(${JSON.stringify(ROOT + '/auth-service.js')});
    logout().then(res => {
      console.log('RESULT ' + JSON.stringify(res));
    }).catch(e => {
      console.log('THREW ' + (e.code || e.name) + ' ' + e.message);
      process.exit(3);
    });
  `);
  // 凭据目录是空的,clearAll 应正常返回(不再抛错)
  assert.ok(r.stdout.includes('RESULT'), 'ENOENT 应放行走完 logout: ' + r.stdout + r.stderr);
});

test('锁文件读取失败(EISDIR):不得静默放行,要上抛', () => {
  const r = runInStateDir((dir) => {
    // 用目录冒充锁文件,制造 EISDIR(非 ENOENT 的读取失败)
    fs.mkdirSync(path.join(dir, 'watch.lock'));
  }, `
    const { logout } = require(${JSON.stringify(ROOT + '/auth-service.js')});
    logout().then(() => {
      console.log('RESULT-OK-BUT-SHOULD-HAVE-THROWN');
    }).catch(e => {
      console.log('THREW ' + (e.code || e.name));
      process.exit(0);
    });
  `);
  assert.ok(!r.stdout.includes('RESULT-OK-BUT-SHOULD-HAVE-THROWN'),
    'EISDIR 被静默放行了(会在读不到锁的情况下清凭据)');
  assert.ok(r.stdout.includes('THREW'), 'EISDIR 未上抛: ' + r.stdout + r.stderr);
  assert.ok(r.stdout.includes('EISDIR'), '上抛的应是原始 EISDIR: ' + r.stdout);
});
