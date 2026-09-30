// core/payload.js
// 请求参数归一化(纯函数,只修改传入 payload,不读环境变量、不做 I/O)。
// 行为契约见 README"边界"与 CHANGELOG 1.1.0"参数归一化"。

'use strict';

const { applyThinking, readThinkingIntent } = require('./thinking');

const UPSTREAM_REJECTED = ['logprobs', 'top_logprobs'];

// 代理内部字段的保留前缀。**客户端不得使用**:这些键是代理各层之间传递状态的
// 约定(如 `__toolsDowngraded` 标记"tool_choice 是代理为解决模型拒收 tools 而
// 降级设的,不同于客户端要求的 none")。若客户端能自行塞入同名键,就能伪造这类
// 判断——2026-09-28 审阅实测复现:请求带 `tool_choice:'none'` 再加
// `__toolsDowngraded:true`,可让代理把一段"讲解工具格式"的说明文合成为真的
// tool_calls 交给客户端执行(正是"防伪造"那道闸要拦的事)。
//
// 故在**唯一入口**剔除:客户端输入与代理内部状态不共用命名空间
const INTERNAL_PREFIX = '__';

// JSON 解析与形态校验:非 JSON / 非对象(null/数组/标量)按 400 挡在业务之前。
// 错误带 code(INVALID_JSON / INVALID_PAYLOAD)与面向用户的消息。
// 同时剔除 `__` 前缀的内部保留键(见 INTERNAL_PREFIX 说明)
function parseJsonBody(rawBody) {
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch (e) {
    const err = new Error(`请求体不是合法 JSON: ${e.message}`);
    err.code = 'INVALID_JSON';
    throw err;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const err = new Error('请求体必须是 JSON 对象(chat completion 格式)');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  // 剔除内部保留键。静默剔除而非 400:客户端并不需要这些键,报错只会让
  // 用户看到一个看不懂的失败;剔除后行为与"没发这个键"完全一致
  for (const k of Object.keys(payload)) {
    if (k.startsWith(INTERNAL_PREFIX)) delete payload[k];
  }
  return payload;
}

// model 由调用方**决定并注入**(即"这次请求要发往哪个模型",取自客户端请求
// 里的名字;缺省时由调用方填默认)。本模块保持纯函数:不查表、不判断该名字
// 是否合法、也不做任何"换成另一个模型"的决策——那是调用方的事。
//
// 历史说明:1.10.1 及以前这里会**无条件改写**成 config.model(单一目标)。
// 1.10.1 起去掉。上游已对三个模型都做了工具调用与视觉支持,当年"按客户端
// 选择路由会坏"的前提(FIXME: qwen 带图超时/R1 无视觉)已由用户实测推翻;
// 继续改写会让"选 V4.1、实际调 Vision-Exp"变成谎报。
//
// 缺省处理:调用方传空串(客户端没写 model)时**原样保留**空值,由上游拒绝
// ——代理不替用户挑模型,见 core/proxy-service.js 的 requestedModel 说明
//
// meta 为该模型的能力标注({thinkingParam, effortOptions, ...},来自启动探测的
// model-registry);拿不到时传 null,applyThinking 走保守路径
function normalizePayload(payload, model, meta, maxOutputTokens) {
  const applied = [];
  // 把调用方解析出的模型名落到 payload 上(调用方读的是客户端的原始选择)。
  // 空串表示"客户端没写":不动它,让上游如实回"模型不存在"
  if (typeof model === 'string' && model && payload.model !== model) {
    if (payload.model !== undefined) applied.push('model=' + String(payload.model).slice(0, 40));
    payload.model = model;
  }
  for (const key of UPSTREAM_REJECTED) {
    if (payload[key] !== undefined) {
      delete payload[key];
      applied.push(`-${key}`);
    }
  }
  if (payload.n !== undefined && payload.n !== 1) {
    delete payload.n;
    applied.push('-n');
  }
  // 关闭思考的意图先判定(方言字段随后由 applyThinking 摘除并翻译)。
  // 判定集中在 core/thinking.js:那里认三方言 + 原生的全部开/关形态。
  // 1.10.1 前这里是只认 'none' 的内联判断,漏掉了 `enable_thinking:false`
  // 等形态,导致原生方言客户端在预算收缩处被当成"思考开启"
  const wantsNoThinking = readThinkingIntent(payload) === false;
  // 新版 OpenAI 客户端(SDK v5+/部分智能体框架)用 max_completion_tokens
  // 替代 max_tokens——两者同义,统一收敛到 max_tokens 再做区间约束,否则
  // 384K 规格和 16 预算都能绕过下面的上下限。两个键并存时以新键为准
  if (typeof payload.max_completion_tokens === 'number') {
    payload.max_tokens = payload.max_completion_tokens;
    delete payload.max_completion_tokens;
    applied.push('max_completion_tokens→max_tokens');
  }
  // 推理模型在极小 max_tokens 下会把预算全部耗在思考上,content 恒为空——
  // 客户端的连通性探测常发 16/64 这类小预算(ZCode 实测 max_tokens:16),
  // 会被误判为"模型空响应"。仅在思考开启时抬到下限;思考关闭的请求维持
  // 客户端原值(显式要短回答的请求不被放宽)
  if (!wantsNoThinking && typeof payload.max_tokens === 'number' && payload.max_tokens < 512) {
    payload.max_tokens = 512;
    applied.push(`max_tokens→512`);
  }
  // 上游按 `prompt + max_tokens ≤ 窗口` 联合校验,超界以"服务器繁忙"错误帧
  // 秒拒(流式形态即空流)。按官方目录自动配置的客户端(如 ZCode 匹配
  // deepseek-v4-flash 的 384K 规格)会发超大 max_tokens,故这里压到**该模型的
  // 输出预算上限**。
  //
  // 1.10.1:上限改为逐模型(见 config.limitsFor)。三个模型窗口差 4 倍
  // (1M/1M/256K),旧的固定 65536 会把 1M 模型白砍到 1/16。上界之外还要受
  // prompt 侧约束,由 proxy-service 的预检门(fitTokenBudget)按剩余空间收缩
  // 上界:不传 maxOutputTokens 时**不设上限**(交上游按联合校验仲裁)。
  // 刻意不填一个"兜底数字":任何硬编码值都会对 1M 窗口的模型偏小、
  // 对 256K 的偏大,而这正是 1.10.1 要修的 bug(旧代码固定 65536,
  // 把 1M 模型白砍到 1/16)。生产路径恒传该模型的预算(见 proxy-service
  // 的 config.limitsFor),不传只出现在单测里
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 &&
      typeof payload.max_tokens === 'number' && payload.max_tokens > maxOutputTokens) {
    payload.max_tokens = maxOutputTokens;
    applied.push(`max_tokens→${maxOutputTokens}`);
  }
  // 思考参数翻译:开关按该模型的 thinkingParam 落到 chat_template_kwargs、
  // 档位按 effortOptions 就近落档(见 core/thinking.js 的详解)。必须在
  // max_tokens 下限判定之后 —— 那里依赖"客户端是否要思考"的判定结果。
  // meta 由调用方从 model-registry 取(探测未完成时为 null → 保守路径)
  for (const n of applyThinking(payload, meta)) applied.push(n);
  return applied;
}

// 上游按 prompt_tokens+max_tokens ≤ 262,144 逐 token 校验(2026-09-10 实测,
// 边界随 prompt 精确平移)。预检超限时不拒绝:把 max_tokens 收到剩余空间
// 再发——max_tokens 是输出上限而非目标,收缩对绝大多数请求无感,代价仅
// 高位长输出需续写(finish_reason:length)。剩余空间放不下最低输出预算才
// 判 413:prompt 本身超限。预算下限思考感知(1.8.1):思考开启/缺省时 512
// (思考会消耗输出预算,极小预算让 content 恒空——ZCode 探测请求实测);
// 关闭思考后预算全给内容,1 即有效,0 意味着一个输出 token 都放不下,拒绝。
// max_tokens 缺省时仅在 prompt 本身超限才拒绝(上游缺省输出预算未知,
// 不注入不收缩,交上游仲裁)。归一化先于本函数执行,思考关闭此时恒表达为
// chat_template_kwargs.thinking === false
//
// ⚠️ tools 的模板开销(2026-09-29 实测补充):上面那个"本地分词器与上游逐
// token 一致"的前提**对 tools 部分不成立**——上游把工具定义按自己的 chat
// 模板序列化,比本地按纯文本计的多算约 16~18 token/个。实测反推(二分法找
// 各档"仍被接受的最大 max_tokens",再用窗口减去本地 prompt):
//     tools= 3 → 多算  48 token(16.0/个)
//     tools=10 → 多算 167 token(16.7/个)
//     tools=33 → 多算 604 token(18.3/个)
// 不补这笔账的后果:带工具的长会话(agent 客户端恒带几十个工具)本地算出
// "还剩得下"、上游却判超限 ⇒ **请求被上游以 `{"errorMessage":"服务器繁忙"}`
// 秒拒**,而用户看到的是"上游忙"。这正是 Windows 下 ZCode 带 33 个工具时
// qwen 反复 429 的机制。留 20/个(>实测斜率上界 18.3)作为余量
const TOOL_DEF_TOKENS = 20;

function fitTokenBudget(promptTokens, payload, contextWindow) {
  // 工具定义的上游模板开销(见上方 TOOL_DEF_TOKENS 说明)。只加不减:
  // 多算只是让 max_tokens 少给一点(安全侧),少算会让请求被整个拒掉
  const toolCount = Array.isArray(payload && payload.tools) ? payload.tools.length : 0;
  const effectivePrompt = promptTokens + toolCount * TOOL_DEF_TOKENS;

  const budget = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0;
  if (effectivePrompt + budget <= contextWindow) return { ok: true, note: '' };
  const room = contextWindow - effectivePrompt;
  // 思考关闭的判定与归一化同源(core/thinking.js 认三方言+原生)。生产路径
  // 恒先归一化(届时思考意图已被翻译掉),但本函数不静默依赖该前置——
  // 直接调用的原始形态方言同样得到正确下限
  const noThinking = readThinkingIntent(payload) === false;
  const floor = noThinking ? 1 : 512;
  if (room < floor) {
    return {
      ok: false,
      message: `上下文空间不足，本地估算输入 ${effectivePrompt}、最低输出 ${floor}，上下文上限 ${contextWindow} tokens。请缩短对话。`,
    };
  }
  payload.max_tokens = room;
  return { ok: true, note: ` norm[max_tokens→${room} 预检收缩]` };
}

module.exports = { parseJsonBody, normalizePayload, fitTokenBudget, TOOL_DEF_TOKENS };
