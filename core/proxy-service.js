// core/proxy-service.js
// 代理业务流程(纯编排层,不含 HTTP I/O):
//   authenticate -> parse payload -> normalize -> call upstream -> map result
//   -> write response(经 ctx 回调)
// 请求读取、路由、响应写出、token 文件缓存都在 adapters/http-server.js;
// 上游协议在 core/upstream-client.js;判定与映射在这里。
// 每类上游结果只转换一次;客户端断开与聚合超时复用同一个 abort signal。
// 64 以内不设业务层限流(多子代理编排是合法负载);inflight 硬上限(不可配置)
// 只作进程保护,资源兜底的其余部分在 adapters 层:server.maxConnections、
// 请求体/响应体限额与各级超时。

'use strict';

const { normalizePayload, parseJsonBody, fitTokenBudget, checkContentSupport } = require('./payload');
const { translateUpstreamError, describeFailedStream } = require('./errors');
const { createAggregator } = require('./completion-aggregator');
const { getTokenizer } = require('./tokenizer');

// 日志时间戳。固定 HH:MM:SS 而非 toLocaleTimeString:后者随机器 locale 变形
// (12 小时制/中文"下午"),日志被贴进 issue 时不可比对
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

// "服务器繁忙"错误帧的复判参数(translateUpstreamError 消费):本地精确
// prompt token 数 + 实际发出的 max_tokens + 上限。流式/聚合两条错误路径共用。
// 覆盖面很窄(防御性保留,不是主要防线):通过预检门的请求按构造 prompt+预算
// ≤ 上限,413 改判只在 max_tokens 缺省且 prompt 恰达上限的退化边界可达;
// 它防不了上游漂移——漂移时本地与预检用同一套计数,同样低估。主要防线是
// 预检门的精确收缩
function busyHint(payload, config) {
  return {
    promptTokens: getTokenizer().countPromptTokens(payload),
    tokenBudget: typeof payload.max_tokens === 'number' ? payload.max_tokens : 0,
    contextWindow: config.contextWindow,
  };
}

function createProxyService(deps) {
  const { config, tokenState, upstreamClient, onTunnelAuthLost, waitForCredentials } = deps;
  // 活跃上游请求数(进程保护,见 handleRequest 的 inflight 硬上限)
  let inflight = 0;

  // 隧道会话被拒的快速自愈触发:隧道形态下上游 3xx(实测形态 302→/login,
  // WebVPN 会话绑定来源网络,切网即死)→ 通知装配层(proxy.js 写 revive
  // 标志,watch 的目录监听唤醒后 pokeKeepalive 立即探活重签)。节流在注入
  // 方实现,core 只报告事件;直连形态(3xx 是门禁 307,非会话问题)不触发
  function reportTunnelAuthLost(result) {
    if (onTunnelAuthLost && config.tunnelMode &&
      result.type === 'upstream-error' && result.status >= 300 && result.status < 400) {
      onTunnelAuthLost();
    }
  }

  function logReq(req, status, started, size, note) {
    // method+path 进日志:排查"谁在打我"时区分 models 探活与 chat 请求
    const where = req?.method ? `${req.method} ${String(req.url || '').split('?')[0]} ` : '';
    console.log(`[${stamp()}] ${where}${status} ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s ${(size / 1024).toFixed(0)}KB ${note}`);
  }

  // 截断日志补"距上一帧时长"(R2):idleMs 由 upstream-client 记(首帧前为请求
  // 已等待时长),用同一口径的秒数进日志,与错误文案对得上;缺值时不写
  function idleNote(result) {
    return Number.isFinite(result?.idleMs) ? ` idle=${(result.idleMs / 1000).toFixed(1)}s` : '';
  }

  // 会话累计 token(仅内存,重启归零)。usageNote 在每条成功请求的日志处调用并
  // 顺带累加,调用点保持单行
  const tokTotal = { p: 0, c: 0, r: 0 };
  function usageNote(u) {
    if (!u || typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return '';
    tokTotal.p += u.prompt_tokens;
    tokTotal.c += u.completion_tokens;
    const hasR = typeof u.reasoning_tokens === 'number';
    if (hasR) tokTotal.r += u.reasoning_tokens;
    const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    return ` | tok ${u.prompt_tokens}+${u.completion_tokens}` +
      (hasR ? `(r${u.reasoning_tokens})` : '') +
      ` 累计 ${fmt(tokTotal.p)}+${fmt(tokTotal.c)}` + (tokTotal.r ? `(r${fmt(tokTotal.r)})` : '');
  }

  // token 有效性:ok = 可用(附 token 与剩余毫秒);no-token / token-expired
  // 由 adapter 映射为 503/401
  function authenticateRequest() {
    const ts = tokenState();
    if (ts.code === 'no-token') {
      return { error: { status: 503, message: '本地无 token。请先在本项目目录运行: node refresh-token.js login', note: 'no-token' } };
    }
    if (ts.code === 'token-expired') {
      return { error: { status: 401, message: 'token 已过期,等待 watch 守护续期。请确认: node refresh-token.js watch 在运行', note: 'token-expired', type: 'auth_error' } };
    }
    return { token: ts.token, msLeft: ts.msLeft, cookie: ts.cookie };
  }

  // 解析与归一化:返回 {payload, clientWantsStream, normNote} 或带 note 的 400
  function preparePayload(ctx) {
    let payload;
    try {
      payload = parseJsonBody(ctx.rawBody);
    } catch (e) {
      return { error: {
        status: 400, message: e.message,
        note: e.code === 'INVALID_JSON' ? 'bad-json' : 'not-object',
      } };
    }
    // 图片/多模态输入预检(1.9.2,R1):上方含图 → 上游 0.1~0.2s 秒拒并伪装成
    // "服务器繁忙",客户端带退避无限重试而每轮历史都带图,会话从此永久失败。
    // 就地 400 说清原因与处置(不静默剥离图片,理由见 core/payload.js)。
    // 位置在分词预检之前——这类请求体积可能极大(base64),不必先花分词成本
    const contentCheck = checkContentSupport(payload, config.model);
    if (!contentCheck.ok) {
      return { error: { status: 400, message: contentCheck.message, note: 'image-input' } };
    }
    const clientWantsStream = payload.stream === true;
    payload.stream = true; // 对上游强制流式(绕 60s nginx 非流式超时)
    // 上游 usage 默认不回,仅在 stream_options.include_usage 时返回(含
    // reasoning_tokens 单独计数)。注入后:聚合路径得到真实 usage,透传路径
    // 客户端会多收一个标准 usage chunk(空 choices,OpenAI 规范形态)。
    // 客户端发了 {}/非对象值也补齐;仅显式布尔 false 尊重客户端,其余非法值
    // (null/0/"false" 等)归一为 true,不能原样发往上游(usage 会消失)
    if (!payload.stream_options || typeof payload.stream_options !== 'object' || Array.isArray(payload.stream_options)) {
      payload.stream_options = { include_usage: true };
    } else {
      payload.stream_options.include_usage = payload.stream_options.include_usage === false ? false : true;
    }
    const normalized = normalizePayload(payload, config.model);
    return { payload, clientWantsStream, normNote: normalized.length ? ` norm[${normalized.join(' ')}]` : '' };
  }

  // 上游结果 → 终态描述({status, note, message};failed-stream 带标记,两条
  // 路径对它的收尾各有额外上下文要记)。每类结果只在这里转换一次,
  // 流式/聚合仅在 note 前缀不同。sentBytes 供截断文案说明"已交付到第 N KB"
  // (流式路径传已写出的字节数,聚合路径无交付不传)
  function mapResult(result, prefix, sentBytes) {
    switch (result.type) {
      case 'timeout':
        if (result.phase === 'idle') {
          return { status: 504, note: 'idle-timeout',
            message: `上游流式空闲超时(${config.streamIdleTimeout / 1000}s 无数据)` };
        }
        if (result.phase === 'headers') {
          const message = `上游 ${config.upstreamHeaderTimeout / 1000}s 未返回响应头(连接或网关挂起)`;
          return { status: 502, note: `proxy-err:${message.slice(0, 60)}`, message };
        }
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'protocol-error':
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'network-error':
        return { status: 502, note: `proxy-err:${String(result.cause).slice(0, 60)}`,
          message: `代理到上游请求失败: ${result.cause}` };
      default:
        return null; // stream/completion/upstream-error/aborted 由调用方分支处理
    }
  }

  // 统一错误收尾:记一条日志,未发头回错误响应;流式路径若 SSE 头已发出,
  // 状态码无法再改,只能断流让客户端按截断处理
  function failRequest(ctx, mapped) {
    logReq(ctx.req, mapped.status, ctx.started, ctx.size, mapped.note);
    if (!ctx.sseHeadersSent()) return ctx.sendError(mapped.status, mapped.message);
    ctx.endResponse();
  }

  async function handleRequest(ctx) {
    // ---- authenticate(顺序与既有行为一致:empty-body 之后、JSON 解析之前)
    const auth = authenticateRequest();
    if (auth.error) {
      logReq(ctx.req, auth.error.status, ctx.started, ctx.size, auth.error.note);
      return ctx.sendError(auth.error.status, auth.error.message, auth.error.type);
    }
    // 续期提示头:两条应答路径都带上(流式路径经 sseHeaders 注入)
    const extraHeaders = auth.msLeft < 30 * 60 * 1000 ? { 'X-Token-Refresh-Hint': 'expiring' } : {};
    ctx.setExtraHeaders(extraHeaders);

    // ---- parse + normalize
    const prepared = preparePayload(ctx);
    if (prepared.error) {
      logReq(ctx.req, 400, ctx.started, ctx.size, prepared.error.note);
      return ctx.sendError(400, prepared.error.message);
    }
    const { payload, clientWantsStream, normNote } = prepared;

    // ---- 上游前的精确预检(1.6.0 起):上游按 prompt_tokens+max_tokens ≤
    // 262,144 逐 token 校验(2026-09-10 实测,边界随 prompt 精确平移),本地
    // 分词器与上游逐 token 一致(core/tokenizer.js)。超限不再拒绝:把
    // max_tokens 收到剩余空间再发——max_tokens 是输出上限而非目标,收缩对
    // 绝大多数请求无感,代价仅高位长输出需续写(finish_reason:length)。
    // 剩余空间放不下最小输出预算(512)才 413:prompt 本身超限。
    // max_tokens 缺省时仅在 prompt 本身超限才 413(上游缺省输出预算未知,
    // 不注入不收缩,交上游仲裁)
    const promptTokens = getTokenizer().countPromptTokens(payload);
    const fit = fitTokenBudget(promptTokens, payload, config.contextWindow);
    if (!fit.ok) {
      logReq(ctx.req, 413, ctx.started, ctx.size, `tokens=${promptTokens}`);
      return ctx.sendError(413, fit.message);
    }
    const gateNote = normNote + fit.note;

    // ---- 进程保护硬上限:非常规业务限流——多子代理编排(几十路并发)是合法
    // 负载,64 远在其上;上限防的是失控客户端紧循环把进程内存/连接拖垮
    // (非流式聚合单流最多缓冲 64MB 响应)。不可配置:调高它只是把保护拆了。
    // maxConnections=32 只限 TCP 连接数,keep-alive 多路复用可绕过,故需此层。
    if (inflight >= config.inflightHardLimit) {
      logReq(ctx.req, 429, ctx.started, ctx.size, `overload:inflight=${inflight}`);
      return ctx.sendError(429,
        `代理过载保护:${inflight} 个请求并发处理中(硬上限 ${config.inflightHardLimit},进程保护)。请降低客户端并发或稍后重试。`,
        'rate_limit');
    }

    // ---- 上游调用(64 以内不设业务层限流)。
    // === 异常契约 ===
    // 真实 upstream-client.request() 只 resolve 结果对象、不 reject(其文件头
    // 契约);若 mock/未来实现意外 reject,本 try/finally 仍保证 inflight 释放,
    // 异常向上传播到 http-server 的 .catch 兜底:响应未发出时转 500
    // (proxy-panic 日志),已发出则只结束连接、不写任何新响应。
    // 客户端断开/聚合超时复用同一个 abort signal(adapter 建)
    const ac = ctx.abortController;
    // inflight 的释放幂等化:等待重试期间没有上游请求在飞,应释放槽位
    // (一场切网的多路并发等待不能占满 64 上限),重试时再占用
    let inflightHeld = false;
    const hold = () => { if (!inflightHeld) { inflightHeld = true; inflight++; } };
    const release = () => { if (inflightHeld) { inflightHeld = false; inflight--; } };
    hold();
    try {
      const attempt = a => clientWantsStream
        ? streamPassthrough(ctx, payload, a, extraHeaders, gateNote, ac)
        : aggregateResponse(ctx, payload, a, extraHeaders, gateNote, ac);
      let r = await attempt(auth);
      // A1 等待重试:确认的 WebVPN 会话失效(3xx 且 Location 指向登录页,
      // 头未发出——attempt 以 {retryAuth} 交回,未交付任何响应)。可等待
      // (隧道形态且注入了等待器)则走等待重试;不可等待的形态就地交付
      // 会话失效错误,绝不能带着未交付的响应返回。
      // 等待流程:revive 标志已写出,watch 秒级重签;等凭据组合(token+
      // cookie)变化后重试一次——用户从"切网后第一句必失败"变成"第一句
      // 慢几秒"。五条件:仅确认的会话失效重定向、凭据指纹为组合、变化后
      // 即重试、最多一次、等待不占上游槽位且各请求在结果后自查客户端
      // 取消;已生成内容(头已发)或不明失败不在此路径。预算(默认 30s)
      // 是等待上限非恢复保证
      if (r && r.retryAuth) {
        if (config.tunnelMode && deps.waitForCredentials) {
          release(); // 等待期间无上游请求,不占并发槽
          const fresh = await sharedCredentialWait(auth.token, auth.cookie);
          if (ctx.clientGone()) return;
          if (fresh) {
            hold();
            logReq(ctx.req, 100, ctx.started, ctx.size, `auth-retry:凭据已更新,重试一次`);
            const a2 = { token: fresh.token, cookie: fresh.cookie };
            const r2 = await attempt(a2);
            if (!(r2 && r2.retryAuth)) return; // 重试已交付响应(成功或错误)
            // 重试仍是会话失效:新凭据也过不了(登录态真死),快交付
            logReq(ctx.req, 502, ctx.started, ctx.size, 'upstream-err 会话失效;重试仍失效');
            return ctx.sendError(502,
              'WebVPN 会话已失效,且更新后的凭据仍被拒绝(登录态可能已过期)。请稍后重试;持续出现请运行 node refresh-token.js login。',
              'upstream_error', extraHeaders);
          }
          logReq(ctx.req, 502, ctx.started, ctx.size,
            `upstream-err 会话失效;${Math.round(config.waitRetryBudgetMs / 1000)}s 内未见新凭据`);
          return ctx.sendError(502,
            `WebVPN 会话已失效(上游 302 跳转登录页)。自动重签未在 ${Math.round(config.waitRetryBudgetMs / 1000)} 秒等待预算内完成,请稍后重试;持续出现请确认 watch 守护在运行。`,
            'upstream_error', extraHeaders);
        }
        // 非隧道形态出现登录重定向(理论不该发生):快交付,不空等
        if (ctx.clientGone()) return;
        logReq(ctx.req, 502, ctx.started, ctx.size, 'upstream-err 会话失效(非隧道形态的登录重定向)');
        return ctx.sendError(502,
          '上游以登录重定向拒绝请求(会话失效形态)。请稍后重试;持续出现请确认配置。',
          'upstream_error', extraHeaders);
      }
      return r;
    } finally {
      release();
    }
  }

  // 同一场会话失效的等待去重:同一凭据指纹(token+cookie)的多个并发请求
  // 共享一个轮询——首个进入者等待,其余 await 同一 Promise,凭据变化一次
  // 性唤醒全部(64 路子代理编排是本工具主场景,不去重则一场切网的等待
  // 轮询 ×64)。等待不带 per-request signal:个别客户端断开不应中止他人
  // 的等待,断开方在 resolve 后自查 clientGone 静默返回
  let inflightWait = null; // { key, promise }
  function sharedCredentialWait(usedToken, usedCookie) {
    const key = `${usedToken}\u0000${usedCookie || ''}`;
    if (!inflightWait || inflightWait.key !== key) {
      const promise = deps.waitForCredentials(usedToken, usedCookie, config.waitRetryBudgetMs)
        .finally(() => { if (inflightWait && inflightWait.key === key) inflightWait = null; });
      inflightWait = { key, promise };
    }
    return inflightWait.promise;
  }

  // ---- 流式透传 ----
  // auth: { token, cookie } —— cookie 为 WebVPN 隧道会话凭证,可缺省。
  // 确认的隧道会话失效(3xx + /login)以 {retryAuth} 交回调用方,交付决策
  // (等待重试/快失败/重试仍失效)全部在 handleRequest 收敛
  async function streamPassthrough(ctx, payload, auth, extraHeaders, normNote, ac) {
    const { req, started, size } = ctx;
    const result = await upstreamClient.request({
      payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
      onChunk: async (obj) => {
        // SSE 头延迟到首帧数据再发:上游"开流即报错"(SSE 内嵌 errorMessage,
        // 如超上下文/繁忙)时头尚未发出,upstream-error 分支能以真实状态码
        // 交付翻译后的错误;在 onOpen(响应头一到)就发头的话,客户端只能
        // 看到无 [DONE] 的空流。onChunk 里这行同时覆盖正常流的首帧
        ctx.ensureSseHeaders();
        await ctx.writeSseChunk(obj);
      },
    });

    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, 'client-disconnected');
      return;
    }
    if (result.type === 'upstream-error') {
      reportTunnelAuthLost(result);
      // A1 等待重试:确认的 WebVPN 会话失效——3xx 且 Location 指向登录页
      // (实测隧道签名为 302 → /login;直连门禁 307 指向 oauth 不含 /login,
      // 不会误入)。头未发出时一律以 {retryAuth} 交回调用方,不内联交付
      // ——交付决策(等待重试/快失败/重试仍失效)全部在 handleRequest
      // 收敛,避免调用方与交付方分裂;revive 标志已由 reportTunnelAuthLost 写出
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      if (!ctx.sseHeadersSent()) {
        ctx.dumpFailed();
        const mapped = translateUpstreamError(result.body, result.raw, result.status, busyHint(payload, config));
        logReq(req, mapped.http, started, size,
          `upstream-err raw=${String(result.raw || '').slice(0, 150).replace(/\s+/g, ' ')}`);
        return ctx.sendError(mapped.http, mapped.message, 'upstream_error', extraHeaders);
      }
      // 头已发出(SSE 200),状态码无法再改:断流让客户端按截断处理;日志
      // 带上游错误原文(含 SSE 内嵌 errorMessage 形态),不记成无来由的 200
      ctx.endResponse();
      logReq(req, 200, started, size, `stream-aborted upstream-err=${String(
        result.body?.errorMessage || result.body?.message || result.raw || ''
      ).slice(0, 120).replace(/\s+/g, ' ')}`);
      return;
    }
    const mapped = mapResult(result, 'stream', ctx.sseBytes());
    if (mapped) {
      // failed-stream:不能补 [DONE] 伪装成完整回答。已发头则断流,客户端的
      // 截断检测/重试接手;stream-invalid 携带坏帧预览让日志有"为什么"可查
      if (mapped.failedStream) {
        if (ctx.sseHeadersSent()) {
          ctx.endResponse();
          logReq(req, 200, started, size, `${mapped.note}${idleNote(result)},${(ctx.sseBytes() / 1024).toFixed(1)}KB` +
            (result.message ? ` ${result.message.slice(0, 70)}` : ''));
        } else {
          logReq(req, 502, started, size, `${mapped.note}${idleNote(result)}`);
          ctx.sendError(502, mapped.message);
        }
        return;
      }
      return failRequest(ctx, mapped);
    }
    if (result.type === 'completion') {
      // 上游对 stream:true 异常地回完整 JSON completion:重组为 delta 形态的
      // chunk 交付——OpenAI 流式规范没有 message 形态的 chunk,原样透传会被
      // 严格 SDK 当空内容。id/created/model/usage 原样保留
      const m = result.body.choices?.[0]?.message || {};
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
            ...(m.reasoning_content != null ? { reasoning_content: m.reasoning_content } : {}),
            ...(Array.isArray(m.tool_calls) ? {
              tool_calls: m.tool_calls.map((tc, i) => ({
                index: i, id: tc.id, type: tc.type, function: tc.function,
              })),
            } : {}),
          },
          finish_reason: result.body.choices?.[0]?.finish_reason ?? 'stop',
        }],
      };
      ctx.ensureSseHeaders();
      ctx.writeSseLine(`data: ${JSON.stringify(chunk)}\n\n`);
      if (result.body.usage) {
        ctx.writeSseLine(`data: ${JSON.stringify({
          id: result.body.id, object: 'chat.completion.chunk', choices: [], usage: result.body.usage,
        })}\n\n`);
      }
      ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `stream,json-fallback${usageNote(result.body?.usage)}${normNote}`);
      return;
    }
    // result.type === 'stream'
    if (ctx.sseHeadersSent()) {
      ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `stream,${(ctx.sseBytes() / 1024).toFixed(1)}KB${usageNote(result.usage)}${normNote}`);
    } else {
      // 上游 event-stream 但零 chunk(异常)
      logReq(req, 502, started, size, 'empty-stream');
      ctx.sendError(502, '上游返回空流');
    }
  }

  // ---- 非流式:聚合 SSE ----
  async function aggregateResponse(ctx, payload, auth, extraHeaders, normNote, ac) {
    const { req, started, size } = ctx;
    const agg = createAggregator(config.model);
    let chunkCount = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(); // 中止上游,迟到的结果不再写响应
      if (!ctx.clientGone() && !ctx.headersSent()) {
        ctx.sendError(504, `聚合超时(${config.nonstreamTotalTimeout / 1000}s)。上游生成时间过长,建议客户端改用 stream:true`);
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
      logReq(req, 504, started, size, 'agg-timeout');
      return;
    }
    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, 'client-disconnected');
      return;
    }
    if (result.type === 'upstream-error') {
      reportTunnelAuthLost(result);
      // A1 等待重试(与流式路径同判定):确认的登录重定向(3xx + /login)
      // 一律交回调用方,不内联交付(见流式路径注释)
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      ctx.dumpFailed();
      const mapped = translateUpstreamError(result.body, result.raw, result.status, busyHint(payload, config));
      logReq(req, mapped.http, started, size,
        `upstream-err raw=${String(result.raw || '').slice(0, 150).replace(/\s+/g, ' ')}`);
      return ctx.sendError(mapped.http, mapped.message, 'upstream_error', extraHeaders);
    }
    const mapped = mapResult(result, 'agg');
    if (mapped) {
      // failed-stream:未以合法 [DONE] 结束即失败,不把半截回答当完整 completion 交付
      if (mapped.failedStream) {
        logReq(req, 502, started, size, `${mapped.note}${idleNote(result)},${chunkCount}chunks`);
        return ctx.sendError(502, `${mapped.message},已收 ${chunkCount} 块,请重试`);
      }
      return failRequest(ctx, mapped);
    }
    if (result.type === 'completion') {
      // 上游直接给了完整 JSON completion:原样交付。
      // 不能喂给聚合器——feed 只认 delta 形态,message 会被丢成空内容
      logReq(req, 200, started, size, `json-completion${usageNote(result.body.usage)}${normNote}`);
      return ctx.sendJson(200, result.body, extraHeaders);
    }
    if (chunkCount === 0) {
      // 上游 event-stream 但零 chunk(异常):不应伪装成空 completion 的 200
      logReq(req, 502, started, size, 'empty-stream');
      return ctx.sendError(502, '上游返回空流');
    }
    const out = agg.result();
    logReq(req, 200, started, size, `agg,${chunkCount}chunks${usageNote(agg.usage)}${normNote}`);
    ctx.sendJson(200, out, extraHeaders);
  }

  return { handleRequest, logReq, usageNote };
}

module.exports = { createProxyService };
