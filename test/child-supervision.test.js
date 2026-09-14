// test/child-supervision.test.js — 退出形态分类(dashboard 重启策略的依据)。
// 退出码协议:2=需人工(停止重启+等恢复),0+短运行=正常退出,其余=重启策略
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyChildExit } = require('../core/child-supervision');

test('分类: 退出码 2 = 需人工,与运行时长无关', () => {
  assert.strictEqual(classifyChildExit(2, 500), 'needs-human');
  assert.strictEqual(classifyChildExit(2, 3600e3), 'needs-human');
});

test('分类: code 0 且 <30s = 正常退出(不重启)', () => {
  assert.strictEqual(classifyChildExit(0, 100), 'intentional');
  assert.strictEqual(classifyChildExit(0, 29999), 'intentional');
});

test('分类: code 0 但长跑 = 重启策略(非让位形态)', () => {
  assert.strictEqual(classifyChildExit(0, 30000), 'restart');
  assert.strictEqual(classifyChildExit(0, 3600e3), 'restart');
});

test('分类: 崩溃/信号 = 重启策略', () => {
  assert.strictEqual(classifyChildExit(1, 100), 'restart');
  assert.strictEqual(classifyChildExit(null, 100), 'restart'); // 信号终止
  assert.strictEqual(classifyChildExit(3, 3600e3), 'restart');
});
