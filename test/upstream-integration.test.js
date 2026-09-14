// test/upstream-integration.test.js — 经完整 HTTP 服务链的上游错误判定集成测试。
// 本地 mock 上游 + 真实代理实例(装配同 proxy.js,PROXY_UPSTREAM/PROXY_TOKEN_FILE
// 注入),验证 C3 的错误统一矩阵:非 2xx、200-SSE 内嵌标准 error 对象、学校
// errorMessage 帧、302 会话失效、截断、正常完成——错误不得以 200 + 空内容
// 的假成功形态交付。此骨架同时是 Wave 4(A1 等待重试)的测试基座。
// 结构注:装配/收尾用单顶层 test + t.test 子测试 + try/finally,不用顶层
// before/after 钩子——Node 18 的 node:test 根级钩子不生效(18.14.2 CI 实测,
// 测试带着未初始化的装配直接开跑),t.test 子测试全版本可靠
'use strict';

// 环境注入必须在 require config/paths 之前(加载期读取)
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-it-'));
process.env.MADMODEL_STATE_DIR = STATE_DIR;
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'it-test-token', expiresAt: Date.now() + 3600e3 }));
process.env.PROXY_TOKEN_FILE = TOKEN_FILE;

const test = require('node:test');
const assert = require('node:assert');

// ---- mock 上游(可编程响应) ----
function startMockUpstream() {
  let handler = null;
  const server = http.createServer((req, res) => {
    if (handler) return handler(req, res);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock 未配置 handler' } }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      set: h => { handler = h; },
    }));
  });
}

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// mock 上游的 SSE 应答助手
function sse(res, frames, { status = 200 } = {}) {
  res.writeHead(status, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const CH = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' } }] };
const USAGE = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };

test('上游错误判定集成矩阵(mock 上游 + 完整代理实例)', async t => {
  // ---- 装配(同 proxy.js,PROXY_UPSTREAM 指向 mock) ----
  const mock = await startMockUpstream();
  const port = await freePort();
  process.env.PROXY_UPSTREAM = `http://127.0.0.1:${mock.port}/v1/chat/completions`;
  process.env.PROXY_PORT = String(port);
  const config = require('../config');
  const { createUpstreamClient } = require('../core/upstream-client');
  const { createProxyService } = require('../core/proxy-service');
  const { createHttpServer, createTokenCache, createTokenState } = require('../adapters/http-server');
  const getToken = createTokenCache(config);
  const tokenState = createTokenState(getToken);
  const service = createProxyService({
    config, tokenState, upstreamClient: createUpstreamClient(config),
  });
  const httpServer = createHttpServer({ config, service, getToken });
  await new Promise(res => httpServer.server.listen(port, '127.0.0.1', res));
  const proxyUrl = `http://127.0.0.1:${port}/v1/chat/completions`;

  // 客户端视角的调用;返回 { status, json, text }
  const chat = async (stream, extra = {}) => {
    const r = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'DeepSeek-V4-Flash-0731',
        messages: [{ role: 'user', content: '回复ok' }],
        max_tokens: 512,
        stream, ...extra,
      }),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* SSE 文本 */ }
    return { status: r.status, json, text };
  };

  try {
    await t.test('正常流式: 200 SSE 透传,内容与 [DONE] 完整', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]));
      const r = await chat(true);
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('"content":"ok"'));
      assert.ok(r.text.includes('[DONE]'));
    });

    await t.test('正常非流式: 200 SSE 聚合为 completion', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]));
      const r = await chat(false);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.choices?.[0]?.message?.content, 'ok');
    });

    await t.test('非 2xx + SSE content-type + 标准 error 对象: 不得成为 200 假成功', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify({ error: { message: 'busy', type: 'server_error' } })], { status: 500 }));
      const r = await chat(false);
      assert.notStrictEqual(r.status, 200);
      assert.strictEqual(r.json.error.code, 502);
      assert.ok(r.json.error.message.includes('busy'));
    });

    await t.test('200 SSE 内嵌标准 error 对象帧: 翻译为 5xx 错误,不进聚合', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify({ error: { message: 'quota exceeded' } })]));
      const r = await chat(false);
      assert.notStrictEqual(r.status, 200);
      assert.ok(r.json.error.message.includes('quota exceeded'));
    });

    await t.test('200 SSE 内嵌学校 errorMessage 帧: 429 繁忙语义(既有行为钉住)', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify({ errorMessage: '服务器繁忙，请稍后再试' })]));
      const r = await chat(false);
      assert.strictEqual(r.status, 429);
      assert.ok(r.json.error.message.includes('服务器繁忙'));
    });

    await t.test('302 空响应体: 明确的会话失效文案,非"无法识别的响应"', async () => {
      mock.set((req, res) => { res.writeHead(302, { location: '/login' }); res.end(); });
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('WebVPN 会话已失效'), r.json.error.message);
    });

    await t.test('404: 端点变更文案(既有行为钉住)', async () => {
      mock.set((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>404</html>'); });
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('端点可能已变更'));
    });

    await t.test('200 SSE 中途截断(无 [DONE]): 非流式 502 截断文案', async () => {
      mock.set((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(CH)}\n\n`);
        res.end(); // 未见 [DONE] 即断
      });
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('截断'));
    });
  } finally {
    await new Promise(r => httpServer.server.close(r));
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
  }
});
