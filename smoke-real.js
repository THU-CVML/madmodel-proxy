#!/usr/bin/env node
// smoke-real.js — 验证当前真实上游的基本行为。
// 与离线测试的分工:test/ 覆盖纯函数边界与可构造的协议判定(mock 上游,
// 1.8.1 起);真实网关的形态(错误文案、限流、帧型、学校特有行为)只有
// 真实流量能暴露(2026-09-05 事故:坏帧严格性误杀网关空心跳帧,当日的
// 离线测试全绿仍翻车)。
// 只做最小验证(/v1/models、一次短流式、一次非流式),不做压力/并发/循环:
//   node smoke-real.js   (前置:代理在跑、token 有效;消耗少量学校配额)
'use strict';

const config = require('./config');

const BASE = `http://127.0.0.1:${config.port}`;

async function chat(body, timeoutMs) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // 本地无鉴权,key 随便填
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 180000),
  });
  return { status: r.status, text: await r.text() };
}

let failed = 0;
function check(ok, label, detail) {
  console.log((ok ? '✅ ' : '❌ ') + label + (ok || !detail ? '' : `: ${detail}`));
  if (!ok) failed++;
}

async function main() {
  // 0) 代理在线
  const models = await fetch(`${BASE}/v1/models`).then(r => r.json()).catch(() => null);
  if (!models || !Array.isArray(models.data)) {
    console.error(`❌ 代理未运行(${BASE}),先启动 start.cmd`);
    process.exit(1);
  }

  // 1) 小请求(流式):应完整以 [DONE] 结束,无内嵌错误
  let r = await chat({
    model: config.models[0], stream: true, max_tokens: 300,
    messages: [{ role: 'user', content: '用一句话回答:1+1 等于几?' }],
  });
  check(r.status === 200 && r.text.trimEnd().endsWith('data: [DONE]') && !r.text.includes('errorMessage'),
    '小请求(流式)完整结束',
    `HTTP ${r.status} | 末尾: ${r.text.slice(-80).replace(/\s+/g, ' ')}`);

  // 2) 非流式短请求:聚合路径完整、usage 注入生效(真实 token 计数,非全零)
  r = await chat({
    model: config.models[0], stream: false, max_tokens: 300,
    messages: [{ role: 'user', content: '回答:ok' }],
  });
  let usageOk = false;
  let usageDetail = '';
  try {
    const j = JSON.parse(r.text);
    usageOk = j.usage?.total_tokens > 0;
    usageDetail = `usage=${JSON.stringify(j.usage)}`;
  } catch (e) { usageDetail = r.text.slice(0, 100); }
  check(r.status === 200 && usageOk, '非流式短请求:聚合与 usage 注入生效', usageDetail);

  console.log(failed
    ? `\n结果: ${failed} 项失败——协议处理与真实上游不兼容,查代理日志中 stream-invalid/截断行`
    : '\n结果: 真实流量冒烟通过');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('❌ 冒烟崩溃:', e.message); process.exit(1); });
