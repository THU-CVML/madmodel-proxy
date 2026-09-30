// test/model-registry.test.js — 已发现模型清单的运行时可变存放点。
//
// 关键不变式(见 core/model-registry.js 文件头):清单只影响"对外可见",
// 不影响"请求发往哪个模型"——请求注入始终用 config.model。故本测试只钉
// 清单的可见性语义(回退/发布/降级),路由不变式由 http-server 与
// proxy-service 的既有测试覆盖
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createModelRegistry } = require('../core/model-registry');

const CFG = { model: 'Target-Model' };

test('初始状态:回退到 config.model(探测未完成时 /v1/models 不为空)', () => {
  const reg = createModelRegistry(CFG);
  const s = reg.snapshot();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].id, 'Target-Model');
  assert.strictEqual(s[0].ok, null);
});

test('publish:清单被替换为探测结果', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([
    { id: 'A', ok: true, ms: 100, meta: { supportImage: true } },
    { id: 'B', ok: false, reason: 'not-found', ms: 14, meta: null },
  ]);
  const s = reg.snapshot();
  assert.strictEqual(s.length, 2);
  assert.strictEqual(s[0].id, 'A');
  assert.strictEqual(s[1].reason, 'not-found');
});

test('publish:空数组/非数组被忽略,不清空清单', () => {
  // 探测全失败时不该把 /v1/models 变成空表——客户端拉空表会当成服务不可用
  const reg = createModelRegistry(CFG);
  reg.publish([{ id: 'A', ok: true }]);
  reg.publish([]);
  assert.strictEqual(reg.snapshot().length, 1, '空数组不该清空');
  reg.publish(null);
  reg.publish(undefined);
  reg.publish('nope');
  assert.strictEqual(reg.snapshot()[0].id, 'A');
});

test('快照不可变:调用方改不动内部状态', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([{ id: 'A', ok: true }]);
  const s = reg.snapshot();
  assert.ok(Object.isFrozen(s), '数组应冻结');
  assert.ok(Object.isFrozen(s[0]), '条目应冻结');
  assert.throws(() => { s[0].id = 'hacked'; }, TypeError);
});

test('available:只含可用的,排除 not-found/busy', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([
    { id: 'Good', ok: true, ms: 200 },
    { id: 'Gone', ok: false, reason: 'not-found' },
    { id: 'Busy', ok: false, reason: 'busy' },
  ]);
  const av = reg.available();
  assert.deepStrictEqual(av.map(m => m.id), ['Good']);
});

test('available:全不可用时退回目标模型(不给空表)', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([
    { id: 'Target-Model', ok: false, reason: 'busy' },
    { id: 'Gone', ok: false, reason: 'not-found' },
  ]);
  const av = reg.available();
  assert.strictEqual(av.length, 1);
  assert.strictEqual(av[0].id, 'Target-Model', '应退回配置的目标模型');
});

test('available:目标已下线时只推荐其它可用模型', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([{ id: 'Target-Model', ok: false, reason: 'not-found' },
    { id: 'Other-Good', ok: true }]);
  assert.deepStrictEqual(reg.available().map(m => m.id), ['Other-Good']);
});

test('available:目标可用时,不可用的其它模型被滤掉', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([
    { id: 'Gone', ok: false, reason: 'not-found' },
    { id: 'Target-Model', ok: true, ms: 100 },
  ]);
  const av = reg.available();
  assert.deepStrictEqual(av.map(m => m.id), ['Target-Model']);
});

test('available:全不可用且目标模型不在清单里 → 退回清单首项', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([{ id: 'X', ok: false, reason: 'network' }]);
  const av = reg.available();
  assert.strictEqual(av.length, 1);
  assert.strictEqual(av[0].id, 'X');
});

test('深冻结:meta 也不可改(浅冻结会留下改能力标注的缝)', () => {
  const reg = createModelRegistry(CFG);
  reg.publish([{ id: 'A', ok: true, meta: { supportImage: true } }]);
  const s = reg.snapshot();
  assert.ok(Object.isFrozen(s[0].meta), 'meta 应冻结');
  assert.throws(() => { s[0].meta.supportImage = false; }, TypeError);
  // 经 available() 拿到的也不可变(同一批对象)
  assert.throws(() => { reg.available()[0].meta.supportImage = false; }, TypeError);
});
