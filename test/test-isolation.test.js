'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createTestEnv } = require('../scripts/isolated-env');

test('凭据测试忽略外部路径覆盖，外部哨兵保留原内容', { timeout: 20000 }, async () => {
  const sentinel = path.join(process.env.MADMODEL_STATE_DIR, 'external-sentinel.json');
  const text = '{"sentinel":"synthetic-outside-credential"}';
  fs.writeFileSync(sentinel, text);
  const env = createTestEnv(path.join(process.env.MADMODEL_STATE_DIR, 'child'), {
    MADMODEL_CREDS_FILE: sentinel, PROXY_TOKEN_FILE: sentinel, PROXY_UPSTREAM: 'http://127.0.0.1:1', DUMP_FAILED: '1',
  });
  await promisify(execFile)(process.execPath, ['--test', 'test/credential-store.test.js'], {
    cwd: path.resolve(__dirname, '..'), env, timeout: 15000,
  });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), text);
});

test('并发测试实例使用独立钥匙串名称，不继承用户配置', () => {
  process.env.MADMODEL_KEYCHAIN_SERVICE = 'synthetic-external-service';
  process.env.MADMODEL_CREDS_FILE = 'synthetic-external-file';
  try {
    const a = createTestEnv('state-a'), b = createTestEnv('state-b');
    assert.notEqual(a.MADMODEL_KEYCHAIN_SERVICE, b.MADMODEL_KEYCHAIN_SERVICE);
    assert.notEqual(a.MADMODEL_KEYCHAIN_SERVICE, process.env.MADMODEL_KEYCHAIN_SERVICE);
    assert.equal(a.MADMODEL_CREDS_FILE, undefined);
    assert.equal(a.MADMODEL_STATE_DIR, 'state-a');
  } finally {
    delete process.env.MADMODEL_CREDS_FILE;
    delete process.env.MADMODEL_KEYCHAIN_SERVICE;
  }
});
