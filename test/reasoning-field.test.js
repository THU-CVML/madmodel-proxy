// test/reasoning-field.test.js — 响应方向:思考字段名归一(reasoning → reasoning_content)。
// 背景:上游逐模型用不同字段名吐思考(qwen 是 `reasoning`,DeepSeek 系是
// `reasoning_content`),而客户端只认 `reasoning_content`。不归一的话 qwen 的思考
// 抵达客户端后被静默丢弃——表现为"用 qwen 时全程看不到思考,换 DeepSeek 就正常"。
// 2026-09-29 实测:最近 60 条 reasoning 记录里 DeepSeek 59 条、qwen 0 条;
// 抓上游原始 SSE 帧确认 qwen 的思考确实在流里(delta 键 = role,content,reasoning)。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const { normalizeReasoningDelta, normalizeCompletionReasoning, readReasoningDelta, reasoningFieldsFor, REASONING_FIELDS } = require('../core/thinking');
const { createAggregator } = require('../core/completion-aggregator');

function frame(delta) {
  return { id: 'x', model: 'm', choices: [{ index: 0, delta, finish_reason: null }] };
}

// ---- normalizeReasoningDelta(流式出口) ----
test('归一: qwen 的 reasoning → reasoning_content', () => {
  const f = frame({ reasoning: '让我想想' });
  assert.strictEqual(normalizeReasoningDelta(f), true);
  assert.strictEqual(f.choices[0].delta.reasoning_content, '让我想想');
  assert.ok(!('reasoning' in f.choices[0].delta), '方言名必须收掉,不能留两份');
});

test('归一: 已是 reasoning_content 的帧不动(高频路径不做无谓改动)', () => {
  const f = frame({ reasoning_content: 'DeepSeek 的思考' });
  assert.strictEqual(normalizeReasoningDelta(f), false);
  assert.strictEqual(f.choices[0].delta.reasoning_content, 'DeepSeek 的思考');
});

test('归一: 两键不同也按读取优先级选取，与聚合路径一致', () => {
  const f = frame({ reasoning_content: 'AA', reasoning: 'BB' });
  assert.strictEqual(normalizeReasoningDelta(f), true);
  assert.strictEqual(f.choices[0].delta.reasoning_content, 'AA');
  assert.ok(!('reasoning' in f.choices[0].delta));
});

test('归一: 流式、JSON 和聚合都只交付一份别名内容，保留跨帧重复', () => {
  for (const alias of ['reasoning', 'reasoning_v2']) {
    const agg = createAggregator('m', alias);
    let streamed = '';
    for (const text of ['用户', '用户', '问的是']) {
      const f = frame({ content: '', reasoning_content: text, [alias]: text });
      agg.feed(JSON.parse(JSON.stringify(f)));
      normalizeReasoningDelta(f, alias);
      streamed += f.choices[0].delta.reasoning_content;
      assert.ok(!(alias in f.choices[0].delta));
    }
    const b = completion({ content: '正文', reasoning_content: '用户用户问的是', [alias]: '用户用户问的是' });
    normalizeCompletionReasoning(b, alias);
    assert.strictEqual(streamed, '用户用户问的是');
    assert.strictEqual(b.choices[0].message.reasoning_content, streamed);
    assert.strictEqual(agg.result().choices[0].message.reasoning_content, streamed);
    assert.strictEqual(b.choices[0].message.content, '正文');
  }
});

test('归一: 标准字段为空时，流式与 JSON 都回落到非空别名', () => {
  const f = frame({ reasoning_content: '', reasoning: '思考' });
  const b = completion({ reasoning_content: null, reasoning: '思考' });
  normalizeReasoningDelta(f);
  normalizeCompletionReasoning(b);
  assert.strictEqual(f.choices[0].delta.reasoning_content, '思考');
  assert.strictEqual(b.choices[0].message.reasoning_content, '思考');
});

test('归一: reasoning=null(思考段结束)收掉方言键,且不造空 reasoning_content', () => {
  // 空内容不写键:否则同一帧在流式(造键)与非流式聚合(不造键)两条路径上
  // 交付面不一致,且部分客户端以"见到该键"为思考块开始、会渲染空折叠块
  const f = frame({ reasoning: null });
  assert.strictEqual(normalizeReasoningDelta(f), true);
  assert.ok(!('reasoning' in f.choices[0].delta));
  assert.ok(!('reasoning_content' in f.choices[0].delta), '空内容不应造键');
});

test('归一: reasoning 为空串时同样不造键', () => {
  const f = frame({ reasoning: '' });
  assert.strictEqual(normalizeReasoningDelta(f), true);
  assert.ok(!('reasoning' in f.choices[0].delta));
  assert.ok(!('reasoning_content' in f.choices[0].delta));
});

test('归一: 已有 reasoning_content 的键在方言键为空时不被删掉', () => {
  // 上游可能先给内容、后用 `reasoning:null` 结束;此时不能把已有内容清空
  const f = frame({ reasoning_content: '已有内容', reasoning: null });
  assert.strictEqual(normalizeReasoningDelta(f), true);
  assert.strictEqual(f.choices[0].delta.reasoning_content, '已有内容');
  assert.ok(!('reasoning' in f.choices[0].delta));
});

test('归一: 纯 content 帧不受影响', () => {
  const f = frame({ content: '正文' });
  assert.strictEqual(normalizeReasoningDelta(f), false);
  assert.deepStrictEqual(f.choices[0].delta, { content: '正文' });
});

test('归一: tool_calls 帧不受影响', () => {
  const f = frame({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{}' } }] });
  assert.strictEqual(normalizeReasoningDelta(f), false);
  assert.ok(!('reasoning_content' in f.choices[0].delta));
});

test('归一: 畸形帧安全返回 false(无 choices / 无 delta / null)', () => {
  for (const v of [null, undefined, {}, { choices: [] }, { choices: [{ index: 0 }] },
    { choices: [{ delta: null }] }, { choices: [{ delta: 'str' }] }, frame(null)]) {
    assert.strictEqual(normalizeReasoningDelta(v), false);
  }
});

test('归一: 就地改的是同一个对象(调用方依赖这个语义)', () => {
  const f = frame({ reasoning: 'x' });
  const ch = f.choices[0];
  normalizeReasoningDelta(f);
  assert.strictEqual(ch, f.choices[0]);
});

test('归一: 幂等(同一帧过两遍结果一致)', () => {
  const f = frame({ reasoning: 'abcd' });
  normalizeReasoningDelta(f);
  const once = JSON.stringify(f);
  assert.strictEqual(normalizeReasoningDelta(f), false, '第二遍不应再改');
  assert.strictEqual(JSON.stringify(f), once);
});

// ---- readReasoningDelta:两条路径共用同一份字段清单 ----
test('读: qwen 方言与 DeepSeek 名都能读到', () => {
  assert.strictEqual(readReasoningDelta({ reasoning: 'a' }), 'a');
  assert.strictEqual(readReasoningDelta({ reasoning_content: 'b' }), 'b');
});

test('读: 无思考字段 → null(区分"没有"与"空串")', () => {
  assert.strictEqual(readReasoningDelta({ content: 'x' }), null);
  assert.strictEqual(readReasoningDelta({}), null);
  assert.strictEqual(readReasoningDelta(null), null);
  assert.strictEqual(readReasoningDelta('str'), null);
});

test('读: 空串不算思考内容(上游用空串表示段落切换)', () => {
  assert.strictEqual(readReasoningDelta({ reasoning: '' }), null);
});

test('读: reasoning_content 优先于 reasoning(与归一化同序)', () => {
  assert.strictEqual(readReasoningDelta({ reasoning_content: 'A', reasoning: 'B' }), 'A');
});

test('字段清单: 交付名排第一,方言名在后', () => {
  assert.strictEqual(REASONING_FIELDS[0], 'reasoning_content');
  assert.ok(REASONING_FIELDS.includes('reasoning'));
  assert.ok(!REASONING_FIELDS.includes('content'), 'R1 把思考写进 content 是正常形态,不能当字段分歧归一');
});

// ---- thinkingField 元数据接入(权威来源,不是写死的清单) ----
// 本 bug 的成因正是"只认一个写死的字段名"。权威来源是逐模型的
// meta.thinkingField(config.js 的 thinkingFallback 与上游 bundle 解析结果),
// 调用方能拿到时就该用它,这样上游换名字/加模型不必改代码
test('fields: 传入 thinkingField 时也认它(上游换名不用改代码)', () => {
  const f = frame({ reasoning_v2: '新方言' });
  assert.strictEqual(normalizeReasoningDelta(f, 'reasoning_v2'), true);
  assert.strictEqual(f.choices[0].delta.reasoning_content, '新方言');
  assert.ok(!('reasoning_v2' in f.choices[0].delta));
});

test('fields: 交付名始终优先,不被 thinkingField 挤掉', () => {
  // 若某模型的 thinkingField 恰好是方言名,reasoning_content 仍要能被读到
  const list = reasoningFieldsFor('reasoning');
  assert.strictEqual(list[0], 'reasoning_content');
  assert.ok(list.includes('reasoning'));
});

test('fields: content 永远不入清单(避免把 R1 正文当思考)', () => {
  // R1 的 thinkingField 就是 content——它是"思考写在正文里"的正常形态,
  // 若把它当方言归一,正文会被搬进 reasoning_content 并从 content 消失
  for (const list of [reasoningFieldsFor('content'), reasoningFieldsFor(['content', 'reasoning'])]) {
    assert.ok(!list.includes('content'));
  }
  const f = frame({ content: '正文', reasoning: '思考' });
  normalizeReasoningDelta(f, 'content');
  assert.strictEqual(f.choices[0].delta.content, '正文', '正文必须留在 content');
  assert.strictEqual(f.choices[0].delta.reasoning_content, '思考');
});

test('fields: 非法/空 fields 安全退回已知清单', () => {
  for (const bad of [null, undefined, '', [], 42, {}]) {
    assert.deepStrictEqual(reasoningFieldsFor(bad), REASONING_FIELDS);
  }
});

test('fields: 只删清单内的键,不动上游其他字段', () => {
  const f = frame({ reasoning: 'r', content: '正文', tool_calls: [{ index: 0, id: 'c' }] });
  normalizeReasoningDelta(f, 'reasoning');
  const d = f.choices[0].delta;
  assert.ok(!('reasoning' in d));
  assert.strictEqual(d.content, '正文');
  assert.ok(Array.isArray(d.tool_calls), '工具调用帧不能被误删');
});

test('读: 传入 thinkingField 同样生效', () => {
  assert.strictEqual(readReasoningDelta({ reasoning_v2: 'x' }, 'reasoning_v2'), 'x');
  assert.strictEqual(readReasoningDelta({ reasoning: 'y' }, 'reasoning_v2'), 'y', '已知清单仍兜底');
});

// ---- 聚合器(非流式路径):qwen 的 reasoning 必须进 message ----
test('聚合: qwen 方言的思考进入 reasoning_content', () => {
  const agg = createAggregator('qwen3.8-27b');
  agg.feed(frame({ role: 'assistant', content: '' }));
  agg.feed(frame({ reasoning: '思考' }));
  agg.feed(frame({ reasoning: '过程' }));
  agg.feed(frame({ content: '答案', reasoning: null }));
  agg.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  const res = agg.result();
  assert.strictEqual(res.choices[0].message.reasoning_content, '思考过程');
  assert.strictEqual(res.choices[0].message.content, '答案');
});

test('聚合: DeepSeek 方言行为不变(不回归)', () => {
  const agg = createAggregator('DeepSeek-V4.1-Flash');
  agg.feed(frame({ reasoning_content: 'DS 思考' }));
  agg.feed(frame({ content: 'DS 正文' }));
  const res = agg.result();
  assert.strictEqual(res.choices[0].message.reasoning_content, 'DS 思考');
  assert.strictEqual(res.choices[0].message.content, 'DS 正文');
});

test('聚合: 完全没有思考时不出 reasoning_content 键', () => {
  const agg = createAggregator('m');
  agg.feed(frame({ content: '只有正文' }));
  const res = agg.result();
  assert.ok(!('reasoning_content' in res.choices[0].message));
});

test('聚合: 交付名只有 reasoning_content 一个(不重复渲染)', () => {
  const agg = createAggregator('qwen3.8-27b');
  agg.feed(frame({ reasoning: 'x' }));
  const m = agg.result().choices[0].message;
  assert.strictEqual(m.reasoning_content, 'x');
  assert.ok(!('reasoning' in m), '聚合结果里不能出现上游方言名');
});

test('聚合: 工具调用帧仍被正确累积(未被本次改动影响)', () => {
  const agg = createAggregator('m');
  agg.feed(frame({ reasoning: 'r' }));
  agg.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"c' } }] }, finish_reason: null }] });
  agg.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'md":"ls"}' } }] }, finish_reason: null }] });
  agg.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  const m = agg.result().choices[0].message;
  assert.strictEqual(m.tool_calls.length, 1);
  assert.strictEqual(m.tool_calls[0].function.name, 'Bash');
  assert.strictEqual(m.tool_calls[0].function.arguments, '{"cmd":"ls"}');
  assert.strictEqual(m.reasoning_content, 'r');
});

test('聚合: 传入模型的 thinkingField 时按它收(权威字段优先于硬编码清单)', () => {
  // 模拟上游新增/改名方言:只有把模型的能力元数据接进来才不会静默丢思考
  const agg = createAggregator('future-model', 'reasoning_v2');
  agg.feed(frame({ reasoning_v2: '新方言思考' }));
  agg.feed(frame({ content: '正文' }));
  const m = agg.result().choices[0].message;
  assert.strictEqual(m.reasoning_content, '新方言思考');
  assert.strictEqual(m.content, '正文');
});

test('聚合: thinkingField 为 content(R1 形态)时不把正文当思考', () => {
  const agg = createAggregator('DeepSeek-R1-W8A8', 'content');
  agg.feed(frame({ content: '这是推理正文' }));
  const m = agg.result().choices[0].message;
  assert.strictEqual(m.content, '这是推理正文');
  assert.ok(!('reasoning_content' in m), 'content 不能既当正文又当思考');
});

// ---- normalizeCompletionReasoning(message 形态,第三种帧形态) ----
// 上游对**非流式**请求直接回完整 JSON completion,代理原样 sendJson 交付。
// 这条路径原先完全不做归一 ⇒ qwen 的 reasoning 原封不动发给客户端被丢弃
function completion(msg) {
  return { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: msg, finish_reason: 'stop' }] };
}

test('completion: qwen 的 reasoning 归一为 reasoning_content', () => {
  const b = completion({ role: 'assistant', content: '正文', reasoning: '思考' });
  assert.strictEqual(normalizeCompletionReasoning(b), true);
  const m = b.choices[0].message;
  assert.strictEqual(m.reasoning_content, '思考');
  assert.ok(!('reasoning' in m));
  assert.strictEqual(m.content, '正文');
});

test('completion: DeepSeek 形态不动(不回归)', () => {
  const b = completion({ role: 'assistant', content: 'C', reasoning_content: 'R' });
  assert.strictEqual(normalizeCompletionReasoning(b), false);
  assert.strictEqual(b.choices[0].message.reasoning_content, 'R');
});

test('completion: 传入 thinkingField 时按它认', () => {
  const b = completion({ role: 'assistant', content: 'C', reasoning_v9: 'R9' });
  assert.strictEqual(normalizeCompletionReasoning(b, 'reasoning_v9'), true);
  assert.strictEqual(b.choices[0].message.reasoning_content, 'R9');
  assert.ok(!('reasoning_v9' in b.choices[0].message));
});

test('completion: reasoning=null 收掉方言键,且不造空键', () => {
  const b = completion({ role: 'assistant', content: 'C', reasoning: null });
  assert.strictEqual(normalizeCompletionReasoning(b), true);
  assert.ok(!('reasoning' in b.choices[0].message));
  assert.ok(!('reasoning_content' in b.choices[0].message), '空内容不应造键');
});

test('completion: 无思考字段时不动', () => {
  const b = completion({ role: 'assistant', content: 'C' });
  assert.strictEqual(normalizeCompletionReasoning(b), false);
  assert.ok(!('reasoning_content' in b.choices[0].message));
});

test('completion: 畸形 body 安全返回 false', () => {
  for (const bad of [null, undefined, {}, { choices: [] }, { choices: [{}] },
    { choices: [{ message: null }] }, { choices: [{ message: 'str' }] }]) {
    assert.strictEqual(normalizeCompletionReasoning(bad), false);
  }
});

test('completion: 工具调用不受影响', () => {
  const b = completion({ role: 'assistant', content: null, reasoning: 'r',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] });
  normalizeCompletionReasoning(b);
  const m = b.choices[0].message;
  assert.strictEqual(m.reasoning_content, 'r');
  assert.strictEqual(m.tool_calls.length, 1);
});
