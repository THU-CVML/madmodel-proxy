// 请求编排：认证、参数归一、预算预检、流式转发与工具调用补救。

'use strict';

const { normalizePayload, parseJsonBody, fitTokenBudget } = require('./payload');
const { translateUpstreamError, describeFailedStream } = require('./errors');
const { createAggregator } = require('./completion-aggregator');
const { getTokenizer } = require('./tokenizer');
const { parseToolCalls, stripToolMarkup, shouldProbeSwallowedCall } = require('./dsml');
const { readReasoningDelta, normalizeCompletionReasoning, normalizeReasoningDelta } = require('./thinking');

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function busyHint(payload, contextWindow) {
  return {
    promptTokens: getTokenizer().countPromptTokens(payload),
    tokenBudget: typeof payload.max_tokens === 'number' ? payload.max_tokens : 0,
    contextWindow,
  };
}

function createProxyService(deps) {
  const { config, tokenState, upstreamClient, onTunnelAuthLost, waitForCredentials, modelRegistry } = deps;
  let inflight = 0;

  function requestedModel(payload) {
    const m = payload && payload.model;
    return typeof m === 'string' ? m.trim() : '';
  }

  function metaFor(model) {
    try {
      if (modelRegistry && typeof modelRegistry.snapshot === 'function') {
        const found = modelRegistry.snapshot().find(m => m && m.id === model);
        const meta = found && found.meta;
        if (meta && (meta.thinkingParam === null ||
            (typeof meta.thinkingParam === 'string' && meta.thinkingParam))) return meta;
      }
    } catch (e) { /* 清单异常不该让请求失败:继续走兜底 */ }
    const fb = config.thinkingFallback;
    if (fb && typeof fb === 'object' && fb[model]) return fb[model];
    return null;
  }

  const clientAskedTools = payload => Array.isArray(payload?.tools) && payload.tools.length > 0;

  // Qwen 降级后的 none 来自代理，不能等同于客户端明确禁用工具。
  const toolsForbidden = payload => {
    if (payload && payload.__toolsDowngraded) {
      return payload.__clientToolChoiceNone === true;
    }
    const tc = payload?.tool_choice;
    if (typeof tc === 'string') return tc.trim().toLowerCase() === 'none';
    if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
      return typeof tc.type === 'string' && tc.type.trim().toLowerCase() === 'none';
    }
    return false;
  };

  function looksLikeEmptyToolResponse(agg) {
    const calls = agg.toolCalls;
    const hasCalls = Array.isArray(calls) ? calls.length > 0 : !!(calls && Object.keys(calls).length);
    if (hasCalls) return false;                             // 已有结构化调用,不干预
    if (agg.finish && agg.finish !== 'stop') return false;  // length/content_filter 等不算
    return true;                                            // 带 tools 却无调用:值得确认
  }

  // 只重发一次，使用独立超时并响应客户端取消。
  async function retryForToolCalls(payload, auth, signal) {
    const retryPayload = { ...payload, stream: false };
    delete retryPayload.stream_options; // 非流式不需要 usage 注入
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) return null;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer = null;
    let result;
    try {
      result = await Promise.race([
        upstreamClient.request({
          payload: retryPayload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
          headerTimeoutMs: config.toolCallRetryTimeoutMs,
        }),
        new Promise(res => {
          timer = setTimeout(() => { ac.abort(); res({ type: 'timeout', phase: 'total' }); }, config.toolCallRetryTimeoutMs);
        }),
      ]);
    } catch (e) { return null; } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (!result || result.type !== 'completion') return null;
    const msg = result.body?.choices?.[0]?.message || {};
    const calls = parseToolCalls(typeof msg.content === 'string' ? msg.content : '', payload.tools);
    return {
      toolCalls: calls || [],
      usage: result.body?.usage,
    };
  }

  function reportTunnelAuthLost(result) {
    if (onTunnelAuthLost && config.tunnelMode &&
      result.type === 'upstream-error' && result.status >= 300 && result.status < 400) {
      onTunnelAuthLost();
    }
  }

  function logReq(req, status, started, size, note, model) {
    const where = model || (req?.method ? `${req.method} ${String(req.url || '').split('?')[0]}` : '');
    const detail = String(note || '').replace(/\s+/g, ' ').trim();
    console.log(`[${stamp()}] ${String(where).replace(/\s+/g, ' ')} ${status} ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s` +
      (!model && size ? ` ${(size / 1024).toFixed(0)}KB` : '') + (detail ? ` ${detail}` : ''));
  }

  function idleNote(result) {
    return Number.isFinite(result?.idleMs) ? ` idle=${(result.idleMs / 1000).toFixed(1)}s` : '';
  }

  const tokTotal = { p: 0, c: 0 };
  function usageNote(...usages) {
    const known = usages.filter(u => u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number');
    if (!known.length) return '';
    const p = known.reduce((n, u) => n + u.prompt_tokens, 0);
    const c = known.reduce((n, u) => n + u.completion_tokens, 0);
    const r = known.reduce((n, u) => {
      const value = u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens;
      return n + (typeof value === 'number' ? value : 0);
    }, 0);
    tokTotal.p += p;
    tokTotal.c += c;
    const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    return ` | token ${p}/${c}` + (r ? `(思考 ${r})` : '') +
      ` 累计 ${fmt(tokTotal.p)}/${fmt(tokTotal.c)}`;
  }

  function authenticateRequest() {
    const ts = tokenState();
    if (ts.code === 'no-token') {
      return { error: { status: 503, message: '尚未登录，请运行 node refresh-token.js login' } };
    }
    if (ts.code === 'token-expired') {
      return { error: { status: 401, message: 'token 已过期，请等待自动续期；若未启动 watch，请运行 npm start。', type: 'auth_error' } };
    }
    return { token: ts.token, msLeft: ts.msLeft, cookie: ts.cookie };
  }

  // 常规请求强制上游 SSE，客户端的非流式响应由 aggregateResponse 聚合。
  function preparePayload(ctx) {
    let payload;
    try {
      payload = parseJsonBody(ctx.rawBody);
    } catch (e) {
      return { error: { status: 400, message: e.message } };
    }
    const clientWantsStream = payload.stream === true;
    payload.stream = true; // 对上游强制流式(绕 60s nginx 非流式超时)
    if (!payload.stream_options || typeof payload.stream_options !== 'object' || Array.isArray(payload.stream_options)) {
      payload.stream_options = { include_usage: true };
    } else {
      payload.stream_options.include_usage = payload.stream_options.include_usage === false ? false : true;
    }
    const model = requestedModel(payload);
    const limits = typeof config.limitsFor === 'function' ? config.limitsFor(model) : null;
    normalizePayload(payload, model, metaFor(model),
      limits ? limits.maxOutputTokens : undefined);
    downgradeToolsFor(payload, model);
    return {
      payload, clientWantsStream,
      contextWindow: limits ? limits.contextWindow : config.contextWindow,
    };
  }

  // Qwen 当前拒绝原生工具参数；保留定义供文本恢复，明确的客户端 none 不改。
  function downgradeToolsFor(payload, model) {
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const rejects = typeof config.rejectsTools === 'function' && config.rejectsTools(model);
    if (!hasTools || !rejects || toolsForbidden(payload)) return;
    payload.__clientToolChoiceNone = false; // 走到这里说明客户端没要 none
    payload.tool_choice = 'none';
    payload.__toolsDowngraded = true;
  }

  function mapResult(result, prefix, sentBytes) {
    switch (result.type) {
      case 'timeout':
        if (result.phase === 'idle') {
          return { status: 504, note: 'idle-timeout',
            message: `上游 ${config.streamIdleTimeout / 1000}s 无数据，请重试。` };
        }
        if (result.phase === 'headers') {
          const message = `上游 ${config.upstreamHeaderTimeout / 1000}s 未响应，请检查网络或稍后重试。`;
          return { status: 502, note: 'headers-timeout', message };
        }
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'protocol-error':
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'network-error':
        return { status: 502, note: 'network-error',
          message: `连接上游失败: ${String(result.cause).slice(0, 120)}` };
      default:
        return null; // stream/completion/upstream-error/aborted 由调用方分支处理
    }
  }

  function failRequest(ctx, mapped) {
    logReq(ctx.req, mapped.status, ctx.started, ctx.size, `${mapped.note} ${mapped.message}`);
    if (!ctx.sseHeadersSent()) return ctx.sendError(mapped.status, mapped.message);
    ctx.endResponse();
  }

  async function handleRequest(ctx) {
    const auth = authenticateRequest();
    if (auth.error) {
      logReq(ctx.req, auth.error.status, ctx.started, ctx.size, auth.error.message);
      return ctx.sendError(auth.error.status, auth.error.message, auth.error.type);
    }
    const extraHeaders = auth.msLeft < 30 * 60 * 1000 ? { 'X-Token-Refresh-Hint': 'expiring' } : {};
    ctx.setExtraHeaders(extraHeaders);

    const prepared = preparePayload(ctx);
    if (prepared.error) {
      logReq(ctx.req, 400, ctx.started, ctx.size, prepared.error.message);
      return ctx.sendError(400, prepared.error.message);
    }
    const { payload, clientWantsStream, contextWindow } = prepared;

    const promptTokens = getTokenizer().countPromptTokens(payload);
    const fit = fitTokenBudget(promptTokens, payload, contextWindow);
    if (!fit.ok) {
      logReq(ctx.req, 413, ctx.started, ctx.size, fit.message, payload.model);
      return ctx.sendError(413, fit.message);
    }
    const budgetNote = fit.note ? ` 输出预算 ${payload.max_tokens}` : '';

    if (inflight >= config.inflightHardLimit) {
      logReq(ctx.req, 429, ctx.started, ctx.size, `并发已满 ${inflight}/${config.inflightHardLimit}`, payload.model);
      return ctx.sendError(429,
        `并发请求已达上限 ${config.inflightHardLimit}，请降低并发或稍后重试。`,
        'rate_limit');
    }

    const ac = ctx.abortController;
    let inflightHeld = false;
    const hold = () => { if (!inflightHeld) { inflightHeld = true; inflight++; } };
    const release = () => { if (inflightHeld) { inflightHeld = false; inflight--; } };
    hold();
    try {
      const attempt = a => clientWantsStream
        ? streamPassthrough(ctx, payload, a, extraHeaders, budgetNote, ac, contextWindow)
        : aggregateResponse(ctx, payload, a, extraHeaders, budgetNote, ac, contextWindow);
      let r = await attempt(auth);
      if (r && r.retryAuth) {
        if (config.tunnelMode && waitForCredentials) {
          release(); // 等待期间无上游请求,不占并发槽
          const fresh = await sharedCredentialWait(auth.token, auth.cookie);
          if (ctx.clientGone()) return;
          if (fresh) {
            hold();
            logReq(ctx.req, 100, ctx.started, ctx.size, '凭据已更新，重试中');
            const a2 = { token: fresh.token, cookie: fresh.cookie };
            const r2 = await attempt(a2);
            if (!(r2 && r2.retryAuth)) return; // 重试已交付响应(成功或错误)
            logReq(ctx.req, 502, ctx.started, ctx.size, 'WebVPN 新凭据被拒绝，请重新登录');
            return ctx.sendError(502,
              'WebVPN 会话已失效，新凭据仍被拒绝。请运行 node refresh-token.js login。',
              'upstream_error', extraHeaders);
          }
          logReq(ctx.req, 502, ctx.started, ctx.size,
            `WebVPN 续期等待超时（${Math.round(config.waitRetryBudgetMs / 1000)}s）`);
          return ctx.sendError(502,
            `WebVPN 会话已失效，${Math.round(config.waitRetryBudgetMs / 1000)}s 内未完成续期。请确认 watch 在运行后重试。`,
            'upstream_error', extraHeaders);
        }
        if (ctx.clientGone()) return;
        logReq(ctx.req, 502, ctx.started, ctx.size, '上游要求重新登录，请检查地址与登录状态');
        return ctx.sendError(502,
          '上游要求重新登录，请检查上游地址与登录状态。',
          'upstream_error', extraHeaders);
      }
      return r;
    } finally {
      release();
    }
  }

  // 同一旧凭据的并发请求共享一次等待，避免重复监听。
  let inflightWait = null; // { key, promise }
  function sharedCredentialWait(usedToken, usedCookie) {
    const key = `${usedToken}\u0000${usedCookie || ''}`;
    if (!inflightWait || inflightWait.key !== key) {
      const promise = waitForCredentials(usedToken, usedCookie, config.waitRetryBudgetMs)
        .finally(() => { if (inflightWait && inflightWait.key === key) inflightWait = null; });
      inflightWait = { key, promise };
    }
    return inflightWait.promise;
  }

  async function writeRecovered(ctx, model, calls, content, usage) {
    const base = { id: `chatcmpl-toolfix-${Date.now().toString(36)}`,
      object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
    if (content) await ctx.writeSseChunk({ ...base, choices: [{ index: 0,
      delta: { role: 'assistant', content }, finish_reason: null }] });
    await ctx.writeSseChunk({ ...base, choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: calls.map((tc, index) => ({ ...tc, index })) },
      finish_reason: 'tool_calls' }] });
    if (usage) await ctx.writeSseChunk({ ...base, choices: [], usage });
    await ctx.writeSseLine('data: [DONE]\n\n');
    ctx.endResponse();
  }

  async function streamPassthrough(ctx, payload, auth, extraHeaders, budgetNote, ac, contextWindow) {
    const { req, started, size } = ctx;
    const servedModel = payload.model;
    // 思考即时发送；正文与收尾暂存，确认无需补救或解析结束后发送。
    const bufferFrames = config.toolCallFix && clientAskedTools(payload) && !toolsForbidden(payload);
    const spMeta = metaFor(payload.model);
    const streamThinkingField = spMeta && typeof spMeta.thinkingField === 'string' ? spMeta.thinkingField : null;
    if (typeof ctx.setThinkingFields === 'function') ctx.setThinkingFields(streamThinkingField);
    const buffered = [];
    let sawStructured = false;
    let streamFinish = null;
    let bufferFramesOff = false; // 见到结构化调用后停用缓冲,转逐帧透传
    let bufferedText = '';       // 缓冲期间累积的 content(用于"先从文本解析")
    let bufferedReasoning = '';  // 同时累积 reasoning(判据要看得见思考链,见下)

    const result = await upstreamClient.request({
      payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
      onChunk: async (obj) => {
        if (bufferFrames && !bufferFramesOff) {
          const ch = obj?.choices?.[0];
          const d = ch?.delta || {};
          if (Array.isArray(d.tool_calls) && d.tool_calls.length) sawStructured = true;
          if (typeof d.content === 'string') bufferedText += d.content;
          const rDelta = readReasoningDelta(d, streamThinkingField);
          if (rDelta !== null) bufferedReasoning += rDelta;
          if (ch?.finish_reason) streamFinish = ch.finish_reason;
          if (sawStructured) {
            ctx.ensureSseHeaders();
            for (const f of buffered) await ctx.writeSseChunk(f);
            buffered.length = 0;
            bufferFramesOff = true;
            await ctx.writeSseChunk(obj);
            return;
          }
          const hasHeld = (typeof d.content === 'string' && d.content !== '') ||
            (Array.isArray(d.tool_calls) && d.tool_calls.length) || ch?.finish_reason || obj?.usage;
          if (!hasHeld) {
            ctx.ensureSseHeaders();
            await ctx.writeSseChunk(obj);
            return;
          }
          // 混合帧先交付思考，避免替换正文时丢失它。
          if (rDelta !== null) {
            normalizeReasoningDelta(obj, streamThinkingField);
            const { reasoning_content, ...heldDelta } = obj.choices[0].delta;
            await ctx.writeSseChunk({ ...obj, usage: undefined,
              choices: [{ ...ch, delta: { reasoning_content }, finish_reason: null }] });
            obj = { ...obj, choices: [{ ...ch, delta: heldDelta }] };
          }
          buffered.push(obj);
          return; // content/tool_calls/finish 帧照旧扣留,等 finish 再决定
        }
        ctx.ensureSseHeaders();
        await ctx.writeSseChunk(obj);
      },
    });
    const flushBuffer = async () => {
      if (!buffered.length) return;
      ctx.ensureSseHeaders();
      for (const f of buffered) await ctx.writeSseChunk(f);
      buffered.length = 0;
    };

    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, '客户端已断开', servedModel);
      return;
    }
    if (result.type === 'upstream-error') {
      reportTunnelAuthLost(result);
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      if (!ctx.sseHeadersSent()) {
        ctx.dumpFailed();
        const mapped = translateUpstreamError(result.body, result.raw, result.status, busyHint(payload, contextWindow));
        logReq(req, mapped.http, started, size, mapped.message, servedModel);
        return ctx.sendError(mapped.http, mapped.message, 'upstream_error', extraHeaders);
      }
      ctx.endResponse();
      logReq(req, 200, started, size, `回复中断 ${String(
        result.body?.errorMessage || result.body?.message || result.raw || ''
      ).slice(0, 120).replace(/\s+/g, ' ')}`, servedModel);
      return;
    }
    const mapped = mapResult(result, 'stream', ctx.sseBytes());
    if (mapped) {
      if (mapped.failedStream) {
        if (ctx.sseHeadersSent()) {
          ctx.endResponse();
          logReq(req, 200, started, size, `${mapped.note}${idleNote(result)} ${mapped.message}`, servedModel);
        } else {
          logReq(req, 502, started, size, `${mapped.note}${idleNote(result)} ${mapped.message}`, servedModel);
          ctx.sendError(502, mapped.message);
        }
        return;
      }
      return failRequest(ctx, mapped);
    }
    let recoveryNote = '';
    let retryUsage;
    const evidenceText = bufferedText + bufferedReasoning;
    if (result.type === 'stream' && bufferFrames && !sawStructured &&
        !toolsForbidden(payload) &&
        (!streamFinish || streamFinish === 'stop') &&
        shouldProbeSwallowedCall(evidenceText)) {
      const inline = parseToolCalls(bufferedText, payload.tools);
      if (inline) {
        const prose = stripToolMarkup(bufferedText);
        await writeRecovered(ctx, servedModel, inline, prose, result.usage);
        logReq(req, 200, started, size,
          `工具调用 ${inline.length}（文本恢复）${budgetNote}${usageNote(result.usage)}`, servedModel);
        return;
      }
      const fixed = await retryForToolCalls(payload, auth, ac.signal);
      if (ctx.clientGone()) return;
      retryUsage = fixed?.usage;
      if (fixed?.toolCalls.length) {
        await writeRecovered(ctx, servedModel, fixed.toolCalls, '', fixed.usage);
        logReq(req, 200, started, size,
          `工具调用 ${fixed.toolCalls.length}（重试恢复）${budgetNote}${usageNote(result.usage, retryUsage)}`, servedModel);
        return;
      }
      await flushBuffer();
      recoveryNote = '工具恢复未成功，返回原回复';
    } else if (bufferFrames && buffered.length) {
      await flushBuffer();
    }
    if (result.type === 'completion') {
      const m = result.body.choices?.[0]?.message || {};
      const fbReasoning = readReasoningDelta(m, streamThinkingField);
      const chunk = {
        id: result.body.id,
        object: 'chat.completion.chunk',
        created: result.body.created,
        model: result.body.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            ...(m.content != null ? { content: m.content } : {}),
            ...(fbReasoning != null ? { reasoning_content: fbReasoning } : {}),
            ...(Array.isArray(m.tool_calls) ? {
              tool_calls: m.tool_calls.map((tc, i) => ({
                index: i, id: tc.id, type: tc.type, function: tc.function,
              })),
            } : {}),
          },
          finish_reason: result.body.choices?.[0]?.finish_reason ?? 'stop',
        }],
      };
      await ctx.writeSseChunk(chunk);
      if (result.body.usage) {
        await ctx.writeSseLine(`data: ${JSON.stringify({
          id: result.body.id, object: 'chat.completion.chunk', choices: [], usage: result.body.usage,
        })}\n\n`);
      }
      await ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `流式${budgetNote}${usageNote(result.body?.usage)}`, servedModel);
      return;
    }
    if (ctx.sseHeadersSent()) {
      await ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `${recoveryNote || '流式'}${budgetNote}${usageNote(result.usage, retryUsage)}`, servedModel);
    } else {
      logReq(req, 502, started, size, '上游返回空流', servedModel);
      ctx.sendError(502, '上游返回空流');
    }
  }

  async function aggregateResponse(ctx, payload, auth, extraHeaders, budgetNote, ac, contextWindow) {
    const { req, started, size } = ctx;
    const aggMeta = metaFor(payload.model);
    const aggThinkingField = aggMeta && typeof aggMeta.thinkingField === 'string' ? aggMeta.thinkingField : null;
    const agg = createAggregator(payload.model, aggThinkingField);
    let chunkCount = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(); // 中止上游,迟到的结果不再写响应
      if (!ctx.clientGone() && !ctx.headersSent()) {
        ctx.sendError(504, `生成超时（${config.nonstreamTotalTimeout / 1000}s），请缩短对话或改用流式。`);
      }
    }, config.nonstreamTotalTimeout);
    const result = await upstreamClient.request({
      payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
      onChunk: obj => {
        chunkCount++;
        agg.feed(obj);
      },
    });
    clearTimeout(timer);

    if (timedOut) { // 504 已由定时器发出,这里只补日志
      logReq(req, 504, started, size, '生成超时，请缩短对话或改用流式', payload.model);
      return;
    }
    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, '客户端已断开', payload.model);
      return;
    }
    if (result.type === 'upstream-error') {
      reportTunnelAuthLost(result);
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      ctx.dumpFailed();
      const mapped = translateUpstreamError(result.body, result.raw, result.status, busyHint(payload, contextWindow));
      logReq(req, mapped.http, started, size, mapped.message, payload.model);
      return ctx.sendError(mapped.http, mapped.message, 'upstream_error', extraHeaders);
    }
    const mapped = mapResult(result, 'agg');
    if (mapped) {
      if (mapped.failedStream) {
        logReq(req, 502, started, size, `${mapped.note}${idleNote(result)} ${mapped.message}`, payload.model);
        return ctx.sendError(502, mapped.message);
      }
      return failRequest(ctx, mapped);
    }
    if (result.type === 'completion') {
      normalizeCompletionReasoning(result.body, aggThinkingField);
      logReq(req, 200, started, size, `完成${budgetNote}${usageNote(result.body.usage)}`, payload.model);
      return ctx.sendJson(200, result.body, extraHeaders);
    }
    if (chunkCount === 0) {
      logReq(req, 502, started, size, '上游返回空流', payload.model);
      return ctx.sendError(502, '上游返回空流');
    }
    let recoveryNote = '';
    let retryUsage;
    if (config.toolCallFix && clientAskedTools(payload) && !toolsForbidden(payload)) {
      const aggView = { content: agg.content, toolCalls: agg.toolCalls, finish: agg.finish };
      const evidenceText = (agg.content || '') + (agg.reasoning || '');
      if (looksLikeEmptyToolResponse(aggView)) {
        const inline = parseToolCalls(agg.content || '', payload.tools);
        if (inline) {
          const out1 = agg.result();
          out1.choices[0].message.content = stripToolMarkup(out1.choices[0].message.content || '') || null;
          out1.choices[0].message.tool_calls = inline;
          out1.choices[0].finish_reason = 'tool_calls';
          logReq(req, 200, started, size,
            `工具调用 ${inline.length}（文本恢复）${budgetNote}${usageNote(agg.usage)}`, payload.model);
          return ctx.sendJson(200, out1, extraHeaders);
        }
        const attempted = shouldProbeSwallowedCall(evidenceText);
        const fixed = attempted
          ? await retryForToolCalls(payload, auth, ac.signal)
          : null;
        if (ctx.clientGone()) return;
        retryUsage = fixed?.usage;
        if (fixed?.toolCalls.length) {
          const out2 = agg.result();
          out2.choices[0].message.tool_calls = fixed.toolCalls;
          out2.choices[0].finish_reason = 'tool_calls';
          if (fixed.usage) out2.usage = fixed.usage;
          logReq(req, 200, started, size,
            `工具调用 ${fixed.toolCalls.length}（重试恢复）${budgetNote}${usageNote(agg.usage, retryUsage)}`, payload.model);
          return ctx.sendJson(200, out2, extraHeaders);
        } else if (attempted) {
          recoveryNote = '工具恢复未成功，返回原回复';
        }
      }
    }
    const out = agg.result();
    logReq(req, 200, started, size, `${recoveryNote || '完成'}${budgetNote}${usageNote(agg.usage, retryUsage)}`, payload.model);
    ctx.sendJson(200, out, extraHeaders);
  }

  return { handleRequest, logReq, usageNote };
}

module.exports = { createProxyService };
