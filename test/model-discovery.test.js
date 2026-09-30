// test/model-discovery.test.js — 上游模型可用性探测的判据与失败分类。
//
// 为什么需要:学校会随时更名/下架模型。2026-09-27 实测硬编码的
// DeepSeek-V4-Flash-0731 被下架,上游对它返回 HTTP 200 +
// {"status":10001,"message":"模型不存在"}——代理层原样透传后用户看到的是含糊的
// "服务器繁忙",每一次请求都这样失败且看不出真因。本测试把所有实测到的
// 响应形态钉死,防止判据退化(特别是"用 status===10001 就判不可用"这类
// 会误伤真繁忙的写法——10001 同时覆盖"模型不存在"与"服务器繁忙"两种语义)。
//
// 注入 fetchImpl 全程离线,不访问学校服务(同 update-check.test.js 的范式)。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');

const { probeModel, describeProbeFailure, MODEL_NOT_FOUND,
  parseModelList, discoverModels, formatModelTable } = require('../core/model-discovery');

const UPSTREAM = 'https://webvpn.example/v1/chat/completions';
const ARGS = { upstreamUrl: UPSTREAM, model: 'm', token: 'tk', cookie: 'c=1', tunnelMode: true };

// 上游响应桩:body 为对象时序列化成 JSON,字符串则原样(模拟 HTML 等)
const res = (body, { status = 200 } = {}) => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// ---- 判据:四条分类路径 ----

test('可用:响应含 choices 数组 → ok', async () => {
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res({ choices: [{ message: { content: 'hi' } }] }) });
  assert.strictEqual(r.ok, true);
  assert.ok(Number.isFinite(r.ms));
});

test('可用:choices 为空数组也算接受(只看字段存在,不看长度)', async () => {
  // 上游可能返回空 choices 的合法帧(如仅 usage 的尾帧);模型名被接受即可
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res({ choices: [] }) });
  assert.strictEqual(r.ok, true);
});

test('不存在:status 10001 + message 含"模型不存在" → not-found', async () => {
  // 2026-09-27 实测形态,12~22ms 稳定返回。这条是本次功能的立项目标
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res({ data: null, status: 10001, extra: {}, message: '模型不存在', success: false }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-found');
  assert.ok(r.detail.includes(MODEL_NOT_FOUND));
});

test('繁忙:status 10001 但 message 不是"模型不存在" → busy(不得误判为下线)', async () => {
  // 关键边界:10001 同时是"模型不存在"与"服务器繁忙"的状态码。只用 status
  // 判因会把学校的暂时过载误报成"模型已下架",让人去白改配置
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res({ data: null, status: 10001, message: '服务器繁忙，请稍后再试', success: false }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'busy');
});

test('无 status 的错误码(如 10003 无权限)归 other', async () => {
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res({ data: null, status: 10003, message: '抱歉哦，您无此权限！', success: false }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'other');
});

test('3xx(隧道踢回登录页)归 session,不误报为模型问题', async () => {
  // 生产实测 2026-09-27:启动瞬间 cookie 已过期、watch 未及续期,探测收到
  // 302。这是会话失效而非模型不可用——归到 other 会让人误以为配置有问题
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res('', { status: 302 }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'session');
});

test('3xx 判定优先于 body:302 带 JSON 体仍归 session,不得误判', async () => {
  // 顺序 bug 回归(2026-09-27 审阅指出):若先看 body 再看状态码,
  // 「302 + 带 JSON 体」会被判成 not-found(让人去改配置)或 ok(谎报可用)。
  // 状态码是比 body 更强的一级判据——与 upstream-client "非 2xx 先走错误
  // 路径"同一口径
  const caseA = await probeModel({
    ...ARGS,
    fetchImpl: async () => res({ data: null, status: 10001, message: '模型不存在' }, { status: 302 }),
  });
  assert.strictEqual(caseA.reason, 'session', '302+not-found 体应归 session: ' + JSON.stringify(caseA));
  const caseB = await probeModel({
    ...ARGS,
    fetchImpl: async () => res({ choices: [] }, { status: 302 }),
  });
  assert.strictEqual(caseB.ok, false, '302+choices 体不得谎报可用');
  assert.strictEqual(caseB.reason, 'session');
});

test('畸形响应(HTML / 非 JSON / 空体)归 other,不抛', async () => {
  for (const body of ['<html>SPA</html>', 'not json', '', 'null', '404']) {
    const r = await probeModel({ ...ARGS, fetchImpl: async () => res(body) });
    assert.strictEqual(r.ok, false, JSON.stringify(body));
    assert.strictEqual(r.reason, 'other', JSON.stringify(body));
  }
});

test('HTTP 非 200 且体非 JSON 归 other(带状态码与原文片段)', async () => {
  const r = await probeModel({ ...ARGS, fetchImpl: async () => res('<html>502</html>', { status: 502 }) });
  assert.strictEqual(r.reason, 'other');
  assert.ok(r.detail.includes('502'), r.detail);
});

test('网络异常/超时 → network(不抛)', async () => {
  const boom = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
  const r = await probeModel({ ...ARGS, fetchImpl: async () => { throw boom; } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'network');
});

test('超时单列一类(不得与网络不可达混为一谈)', async () => {
  // 实测 2026-09-27:目标模型首次请求撞上游冷启动 >15s,之后只要 350ms。
  // 报成 network 会让人去查网络;单列 timeout 提示"可能是上游在加载模型"
  for (const name of ['TimeoutError', 'AbortError']) {
    const e = Object.assign(new Error('The operation was aborted due to timeout'), { name });
    const r = await probeModel({ ...ARGS, fetchImpl: async () => { throw e; } });
    assert.strictEqual(r.ok, false, name);
    assert.strictEqual(r.reason, 'timeout', name + ' 应归 timeout 而非 network');
  }
  // 非超时错误仍是 network(边界不混)
  const other = Object.assign(new Error('ECONNREFUSED'), { name: 'Error' });
  const r2 = await probeModel({ ...ARGS, fetchImpl: async () => { throw other; } });
  assert.strictEqual(r2.reason, 'network');
});

test('读取响应体失败 → network(不抛)', async () => {
  const r = await probeModel({
    ...ARGS,
    fetchImpl: async () => ({ status: 200, text: async () => { throw new Error('socket closed'); } }),
  });
  assert.strictEqual(r.reason, 'network');
});

// ---- 请求构造:探测必须直连上游,且不消耗生成配额 ----

test('请求构造:带 Bearer、max_tokens 极小、不经代理归一化', async () => {
  let seen = null;
  await probeModel({
    ...ARGS,
    fetchImpl: async (url, opts) => { seen = { url, opts }; return res({ choices: [] }); },
  });
  assert.strictEqual(seen.url, UPSTREAM);
  assert.strictEqual(seen.opts.method, 'POST');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tk');
  assert.strictEqual(seen.opts.headers.Cookie, 'c=1');
  const body = JSON.parse(seen.opts.body.toString('utf8'));
  assert.strictEqual(body.model, 'm');
  // 探测只问"模型名是否被接受",取极小预算:代理的归一化会把 <512 抬到 512
  // (见 core/payload.js),故探测必须直连上游、值必须小
  assert.strictEqual(body.max_tokens, 1);
  assert.strictEqual(body.stream, false);
});

test('请求构造:无 cookie 时不带 Cookie 头(直连上游的场景)', async () => {
  let seen = null;
  await probeModel({
    upstreamUrl: UPSTREAM, model: 'm', token: 'tk', tunnelMode: true,
    fetchImpl: async (url, opts) => { seen = opts; return res({ choices: [] }); },
  });
  assert.ok(!('Cookie' in seen.headers));
});

test('凭据卫生:直连形态(tunnelMode 假)即使有 cookie 也不发 Cookie', async () => {
  // WebVPN 会话 cookie 只回传给签发它的 origin——直连覆盖(PROXY_UPSTREAM)时
  // 把 webvpn 域签发的 cookie 发给 madmodel.cs 域是凭据卫生问题,SECURITY.md
  // 明确承诺 cookie"仅随上游请求回传 WebVPN 隧道"。门放在 probeModel 内部,
  // 不依赖调用方自觉(2026-09-27 审阅指出的 P0)
  let seen = null;
  const r = await probeModel({
    ...ARGS, cookie: 'wengine_vpn_ticket=SECRET', tunnelMode: false,
    fetchImpl: async (url, opts) => { seen = opts; return res({ choices: [] }); },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(!('Cookie' in seen.headers),
    '直连形态下不得回传隧道 cookie: ' + JSON.stringify(seen.headers));
  // 隧道形态下必须带(否则会被隧道踢回登录页,探测必然失败)
  let tunnelSeen = null;
  await probeModel({
    ...ARGS, cookie: 'wengine_vpn_ticket=SECRET', tunnelMode: true,
    fetchImpl: async (url, opts) => { tunnelSeen = opts; return res({ choices: [] }); },
  });
  assert.strictEqual(tunnelSeen.headers.Cookie, 'wengine_vpn_ticket=SECRET');
});

test('请求构造:redirect 必须是 manual(session 判定赖以工作的前提)', async () => {
  // 若跟随重定向,fetch 会跟到登录页返回 200+HTML,session 分支永不可达、
  // describeProbeFailure('session') 成死代码。此前无断言,把 'manual' 改成
  // 'follow' 测试全绿(2026-09-27 审阅的变异实验发现)
  let seen = null;
  await probeModel({
    ...ARGS,
    fetchImpl: async (url, opts) => { seen = opts; return res({ choices: [] }); },
  });
  assert.strictEqual(seen.redirect, 'manual');
});

// ---- 文案 ----

test('describeProbeFailure:not-found 点名模型并给出可操作处置,其余不让人白改配置', () => {
  const nf = describeProbeFailure('not-found', 'Old-Model-1');
  assert.ok(nf.includes('Old-Model-1'), '应点名模型:' + nf);
  // 1.10.1 起 config.js 的 MODEL 不参与路由,所以处置必须指向**客户端**里配的
  // 模型名(旧文案让人改 config.js,照着做请求依然走不通)
  assert.ok(nf.includes('客户端'), '应把用户指向客户端配置:' + nf);
  assert.ok(/v1\/models/.test(nf), '应给出核对模型名的具体办法:' + nf);
  assert.ok(!nf.includes('config.js'), '不该再让人改 config.js(它不参与路由):' + nf);
  // busy/network 是上游当下状态,不是配置问题——给"改配置"的指示会误导
  for (const reason of ['busy', 'network', 'session', 'timeout', 'other']) {
    const s = describeProbeFailure(reason, 'M');
    assert.ok(!s.includes('config.js'), reason + ' 不应让人去改配置:' + s);
  }
});

// ===== 模型枚举(1.10) =====

// 上游前端 bundle 里 modelList 的真实形态(2026-09-27 从 bundle 抄录,缩短未改结构)
const BUNDLE_FRAGMENT = 'var x={modelList:[{label:"qwen3.8-27b",value:"qwen3.8-27b",' +
  'max_tokens:3,supportImage:!0,thinkingParam:"enable_thinking",thinkingField:"reasoning",' +
  'effortOptions:["low","medium","xhigh"]},{label:"DeepSeek-R1-W8A8",value:"DeepSeek-R1-W8A8",' +
  'max_tokens:3,supportImage:!1,thinkingParam:null,thinkingField:"content",' +
  'effortOptions:["low","medium","high"]}]},y=1';

test('parseModelList:解析真实 bundle 片段(含能力标注)', () => {
  const list = parseModelList(BUNDLE_FRAGMENT);
  assert.ok(Array.isArray(list), '应解析出数组');
  assert.strictEqual(list.length, 2);
  const qwen = list.find(m => m.id === 'qwen3.8-27b');
  assert.strictEqual(qwen.supportImage, true, 'supportImage !0 应解析为 true');
  assert.strictEqual(qwen.thinkingParam, 'enable_thinking');
  assert.strictEqual(qwen.thinkingField, 'reasoning');
  assert.deepStrictEqual(qwen.effortOptions, ['low', 'medium', 'xhigh']);
  const r1 = list.find(m => m.id === 'DeepSeek-R1-W8A8');
  assert.strictEqual(r1.supportImage, false, 'supportImage !1 应解析为 false');
  assert.strictEqual(r1.thinkingParam, null, 'thinkingParam:null 应解析为 null');
  assert.deepStrictEqual(r1.effortOptions, ['low', 'medium', 'high']);
});

test('parseModelList:畸形/缺失输入返回 null(不抛,由调用方降级)', () => {
  for (const bad of [null, undefined, '', 'no list here', '{modelList:[}', '{modelList:[]}']) {
    assert.strictEqual(parseModelList(bad), null, JSON.stringify(bad));
  }
});

test('parseModelList:嵌套数组(effortOptions)不被提前截断', () => {
  // 括号配平若写错,条目内的 [..] 会让解析在数组中间断开
  const list = parseModelList(BUNDLE_FRAGMENT);
  assert.strictEqual(list.length, 2, '两条目都应解析出来');
  assert.deepStrictEqual(list[0].effortOptions, ['low', 'medium', 'xhigh']);
});

test('discoverModels:并发探测,按可用优先 + 延迟排序', async () => {
  const delays = { 'Slow-OK': 500, 'Fast-OK': 50, 'Gone': 10 };
  const r = await discoverModels({
    upstreamUrl: UPSTREAM, candidates: ['Slow-OK', 'Gone', 'Fast-OK'], token: 'tk',
    fetchImpl: async (url, opts) => {
      const model = JSON.parse(opts.body.toString('utf8')).model;
      await new Promise(res => setTimeout(res, delays[model] || 0));
      if (model === 'Gone') return res({ data: null, status: 10001, message: '模型不存在' });
      return res({ choices: [] });
    },
  });
  assert.deepStrictEqual(r.map(x => x.id), ['Fast-OK', 'Slow-OK', 'Gone'],
    '可用的排前、按延迟升序;不可用的排后');
  assert.strictEqual(r[0].ok, true);
  assert.strictEqual(r[2].reason, 'not-found');
});

test('discoverModels:候选去重,空输入不抛', async () => {
  let calls = 0;
  const r = await discoverModels({
    upstreamUrl: UPSTREAM, candidates: ['A', 'A', 'A'], token: 'tk',
    fetchImpl: async () => { calls++; return res({ choices: [] }); },
  });
  assert.strictEqual(calls, 1, '重复候选只探一次');
  assert.strictEqual(r.length, 1);
  const empty = await discoverModels({ upstreamUrl: UPSTREAM, candidates: [], token: 'tk', fetchImpl: async () => res({}) });
  assert.deepStrictEqual(empty, []);
});

test('formatModelTable:含表头,状态与延迟正确', () => {
  const lines = formatModelTable([
    { id: 'Vision-Exp', ok: true, ms: 254, meta: { supportImage: true } },
    { id: 'R1-W8A8', ok: true, ms: 4200, meta: { supportImage: false } },
    { id: 'Old', ok: false, reason: 'not-found', ms: 14, meta: null },
    { id: 'Loaded', ok: false, reason: 'busy', ms: 40000, meta: null },
  ]);
  assert.ok(lines[0].includes('模型'), '应有表头');
  assert.ok(lines[0].includes('延迟'), '表头应有延迟列');
  // 表格只列连通性与延迟:能力标注不上这张表(2026-09-27 用户定稿)
  assert.ok(!lines[0].includes('视觉'), '表格不应有视觉列');
  assert.ok(lines.some(l => l.includes('Vision-Exp') && l.includes('可用') && l.includes('254ms')));
  assert.ok(lines.some(l => l.includes('R1-W8A8') && l.includes('可用') && l.includes('4200ms')));
  assert.ok(lines.some(l => l.includes('Old') && l.includes('不存在')));
  assert.ok(lines.some(l => l.includes('Loaded') && l.includes('繁忙')));
});

test('formatModelTable:会话失效是一个独立状态(启动期 cookie 未续期时可见)', () => {
  const lines = formatModelTable([{ id: 'M', ok: false, reason: 'session', ms: 45 }]);
  assert.ok(lines.some(l => l.includes('会话失效')), '应显示会话失效:' + JSON.stringify(lines));
});

test('formatModelTable:空输入返回空数组', () => {
  assert.deepStrictEqual(formatModelTable([]), []);
  assert.deepStrictEqual(formatModelTable(null), []);
});
