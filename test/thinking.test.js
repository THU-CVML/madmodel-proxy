// test/thinking.test.js — 思考参数方言翻译(纯函数)。
// 背景见 core/thinking.js 文件头:上游逐模型用不同字段名开思考、且各只接受
// 一组固定档位;1.10.0 的无条件删除导致客户端要的思考被摘掉。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const {
  applyThinking, readThinkingIntent, readRawEffort, nearestEffort, EFFORT_ORDER,
} = require('../core/thinking');

// 与上游 bundle 的 modelList 同形的 meta
const DS = { supportImage: false, thinkingParam: 'thinking', thinkingField: 'reasoning_content', effortOptions: ['low', 'high', 'max'] };
const VISION = { supportImage: true, thinkingParam: 'thinking', thinkingField: 'reasoning_content', effortOptions: ['low', 'medium', 'xhigh'] };
const QWEN = { supportImage: true, thinkingParam: 'enable_thinking', thinkingField: 'reasoning', effortOptions: ['low', 'medium', 'xhigh'] };
const R1 = { supportImage: false, thinkingParam: null, thinkingField: 'content', effortOptions: ['low', 'medium', 'high'] };

// ---- readThinkingIntent ----
test('意图: 无字段 → null(未表态)', () => {
  assert.strictEqual(readThinkingIntent({ messages: [] }), null);
});

test('意图: reasoning_effort=none → 关闭', () => {
  assert.strictEqual(readThinkingIntent({ reasoning_effort: 'none' }), false);
});

test('意图: 任何非空档位字符串 → 开启', () => {
  for (const v of ['low', 'high', 'enabled', 'max', 'banana']) {
    assert.strictEqual(readThinkingIntent({ reasoning_effort: v }), true, v);
  }
});

test('意图: 空串档位不表态', () => {
  assert.strictEqual(readThinkingIntent({ reasoning_effort: '   ' }), null);
});

test('意图: thinking 两种形态 true/false/type', () => {
  assert.strictEqual(readThinkingIntent({ thinking: true }), true);
  assert.strictEqual(readThinkingIntent({ thinking: false }), false);
  assert.strictEqual(readThinkingIntent({ thinking: { type: 'enabled' } }), true);
  assert.strictEqual(readThinkingIntent({ thinking: { type: 'disabled' } }), false);
});

test('意图: enable_thinking 布尔(客户端原生方言)', () => {
  assert.strictEqual(readThinkingIntent({ enable_thinking: true }), true);
  assert.strictEqual(readThinkingIntent({ enable_thinking: false }), false);
});

test('意图: reasoning 布尔', () => {
  assert.strictEqual(readThinkingIntent({ reasoning: true }), true);
  assert.strictEqual(readThinkingIntent({ reasoning: false }), false);
});

test('意图: 原生 chat_template_kwargs 优先级最高', () => {
  // 同时给了相互矛盾的信号时,以客户端已按上游形态写好的 kwargs 为准
  assert.strictEqual(readThinkingIntent({
    chat_template_kwargs: { thinking: false }, reasoning_effort: 'high',
  }), false);
  assert.strictEqual(readThinkingIntent({
    chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'none',
  }), true);
});

test('意图: 关闭信号优先于开启信号(同层)', () => {
  assert.strictEqual(readThinkingIntent({ thinking: false, reasoning_effort: 'high' }), false);
});

test('意图: 非对象/缺省安全返回 null', () => {
  for (const v of [null, undefined, 'str', 42, []]) {
    assert.strictEqual(readThinkingIntent(v), null, String(v));
  }
});

// ---- readRawEffort ----
test('原始档位: 仅字符串算档位,布尔不算', () => {
  assert.strictEqual(readRawEffort({ reasoning_effort: 'high' }), 'high');
  assert.strictEqual(readRawEffort({ reasoning_effort: true }), null);
  assert.strictEqual(readRawEffort({ reasoning_effort: '' }), null);
  assert.strictEqual(readRawEffort({}), null);
});

// ---- nearestEffort ----
test('就近落档: 精确命中原样返回', () => {
  for (const v of ['low', 'high', 'max']) assert.strictEqual(nearestEffort(v, DS.effortOptions), v);
});

test('就近落档: 同义词收敛', () => {
  assert.strictEqual(nearestEffort('minimal', DS.effortOptions), 'low');
  assert.strictEqual(nearestEffort('maximum', DS.effortOptions), 'max');
  assert.strictEqual(nearestEffort('MID', QWEN.effortOptions), 'medium');
});

test('就近落档: 越档向上补,不向下贬', () => {
  // 档位是"思考强度"的用户意图:要 high 却给 medium 等于降级。
  // Vision-Exp 无 high → 应给 xhigh(向上),而不是 medium(向下)
  assert.strictEqual(nearestEffort('high', VISION.effortOptions), 'xhigh');
  // qwen 无 max → xhigh(向上;xhigh 已是它最高档)
  assert.strictEqual(nearestEffort('max', QWEN.effortOptions), 'xhigh');
  // R1 无 xhigh/max → high 是它最高可用档
  assert.strictEqual(nearestEffort('max', R1.effortOptions), 'high');
});

test('就近落档: 目标已是该模型最高档时原样', () => {
  assert.strictEqual(nearestEffort('max', DS.effortOptions), 'max');
  assert.strictEqual(nearestEffort('xhigh', QWEN.effortOptions), 'xhigh');
});

test('就近落档: 无法识别的值返回 null(不原样透传)', () => {
  for (const v of ['banana', 'enabled', '']) {
    assert.strictEqual(nearestEffort(v, DS.effortOptions), null, v);
  }
});

test('就近落档: 档位表为空 → null', () => {
  assert.strictEqual(nearestEffort('high', []), null);
  assert.strictEqual(nearestEffort('high', null), null);
  assert.strictEqual(nearestEffort('high', undefined), null);
});

test('就近落档: 非字符串 → null', () => {
  for (const v of [true, 42, null, {}, []]) {
    assert.strictEqual(nearestEffort(v, DS.effortOptions), null, JSON.stringify(v));
  }
});

// ---- applyThinking: 开关落地 ----
test('翻译: 开关按该模型字段名落到 chat_template_kwargs', () => {
  const a = {};
  const applied = applyThinking(a, VISION);
  assert.deepStrictEqual(a.chat_template_kwargs, { thinking: true });
  assert.ok(applied.includes('thinking=true'));

  const b = {};
  applyThinking(b, QWEN);
  assert.deepStrictEqual(b.chat_template_kwargs, { enable_thinking: true });
});

test('翻译: 关闭写在同一个字段名上', () => {
  const a = { reasoning_effort: 'none' };
  applyThinking(a, QWEN);
  assert.deepStrictEqual(a.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!('reasoning_effort' in a), '关闭时不得发档位');
});

test('翻译: 档位仅开启时发,且落在 effortOptions 内', () => {
  const a = { reasoning_effort: 'high' };
  applyThinking(a, DS);
  assert.strictEqual(a.reasoning_effort, 'high');

  const b = { reasoning_effort: 'none' };
  applyThinking(b, DS);
  assert.ok(!('reasoning_effort' in b));
});

test('翻译: 未给档位时用该模型首档', () => {
  const a = {};
  applyThinking(a, DS);
  assert.strictEqual(a.reasoning_effort, 'low');
});

test('翻译: 不存在的模型字段被摘除(不原样发上游)', () => {
  const a = { thinking: true, enable_thinking: true, reasoning: true, reasoning_effort: 'high' };
  const applied = applyThinking(a, DS);
  assert.ok(!('thinking' in a) && !('enable_thinking' in a) && !('reasoning' in a));
  assert.ok(applied.filter(n => n.startsWith('-')).length === 4);
  // 但开关意图被保留下来,翻译成该模型的字段
  assert.deepStrictEqual(a.chat_template_kwargs, { thinking: true });
});

test('翻译: 已知不可开关模型(thinkingParam=null)不注入任何开关', () => {
  // R1-W8A8 是推理模型,思考由上游决定,客户端无从开关。
  // 注入 thinking:false 是没依据的猜测,故一律不发
  for (const a of [{ reasoning_effort: 'high' }, { reasoning_effort: 'none' }, {}]) {
    const p = { ...a };
    const applied = applyThinking(p, R1);
    assert.ok(!('chat_template_kwargs' in p), `不得注入: ${JSON.stringify(a)}`);
    assert.strictEqual(p.reasoning_effort, a.reasoning_effort === 'none' ? undefined : a.reasoning_effort || 'low');
    assert.ok(applied.includes('-reasoning_effort') === ('reasoning_effort' in a));
  }
});

test('翻译: meta 为 null/缺 thinkingParam → 保守路径', () => {
  // 能力未知:不注入开关(乱猜字段名比不改更危险),仅明确要关时发通用 false
  for (const meta of [null, undefined, {}, { effortOptions: ['low'] }]) {
    const a = { reasoning_effort: 'high' };
    applyThinking(a, meta);
    assert.ok(!('chat_template_kwargs' in a), JSON.stringify(meta));
    assert.ok(!('reasoning_effort' in a));

    const b = { reasoning_effort: 'none' };
    applyThinking(b, meta);
    assert.deepStrictEqual(b.chat_template_kwargs, { thinking: false }, JSON.stringify(meta));
  }
});

test('翻译: 保留调用方已有的 kwargs 其它键', () => {
  const a = { chat_template_kwargs: { custom: 7 }, reasoning_effort: 'none' };
  applyThinking(a, DS);
  assert.deepStrictEqual(a.chat_template_kwargs, { custom: 7, thinking: false });
});

test('翻译: 摘掉 kwargs 里另一方言的思考键(不原样发上游)', () => {
  // 客户端按 vLLM 通用方言发 thinking,目标是 qwen(enable_thinking)
  const a = { chat_template_kwargs: { thinking: true } };
  applyThinking(a, QWEN);
  assert.deepStrictEqual(a.chat_template_kwargs, { enable_thinking: true });

  // 反向:客户端发 enable_thinking,目标是 DS(thinking)
  const b = { chat_template_kwargs: { enable_thinking: true } };
  applyThinking(b, DS);
  assert.deepStrictEqual(b.chat_template_kwargs, { thinking: true });
});

test('翻译: 摘外来思考键时保留非思考的模板参数', () => {
  const a = { chat_template_kwargs: { thinking: true, custom: 'keep-me' } };
  applyThinking(a, QWEN);
  assert.deepStrictEqual(a.chat_template_kwargs, { custom: 'keep-me', enable_thinking: true });
});

test('翻译: 不可开关模型的 kwargs 思考键一律摘除', () => {
  for (const kwargs of [{ thinking: true }, { enable_thinking: true }, { thinking: false, custom: 1 }]) {
    const a = { chat_template_kwargs: { ...kwargs } };
    applyThinking(a, R1);
    const keys = Object.keys(a.chat_template_kwargs || {});
    assert.ok(!keys.includes('thinking') && !keys.includes('enable_thinking'),
      `残留思考键: ${JSON.stringify(a.chat_template_kwargs)}`);
  }
});

test('翻译: effortOptions 非数组时视为空(不发档位,不抛)', () => {
  const a = {};
  applyThinking(a, { thinkingParam: 'thinking', effortOptions: 'oops' });
  assert.deepStrictEqual(a.chat_template_kwargs, { thinking: true });
  assert.ok(!('reasoning_effort' in a));
});

test('翻译: 非对象 payload 安全返回空数组', () => {
  for (const v of [null, undefined, 'str', 42]) {
    assert.deepStrictEqual(applyThinking(v, DS), []);
  }
});

test('档位序: EFFORT_ORDER 覆盖上游全部 canonical 值', () => {
  // 上游四模型的 effortOptions 并集必须都在序里,否则就近落档会算错
  const all = new Set([...DS.effortOptions, ...VISION.effortOptions, ...QWEN.effortOptions, ...R1.effortOptions]);
  for (const v of all) assert.ok(EFFORT_ORDER.includes(v), v);
});
