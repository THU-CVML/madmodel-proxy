'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const isOverride = key => /^(MADMODEL_|PROXY_|DUMP_FAILED$)/i.test(key);

// 测试只能继承通用系统环境，凭据路径、钥匙串和上游由自己的夹具决定。
function createTestEnv(stateDir, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isOverride(key)));
  return { ...env, MADMODEL_STATE_DIR: stateDir,
    MADMODEL_KEYCHAIN_SERVICE: `madmodel-test-${randomUUID()}`,
    PROXY_NO_UPDATE_CHECK: '1', ...overrides };
}

function applyTestEnv(env) {
  for (const key of Object.keys(process.env)) if (isOverride(key)) delete process.env[key];
  Object.assign(process.env, env);
}

let isolated = false;
function isolate() {
  if (isolated) return;
  isolated = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madmodel-unit-'));
  applyTestEnv(createTestEnv(dir));
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时文件被占用 */ }
  });
}

module.exports = { createTestEnv, applyTestEnv, isolate };
