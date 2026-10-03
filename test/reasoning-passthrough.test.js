// test/reasoning-passthrough.test.js — 思考字段归一在**真实 HTTP 路径**上的端到端验证。
//
// 为什么需要纯函数测试之外还来一遍:字段归一挂在 ctx.writeSseChunk 这个唯一的
// SSE 写出点上,而帧要经过"上游 SSE → upstream-client 解析 → proxy-service
// 缓冲/透传 → http-server 写出"多段链路。纯函数绿不代表客户端真能拿到
// reasoning_content——中间任何一段丢帧或改键都会让修复失效。
//
// 复现的是 2026-09-29 实测形态:qwen 的 delta 键是 role,content,**reasoning**
// (逐字抄自抓到的上游真实帧),而客户端只认 reasoning_content。
'use strict';
require('../scripts/isolated-env').isolate();

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reason-'));
process.env.MADMODEL_STATE_DIR = STATE_DIR;
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'reason-token', expiresAt: Date.now() + 3600e3 }));
process.env.PROXY_TOKEN_FILE = TOKEN_FILE;
process.env.MADMODEL_FORCE_TUNNEL_MODE = '1';
process.env.PROXY_RETRY_WAIT_MS = '1000';

const test = require('node:test');
const assert = require('node:assert');

function startMockUpstream() {
  let handler = null;
  const server = http.createServer((req, res) => {
    if (handler) return handler(req, res);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: server.address().port, set: h => { handler = h; },
    }));
  });
}
function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const chunk = (delta, finish = null) => JSON.stringify({
  id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// 逐字抄自 2026-09-29 抓到的 qwen 上游真实帧:思考在 `reasoning` 里,
// 且收尾处有 `{"content":"...","reasoning":null}` 这一形态
const QWEN_FRAMES = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ reasoning: '这是一个' }),
  chunk({ reasoning: '经典的' }),
  chunk({ reasoning: '脑筋急转弯。' }),
  chunk({ content: '\n\n## 答案' , reasoning: null }),
  chunk({ content: '：还剩 9 只。' }),
  chunk({}, 'stop'),
];

const DS_FRAMES = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ reasoning_content: 'DeepSeek 的思考' }),
  chunk({ content: 'DeepSeek 的正文' }),
  chunk({}, 'stop'),
];

test('思考字段归一(真实 HTTP 路径)', async t => {
  const mock = await startMockUpstream();
  const port = await freePort();
  process.env.PROXY_UPSTREAM = `http://127.0.0.1:${mock.port}/v1/chat/completions`;
  process.env.PROXY_PORT = String(port);
  const config = require('../config');
  const { createUpstreamClient } = require('../core/upstream-client');
  const { createProxyService } = require('../core/proxy-service');
  const { createHttpServer, createTokenCache, createTokenState, createCredentialWaiter } = require('../adapters/http-server');
  const getToken = createTokenCache(config);
  const service = createProxyService({
    config, tokenState: createTokenState(getToken),
    upstreamClient: createUpstreamClient(config),
    waitForCredentials: createCredentialWaiter(getToken),
  });
  // 允许用例换掉 service(用于注入 modelRegistry),但复用同一端口——
  // allowedHosts 是按 config.port 构造的,换端口会被自己的白名单 403
  const svcRef = { current: service };
  const dispatcher = {
    handleRequest: ctx => svcRef.current.handleRequest(ctx),
    logReq: (...a) => svcRef.current.logReq(...a),
    usageNote: (...a) => svcRef.current.usageNote(...a),
  };
  const httpServer = createHttpServer({ config, service: dispatcher, getToken });
  await new Promise(res => httpServer.server.listen(port, '127.0.0.1', res));
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;

  const ask = async (stream, model) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream, max_tokens: 100 }),
    });
    return { status: r.status, text: await r.text() };
  };

  // 从 SSE 文本里把所有 delta 的键名与思考/正文分别收集
  const parse = text => {
    const keys = new Set();
    let reasoning = '', content = '', sawBareReasoning = false, frames = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      frames++;
      Object.keys(d).forEach(k => keys.add(k));
      if ('reasoning' in d) sawBareReasoning = true;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (typeof d.content === 'string') content += d.content;
    }
    return { keys: [...keys], reasoning, content, sawBareReasoning, frames };
  };

  try {
    await t.test('流式: qwen 的 reasoning 以 reasoning_content 交付,且不留方言键', async () => {
      mock.set((req, res) => { req.resume(); req.on('end', () => sse(res, QWEN_FRAMES)); });
      const r = await ask(true, 'qwen3.8-27b');
      assert.strictEqual(r.status, 200);
      const p = parse(r.text);
      assert.strictEqual(p.reasoning, '这是一个经典的脑筋急转弯。', '思考必须完整到达 reasoning_content');
      assert.strictEqual(p.content, '\n\n## 答案：还剩 9 只。', '正文不受影响');
      assert.ok(!p.sawBareReasoning, '裸 reasoning 键不得出现在交付帧里');
      assert.ok(!p.keys.includes('reasoning'), 'delta 键名只能是归一后的名字');
    });

    await t.test('流式: DeepSeek 的 reasoning_content 行为不变(不回归)', async () => {
      mock.set((req, res) => { req.resume(); req.on('end', () => sse(res, DS_FRAMES)); });
      const r = await ask(true, 'DeepSeek-V4.1-Flash');
      assert.strictEqual(r.status, 200);
      const p = parse(r.text);
      assert.strictEqual(p.reasoning, 'DeepSeek 的思考');
      assert.strictEqual(p.content, 'DeepSeek 的正文');
    });

    await t.test('非流式: qwen 的思考进入 message.reasoning_content', async () => {
      mock.set((req, res) => { req.resume(); req.on('end', () => sse(res, QWEN_FRAMES)); });
      const r = await ask(false, 'qwen3.8-27b');
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.text);
      const m = j.choices[0].message;
      assert.strictEqual(m.reasoning_content, '这是一个经典的脑筋急转弯。');
      assert.strictEqual(m.content, '\n\n## 答案：还剩 9 只。');
      assert.ok(!('reasoning' in m), '聚合结果里不得出现上游方言名');
    });

    await t.test('带 tools 的流式路径同样归一(缓冲后冲刷的那条)', async () => {
      // 带 tools 时 proxy-service 会缓冲 content 帧、思考帧即时透传,
      // 两条出口都必须经过归一——这是"半好半坏"最容易漏的地方
      mock.set((req, res) => { req.resume(); req.on('end', () => sse(res, QWEN_FRAMES)); });
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 100,
          tools: [{ type: 'function', function: { name: 'Bash', description: 'x',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }],
        }),
      });
      const text = await r.text();
      const p = parse(text);
      assert.strictEqual(p.reasoning, '这是一个经典的脑筋急转弯。', '缓冲路径的思考也不能丢');
      assert.ok(!p.sawBareReasoning, '缓冲路径不得漏出方言键');
      assert.ok(p.content.includes('还剩 9 只'), '正文经缓冲后仍应完整交付');
    });

    await t.test('json-fallback: 上游对 stream 回完整 JSON 时, qwen 的思考也不能丢', async () => {
      // 上游偶发对 stream:true 回完整 completion(非 SSE)。该路径此前硬编码
      // 只读 message.reasoning_content,qwen 的 reasoning 会被整段丢掉——
      // 与流式透传是同一个 bug 的另一种帧形态(2026-09-29 审阅指出)
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'fb1', object: 'chat.completion', created: 1, model: 'qwen3.8',
            choices: [{ index: 0, finish_reason: 'stop', message: {
              role: 'assistant', content: '答案：9 只', reasoning: '让我想想这道题' } }],
            usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
          }));
        });
      });
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 100 }),
      });
      const text = await r.text();
      const p = parse(text);
      assert.strictEqual(p.reasoning, '让我想想这道题', 'json-fallback 路径的思考同样要归一交付');
      assert.strictEqual(p.content, '答案：9 只');
      assert.ok(!p.sawBareReasoning, 'fallback 交付帧里不得出现方言键');
    });

    await t.test('能力元数据接入: 模型清单里的方言字段也要被认(非写死清单)', async () => {
      // 这条钉的是"权威字段来自 modelRegistry/meta,不是硬编码"这条链路。
      // 用一个**已知清单里没有**的字段名:只有真的把 meta.thinkingField 接进
      // 交付路径,思考才可能出现在 reasoning_content 里。若哪天有人把字段名
      // 接续漏掉,这条会红。
      //
      // 走的是**非流式直传**路径:上游对非流式请求回完整 JSON completion,
      // 代理原样 sendJson 交付——这条路径原先完全不做归一(第三种帧形态)
      //
      // 注意:不能另起一个不同端口的 httpServer——allowedHosts 是按
      // config.port 构造的,换端口后 Host 头会被自己的白名单拒掉(403)。
      // 故这里只换 service(把 modelRegistry 注入进去),复用主服务器端口
      svcRef.current = createProxyService({
        config, tokenState: createTokenState(getToken),
        upstreamClient: createUpstreamClient(config),
        waitForCredentials: createCredentialWaiter(getToken),
        modelRegistry: {
          snapshot: () => [{
            id: 'qwen3.8-27b', ok: true,
            meta: { supportImage: true, thinkingParam: 'enable_thinking',
              thinkingField: 'reasoning_v9', effortOptions: ['low', 'high'] },
          }],
          available: () => [{ id: 'qwen3.8-27b' }],
        },
      });
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'fb2', object: 'chat.completion', created: 1, model: 'qwen3.8',
            choices: [{ index: 0, finish_reason: 'stop', message: {
              role: 'assistant', content: '正文在此', reasoning_v9: '清单里声明的方言' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        });
      });
      const r2 = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }),
      });
      const j2 = JSON.parse(await r2.text());
      assert.ok(j2.choices, '响应应是 completion,实际: ' + JSON.stringify(j2).slice(0, 300));
      const m2 = j2.choices[0].message;
      assert.strictEqual(m2.reasoning_content, '清单里声明的方言',
        '只有把 meta.thinkingField 接进交付路径,这个字段才能被认出');
      assert.strictEqual(m2.content, '正文在此');
      assert.ok(!('reasoning_v9' in m2), '方言键不能原样漏给客户端');
    });

    await t.test('能力元数据接入(聚合路径): 聚合器也要拿到 thinkingField', async () => {
      // 与上一条的区别:上一条走**非流式直传**(json-completion),这条走
      // **聚合路径**(上游回 SSE、代理拼成非流式回复)。两条路径各自取字段名,
      // 漏掉任何一条都会让该路径下 qwen 的思考消失——这正是"半好半坏"的形态
      svcRef.current = createProxyService({
        config, tokenState: createTokenState(getToken),
        upstreamClient: createUpstreamClient(config),
        waitForCredentials: createCredentialWaiter(getToken),
        modelRegistry: {
          snapshot: () => [{
            id: 'qwen3.8-27b', ok: true,
            meta: { supportImage: true, thinkingParam: 'enable_thinking',
              thinkingField: 'reasoning_v9', effortOptions: ['low', 'high'] },
          }],
          available: () => [{ id: 'qwen3.8-27b' }],
        },
      });
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => sse(res, [
          chunk({ role: 'assistant', content: '' }),
          chunk({ reasoning_v9: '聚合路径的思考' }),
          chunk({ content: '聚合路径的正文' }),
          chunk({}, 'stop'),
        ]));
      });
      const r3 = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }),
      });
      const j3 = JSON.parse(await r3.text());
      assert.ok(j3.choices, '响应应是 completion,实际: ' + JSON.stringify(j3).slice(0, 300));
      const m3 = j3.choices[0].message;
      assert.strictEqual(m3.reasoning_content, '聚合路径的思考',
        '聚合器必须拿到 meta.thinkingField,否则这条路径下思考会丢');
      assert.strictEqual(m3.content, '聚合路径的正文');
    });

    await t.test('流式出口自足: 上游换字段名时, 裸键也不许漏给客户端', async () => {
      // 这条钉 SSE 出口(writeSseChunk)是否拿到了本模型的字段名。
      // 出口那层拿不到模型名,靠 service 经 ctx.setThinkingFields 注入;
      // 若注入断了,出口只能用已知清单 ⇒ 这个清单外的字段名会被原样透传
      svcRef.current = createProxyService({
        config, tokenState: createTokenState(getToken),
        upstreamClient: createUpstreamClient(config),
        waitForCredentials: createCredentialWaiter(getToken),
        modelRegistry: {
          snapshot: () => [{
            id: 'qwen3.8-27b', ok: true,
            meta: { supportImage: true, thinkingParam: 'enable_thinking',
              thinkingField: 'reasoning_v9', effortOptions: ['low', 'high'] },
          }],
          available: () => [{ id: 'qwen3.8-27b' }],
        },
      });
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => sse(res, [
          chunk({ role: 'assistant', content: '' }),
          chunk({ reasoning_v9: '流式出口的方言思考' }),
          chunk({ content: '流式正文' }),
          chunk({}, 'stop'),
        ]));
      });
      const r4 = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 50 }),
      });
      const p4 = parse(await r4.text());
      assert.strictEqual(p4.reasoning, '流式出口的方言思考',
        '出口没拿到字段名 ⇒ 认不出 meta 声明的方言 ⇒ 思考丢给客户端也读不到');
      assert.ok(!p4.keys.includes('reasoning_v9'), '方言键不得原样漏给客户端');
    });
  } finally {
    await new Promise(res => httpServer.server.close(res));
    await new Promise(res => mock.server.close(res));
  }
});
