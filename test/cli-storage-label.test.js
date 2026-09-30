// test/cli-storage-label.test.js — 登录回执里的平台存储提示。
//
// 这行字是用户对"密码存哪了"的唯一认知来源(cli.js cmdLogin 的回执)。此前它
// 无条件写"仅当前 Windows 账户可解密",在 macOS(钥匙串)/Linux(机器绑定
// AES-256-GCM)上属于事实错误的安全承诺。钉住三平台文案,并确认 Windows 文案
// 与修复前逐字相同(平台提示的其余文字不在本测试的管辖内)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { storageLabel } = require('../adapters/cli');

test('storageLabel:三平台各给准确的一句话', () => {
  assert.strictEqual(storageLabel('win32'), '密码由 Windows DPAPI 按当前账户加密');
  assert.strictEqual(storageLabel('darwin'), '密码存于当前用户登录钥匙串');
  assert.strictEqual(storageLabel('linux'), '密码按本机标识与 Linux 用户信息加密，主要依赖文件权限保护');
});

test('storageLabel:未知平台落到 Linux 措辞(不作新承诺)', () => {
  // 非三平台之一(如 freebsd)走兜底分支;文案只说"当前用户和本机",
  // 与机器绑定加密的实际语义最接近,不给未知平台编造新承诺
  assert.strictEqual(storageLabel('freebsd'), '密码按本机标识与 Linux 用户信息加密，主要依赖文件权限保护');
});

test('storageLabel:与各平台实际实现对应(win=DPAPI,mac=钥匙串,linux=机器绑定)', () => {
  // 文案里的关键词必须与 platform/credentials.js 的实现语义对得上:
  // win32 → DPAPI(当前 Windows 账户);darwin → 登录钥匙串;linux → 机器绑定
  const labels = {
    win32: storageLabel('win32'),
    darwin: storageLabel('darwin'),
    linux: storageLabel('linux'),
  };
  assert.ok(labels.win32.includes('DPAPI'));
  assert.ok(labels.darwin.includes('钥匙串'));
  assert.ok(labels.linux.includes('Linux 用户') && labels.linux.includes('本机'));
});
