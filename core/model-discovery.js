// 从上游前端读取模型能力，并通过小请求探测可用性；不执行远程脚本。

'use strict';

const MODEL_NOT_FOUND = '模型不存在';

async function probeModel({ upstreamUrl, model, token, cookie, tunnelMode, timeoutMs = 60000, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let res;
  let headerMs = null; // 响应头到达耗时(纯连通性);见下方赋值处说明
  try {
    res = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(cookie && tunnelMode ? { Cookie: cookie } : {}),
      },
      body: Buffer.from(JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 1,
      }), 'utf8'),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    headerMs = elapsed();
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'network',
      ms: elapsed(),
      detail: String(e?.message || e).slice(0, 120),
    };
  }

  let text = '';
  try { text = await res.text(); } catch (e) {
    return { ok: false, reason: 'network', ms: elapsed(), detail: '读取响应失败' };
  }

  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false, reason: 'session', ms: elapsed(),
      detail: `HTTP ${res.status} 重定向，请检查登录状态与上游地址`,
    };
  }

  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON:走 other */ }

  if (res.status >= 200 && res.status < 300 && json && Array.isArray(json.choices)) {
    return { ok: true, ms: headerMs, totalMs: elapsed() };
  }

  if (json && json.status === 10001) {
    const message = String(json.message || '');
    if (message.includes(MODEL_NOT_FOUND)) {
      return { ok: false, reason: 'not-found', ms: headerMs, detail: message.slice(0, 80) };
    }
    return { ok: false, reason: 'busy', ms: headerMs, detail: message.slice(0, 80) };
  }

  return {
    ok: false, reason: 'other', ms: headerMs,
    detail: `HTTP ${res.status} ${String(text || '').replace(/\s+/g, ' ').slice(0, 80)}`,
  };
}

function describeProbeFailure(reason, model) {
  switch (reason) {
    case 'not-found':
      return `模型 ${model} 不存在，客户端请改用 /v1/models 列出的模型名`;
    case 'busy':
      return `${model} 探测被拒绝，暂无法确认是否可用`;
    case 'session':
      return '探测遇到重定向，请检查上游地址与登录状态';
    case 'network':
      return `${model} 探测连接失败，请检查网络`;
    case 'timeout':
      return `${model} 探测超时，可稍后用对话验证`;
    default:
      return `${model} 探测响应异常，暂无法确认是否可用`;
  }
}

// 重试前读取最新 token/cookie，以使用 watch 续期后的结果。
async function discoverWithCredentials({ getCredentials, probe, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const first = await probe(getCredentials());
  if (first.length && first.every(r => !r.ok && r.reason === 'session')) {
    await wait(8000);
    const again = await probe(getCredentials()).catch(() => null);
    if (again?.length) return again;
  }
  return first;
}

module.exports = { probeModel, describeProbeFailure, MODEL_NOT_FOUND, parseModelList, discoverModels, formatModelTable, discoverWithCredentials };

function parseModelList(source) {
  if (typeof source !== 'string' || !source) return null;
  const at = source.indexOf('modelList:[');
  if (at < 0) return null;
  let depth = 0, end = -1;
  for (let i = source.indexOf('[', at); i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  const raw = source.slice(source.indexOf('[', at), end);

  const models = [];
  for (const m of raw.matchAll(/\{label:"([^"]*)"([^}]*)\}/g)) {
    const label = m[1];
    const rest = m[2];
    const pick = key => {
      const x = new RegExp(`${key}:("([^"]*)"|!0|!1|null|\\[[^\\]]*\\]|[\\d.]+)`).exec(rest);
      if (!x) return undefined;
      const v = x[1];
      if (v === '!0') return true;
      if (v === '!1') return false;
      if (v === 'null') return null;
      if (v.startsWith('[')) {
        return [...v.matchAll(/"([^"]*)"/g)].map(y => y[1]);
      }
      if (/^[\d.]+$/.test(v)) return Number(v);
      return v.replace(/^"|"$/g, '');
    };
    const id = pick('value');
    if (typeof id !== 'string' || !id) continue;
    const thinkingParam = pick('thinkingParam');
    const thinkingField = pick('thinkingField');
    models.push({
      id,
      label: label || id,
      supportImage: pick('supportImage') === true,
      thinkingParam: thinkingParam === undefined ? undefined : thinkingParam,
      thinkingField: thinkingField === undefined ? undefined : thinkingField,
      effortOptions: pick('effortOptions') || [],
    });
  }
  return models.length ? models : null;
}

const PROBE_CONCURRENCY = 8;

async function discoverModels({ upstreamUrl, candidates, token, cookie, tunnelMode, timeoutMs = 60000, fetchImpl = fetch } = {}) {
  const list = [...new Set(candidates || [])].filter(Boolean);
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const id = list[i];
      const r = await probeModel({ upstreamUrl, model: id, token, cookie, tunnelMode, timeoutMs, fetchImpl });
      results[i] = { id, ...r };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, list.length) }, worker),
  );
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.ms || 1e9) - (b.ms || 1e9);
  });
}

function formatModelTable(results) {
  if (!results || !results.length) return [];
  const lines = [];
  const idW = Math.max(6, ...results.map(r => r.id.length));
  lines.push(`  ${'模型'.padEnd(idW)}  ${'状态'.padEnd(10)}  延迟`);
  for (const r of results) {
    const status = r.ok ? '可用' : (r.reason === 'not-found' ? '不存在'
      : r.reason === 'busy' ? '繁忙' : r.reason === 'session' ? '会话失效'
        : r.reason === 'timeout' ? '超时' : '未知');
    const ms = Number.isFinite(r.ms) && r.ms > 0 ? `${r.ms}ms` : '-';
    lines.push(`  ${r.id.padEnd(idW)}  ${status.padEnd(10)}  ${ms}`);
  }
  return lines;
}
