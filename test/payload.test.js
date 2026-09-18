// test/payload.test.js — 请求解析与归一化(纯函数)。
// 与真实流量冒烟的分工:这里只测纯逻辑边界,协议行为靠 smoke-real.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseJsonBody, normalizePayload, fitTokenBudget, checkContentSupport } = require('../core/payload');

const MODEL = 'DeepSeek-V4-Flash-0731';

// ---- parseJsonBody ----
test('parseJsonBody: 合法 JSON 对象返回原对象', () => {
  const p = parseJsonBody(Buffer.from('{"a":1}'));
  assert.deepStrictEqual(p, { a: 1 });
});

test('parseJsonBody: 非 JSON 抛 INVALID_JSON', () => {
  assert.throws(() => parseJsonBody(Buffer.from('not json')), e => e.code === 'INVALID_JSON');
});

test('parseJsonBody: 数组/null/标量抛 INVALID_PAYLOAD', () => {
  for (const raw of ['[1,2]', 'null', '42', '"str"']) {
    assert.throws(() => parseJsonBody(Buffer.from(raw)), e => e.code === 'INVALID_PAYLOAD');
  }
});

// ---- normalizePayload: 模型名 ----
test('归一化: 任意 model 重写为注入模型并记录原值', () => {
  const p = { model: 'gpt-4o', messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.model, MODEL);
  assert.ok(applied.includes('model=gpt-4o'));
});

test('归一化: model 缺省时静默注入,不产生 model= 记录', () => {
  const p = { messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.model, MODEL);
  assert.ok(!applied.some(n => n.startsWith('model=')));
});

test('归一化: 已是目标模型时不产生任何 model 记录', () => {
  const p = { model: MODEL, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(applied.length, 0);
});

// ---- normalizePayload: 上游拒绝参数 ----
test('归一化: logprobs/top_logprobs 剥离并记录', () => {
  const p = { model: MODEL, logprobs: true, top_logprobs: 5, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.ok(!('logprobs' in p) && !('top_logprobs' in p));
  assert.ok(applied.includes('-logprobs') && applied.includes('-top_logprobs'));
});

test('归一化: n>1 剥离, n=1 保留', () => {
  const a = { model: MODEL, n: 3, messages: [] };
  normalizePayload(a, MODEL);
  assert.ok(!('n' in a));
  const b = { model: MODEL, n: 1, messages: [] };
  normalizePayload(b, MODEL);
  assert.strictEqual(b.n, 1);
});

// ---- normalizePayload: max_tokens 区间 [512, 65536] ----
test('max_tokens: 思考开启(默认)时 <512 抬到 512', () => {
  const p = { model: MODEL, max_tokens: 16, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 512);
  assert.ok(applied.includes('max_tokens→512'));
});

test('max_tokens: 显式关闭思考的三种方言均不抬升', () => {
  for (const noThinking of [
    { reasoning_effort: 'none' },
    { thinking: false },
    { thinking: { type: 'disabled' } },
  ]) {
    const p = { model: MODEL, max_tokens: 16, messages: [], ...noThinking };
    const applied = normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, 16, JSON.stringify(noThinking));
    assert.ok(!applied.includes('max_tokens→512'), JSON.stringify(noThinking));
  }
});

test('max_tokens: >65536 压回 65536(思考开/关两态)', () => {
  for (const extra of [{}, { reasoning_effort: 'none' }]) {
    const p = { model: MODEL, max_tokens: 384000, messages: [], ...extra };
    const applied = normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, 65536);
    assert.ok(applied.includes('max_tokens→65536'));
  }
});

test('max_tokens: 缺省时不注入任何值', () => {
  const p = { model: MODEL, messages: [] };
  normalizePayload(p, MODEL);
  assert.ok(!('max_tokens' in p));
});

// ---- normalizePayload: max_completion_tokens(新版 OpenAI 客户端方言) ----
test('max_completion_tokens: 映射为 max_tokens 并接受区间约束(两方向)', () => {
  const big = { model: MODEL, max_completion_tokens: 384000, messages: [] };
  const appliedBig = normalizePayload(big, MODEL);
  assert.strictEqual(big.max_tokens, 65536);
  assert.ok(!('max_completion_tokens' in big));
  assert.ok(appliedBig.includes('max_completion_tokens→max_tokens') && appliedBig.includes('max_tokens→65536'));

  const small = { model: MODEL, max_completion_tokens: 16, messages: [] };
  normalizePayload(small, MODEL);
  assert.strictEqual(small.max_tokens, 512);
});

test('max_completion_tokens: 思考关闭时不抬升,原值映射', () => {
  const p = { model: MODEL, max_completion_tokens: 16, reasoning_effort: 'none', messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.ok(!('max_completion_tokens' in p));
});

test('max_completion_tokens: 两键并存时以新键为准', () => {
  const p = { model: MODEL, max_completion_tokens: 2000, max_tokens: 9000, messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 2000);
  assert.ok(!('max_completion_tokens' in p));
});

test('max_tokens: 512-65536 区间内原样保留', () => {
  for (const mt of [512, 4096, 65536]) {
    const p = { model: MODEL, max_tokens: mt, messages: [] };
    normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, mt);
  }
});

// ---- normalizePayload: 关闭思考的方言映射 ----
test('思考方言: reasoning_effort=none → chat_template_kwargs.thinking=false 且原键剥离', () => {
  const p = { model: MODEL, reasoning_effort: 'none', messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
  assert.ok(!('reasoning_effort' in p));
  assert.ok(applied.includes('thinking=false') && applied.includes('-reasoning_effort'));
});

test('思考方言: 非关闭档(如 high)剥离但绝不注入', () => {
  const p = { model: MODEL, reasoning_effort: 'high', messages: [] };
  normalizePayload(p, MODEL);
  assert.ok(!('reasoning_effort' in p));
  assert.ok(!('chat_template_kwargs' in p));
});

test('思考方言: 已有 chat_template_kwargs 被合并保留', () => {
  const p = { model: MODEL, thinking: false, chat_template_kwargs: { custom: 1 }, messages: [] };
  normalizePayload(p, MODEL);
  assert.deepStrictEqual(p.chat_template_kwargs, { custom: 1, thinking: false });
});

test('思考方言: chat_template_kwargs 为数组时整体替换', () => {
  const p = { model: MODEL, thinking: false, chat_template_kwargs: [1, 2], messages: [] };
  normalizePayload(p, MODEL);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
});

// ---- fitTokenBudget:预检门的精确收缩(上游规则 prompt+max_tokens ≤ 262,144) ----
test('预算适配: 未超限不改不注记', () => {
  const p = { max_tokens: 4096 };
  const r = fitTokenBudget(100000, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.note, '');
  assert.strictEqual(p.max_tokens, 4096);
});

test('预算适配: 超限收缩到剩余空间', () => {
  const p = { max_tokens: 65536 };
  const r = fitTokenBudget(230000, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 32144);
  assert.ok(r.note.includes('32144'));
});

test('预算适配: 恰等于上限不动', () => {
  const p = { max_tokens: 65536 };
  const r = fitTokenBudget(196608, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 65536);
  assert.strictEqual(r.note, '');
});

test('预算适配: 剩余空间 <512 判 413(prompt 本身超限)', () => {
  const p = { max_tokens: 65536 };
  const r = fitTokenBudget(262000, p, 262144);
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('262000'));
  assert.ok(r.message.includes('512'));
});

test('预算适配: max_tokens 缺省且 prompt 未超限 → 不注入不收缩', () => {
  const p = {};
  const r = fitTokenBudget(200000, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.note, '');
  assert.strictEqual(p.max_tokens, undefined);
});

test('预算适配: max_tokens 缺省但 prompt 本身超限 → 413', () => {
  const p = {};
  const r = fitTokenBudget(263000, p, 262144);
  assert.strictEqual(r.ok, false);
});

// ---- checkContentSupport:图片/多模态输入预检(1.9.2,R1) ----
// 上游对含 image_url 的请求 0.1~0.2s 秒拒并伪装成"服务器繁忙"(四组对照实测),
// 含图历史每轮重发 → 会话永久失败。本预检把判定收窄到 content 数组里的段类型
test('图片预检: 纯文本消息(string content)通过', () => {
  const p = { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }] };
  assert.strictEqual(checkContentSupport(p, MODEL).ok, true);
});

test('图片预检: content 数组只有 text 段通过', () => {
  const p = { messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] };
  const r = checkContentSupport(p, MODEL);
  assert.strictEqual(r.ok, true);
});

test('图片预检: content 数组含 image_url 段拒绝', () => {
  const p = { messages: [{ role: 'user', content: [
    { type: 'text', text: '这是什么' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
  ] }] };
  const r = checkContentSupport(p, MODEL);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.type, 'image_url');
  assert.strictEqual(r.index, 0);
});

test('图片预检: 图片在历史深处(非末条)也拒绝,错误指向该条', () => {
  const p = { messages: [
    { role: 'user', content: '开头' },
    { role: 'assistant', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
    { role: 'user', content: '继续' },
  ] };
  const r = checkContentSupport(p, MODEL);
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('第 2 条消息'), r.message);
});

test('图片预检: 错误文案含事实与处置建议(维护者定稿)', () => {
  const p = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] };
  const r = checkContentSupport(p, MODEL);
  assert.ok(r.message.includes('图片'), r.message);
  assert.ok(r.message.includes('新开一个会话'), r.message);
  assert.ok(r.message.includes('重试无效'), r.message);
});

test('图片预检: 其他多模态段(input_audio/file)同样拒绝', () => {
  for (const type of ['input_audio', 'file', 'audio_url']) {
    const p = { messages: [{ role: 'user', content: [{ type, [type]: {} }] }] };
    const r = checkContentSupport(p, MODEL);
    assert.strictEqual(r.ok, false, type);
    assert.strictEqual(r.type, type);
  }
});

// 判定边界(防误伤):以下形态属合法请求,必须放行——它们与图片无关,
// 上游工具定义实测接受(透传 200)
test('图片预检边界: tools 定义 / tool_calls 里的字段不动,不被误判', () => {
  const p = {
    messages: [
      { role: 'user', content: '调用工具' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'view_image', arguments: '{"url":"a.png"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"image_url":"data:image/png;base64,AA"}' },
    ],
    tools: [{ type: 'function', function: { name: 'view_image', parameters: { type: 'object', properties: { image_url: { type: 'string' } } } } }],
  };
  const r = checkContentSupport(p, MODEL);
  assert.strictEqual(r.ok, true, r.message);
});

test('图片预检边界: 无 type 字段的段、空串 type、非对象段放行(交上游仲裁)', () => {
  const p = { messages: [{ role: 'user', content: [{ text: '无类型标注' }, { type: '', text: '空串类型' }, '裸字符串', null] }] };
  assert.strictEqual(checkContentSupport(p, MODEL).ok, true);
});

test('图片预检边界: input_text(Responses 风格类型名的纯文本段)放行', () => {
  const p = { messages: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }] };
  assert.strictEqual(checkContentSupport(p, MODEL).ok, true);
});

test('图片预检边界: messages 缺省/非数组、content 为 null(纯 tool_calls 消息)放行', () => {
  assert.strictEqual(checkContentSupport({}, MODEL).ok, true);
  assert.strictEqual(checkContentSupport({ messages: 'nope' }, MODEL).ok, true);
  assert.strictEqual(checkContentSupport({ messages: [{ role: 'assistant', content: null }] }, MODEL).ok, true);
});

test('图片预检边界: content 数组为空数组放行', () => {
  assert.strictEqual(checkContentSupport({ messages: [{ role: 'user', content: [] }] }, MODEL).ok, true);
});

// ---- C5: 思考感知预算(两处,边界 0/1/511/512) ----
test('思考感知: 原生 kwargs thinking:false 时 max_tokens:16 不被抬到 512', () => {
  const p = { model: MODEL, max_tokens: 16, chat_template_kwargs: { thinking: false }, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.ok(!applied.includes('max_tokens→512'));
});

test('思考感知: 方言冲突时任一关闭信号即关闭(effort=high + 原生 false)', () => {
  const p = { model: MODEL, max_tokens: 16, reasoning_effort: 'high', chat_template_kwargs: { thinking: false }, messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.strictEqual(p.chat_template_kwargs.thinking, false);
});

test('思考感知: 关闭思考 + 剩余 100 + 预算 1000 → 收缩到 100 放行', () => {
  const p = { max_tokens: 1000, chat_template_kwargs: { thinking: false } };
  const r = fitTokenBudget(262044, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 100);
});

test('思考感知边界: 剩余 0/1/511/512 × 思考开/关', () => {
  // room=262144-prompt
  const mk = (room, off) => ({
    max_tokens: 1000,
    ...(off ? { chat_template_kwargs: { thinking: false } } : {}),
  });
  // 剩余 0:两种形态都拒绝
  assert.strictEqual(fitTokenBudget(262144, mk(0, true), 262144).ok, false);
  assert.strictEqual(fitTokenBudget(262144, mk(0, false), 262144).ok, false);
  // 剩余 1:思考关闭收缩到 1;思考开启拒绝(<512)
  const pOff1 = mk(1, true);
  const rOff1 = fitTokenBudget(262143, pOff1, 262144);
  assert.strictEqual(rOff1.ok, true);
  assert.strictEqual(pOff1.max_tokens, 1);
  assert.strictEqual(fitTokenBudget(262143, mk(1, false), 262144).ok, false);
  // 剩余 511:思考关闭收缩到 511;思考开启拒绝
  const pOff511 = mk(511, true);
  const rOff511 = fitTokenBudget(261633, pOff511, 262144);
  assert.strictEqual(rOff511.ok, true);
  assert.strictEqual(pOff511.max_tokens, 511);
  assert.strictEqual(fitTokenBudget(261633, mk(511, false), 262144).ok, false);
  // 剩余 512:两种形态都收缩到 512
  const pOn512 = mk(512, false);
  const rOn512 = fitTokenBudget(261632, pOn512, 262144);
  assert.strictEqual(rOn512.ok, true);
  assert.strictEqual(pOn512.max_tokens, 512);
  const pOff512 = mk(512, true);
  assert.strictEqual(fitTokenBudget(261632, pOff512, 262144).ok, true);
  assert.strictEqual(pOff512.max_tokens, 512);
});
