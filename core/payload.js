// core/payload.js
// 请求参数归一化(纯函数,只修改传入 payload,不读环境变量、不做 I/O)。
// 行为契约见 README"边界"与 CHANGELOG 1.1.0"参数归一化"。

'use strict';

const UPSTREAM_REJECTED = ['logprobs', 'top_logprobs'];

// JSON 解析与形态校验:非 JSON / 非对象(null/数组/标量)按 400 挡在业务之前。
// 错误带 code(INVALID_JSON / INVALID_PAYLOAD)与面向用户的消息
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
  return payload;
}

// model 由调用方注入(config.model,本模块保持纯函数);上游模型名带部署日期
// 后缀会轮换,改 config.js 一处即全项目生效
function normalizePayload(payload, model) {
  const applied = [];
  if (payload.model !== model) {
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
  // 关闭思考的方言先判定(判定字段随后会被剥离)。任一关闭信号即关闭
  // (含原生 chat_template_kwargs.thinking:false——1.8.1 前漏识别,导致原生
  // 方言的客户端在归一化与预算收缩两处都被当成"思考开启"处理)
  const wantsNoThinking = payload.reasoning_effort === 'none' ||
    payload.thinking === false || payload.thinking?.type === 'disabled' ||
    payload.chat_template_kwargs?.thinking === false;
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
  // 上游校验 prompt+max_tokens ≤ 262,144:按官方目录自动配置的客户端(如
  // ZCode 匹配 deepseek-v4-flash 的 384K 输出规格)会发超大 max_tokens,被
  // 上游以"服务器繁忙"错误帧秒拒,流式形态即空流。压到 65536(参数实测
  // 接受,模型自然停止远早于此);prompt 侧的联合校验与收缩在 proxy-service
  // 预检门(fitTokenBudget)
  if (typeof payload.max_tokens === 'number' && payload.max_tokens > 65536) {
    payload.max_tokens = 65536;
    applied.push(`max_tokens→65536`);
  }
  for (const key of ['thinking', 'reasoning_effort']) {
    if (payload[key] !== undefined) {
      delete payload[key];
      applied.push(`-${key}`);
    }
  }
  if (wantsNoThinking) {
    const kwargs = payload.chat_template_kwargs;
    payload.chat_template_kwargs = kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs)
      ? { ...kwargs, thinking: false }
      : { thinking: false };
    applied.push('thinking=false');
  }
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
function fitTokenBudget(promptTokens, payload, contextWindow) {
  const budget = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0;
  if (promptTokens + budget <= contextWindow) return { ok: true, note: '' };
  const room = contextWindow - promptTokens;
  // 思考关闭的判定与归一化的 wantsNoThinking 同源(三方言+原生)。生产路径
  // 恒先归一化(届时已统一为 kwargs 形态),但本函数不静默依赖该前置——
  // 直接调用的原始形态方言同样得到正确下限
  const noThinking = payload.chat_template_kwargs?.thinking === false ||
    payload.reasoning_effort === 'none' ||
    payload.thinking === false || payload.thinking?.type === 'disabled';
  const floor = noThinking ? 1 : 512;
  if (room < floor) {
    return {
      ok: false,
      message: `prompt ${promptTokens} tokens 已达上游 ${contextWindow} tokens 上下文上限,剩余空间放不下最低输出预算 ${floor}。请新开会话或在客户端压缩 history 后重试。`,
    };
  }
  payload.max_tokens = room;
  return { ok: true, note: ` norm[max_tokens→${room} 预检收缩]` };
}

// 图片/多模态输入预检(1.9.2)。背景(2026-09-16 四组对照实测):上游对含
// image_url 内容段的请求 0.1~0.2 秒即时拒绝——与请求体积、base64 是否合法
// 无关(纯文本 200 / 合法 8×8 PNG 429 / 伪 base64 429 / 用户原图 429),
// 响应文案是上游掩饰用的"服务器繁忙"。客户端据此带退避无限重试,而含图的
// 历史消息每轮都会重发,该会话从此永久 429。本地预检把这条"永远失败且原因
// 不可见"的路径变成说清原因与处置的 400。
//
// 判定边界(刻意收窄,只碰 messages[*].content 数组里的段类型):
//   - messages 非数组、content 为字符串(常规文本)一律放行
//   - 文本语义的段放行:type === 'text'(chat 格式)、type === 'input_text'
//     (部分客户端混用 Responses 风格的类型名,内容仍是纯文本);段没有 type
//     字段也放行(不是带类型标注的多模态段,无实测证据前不误伤,交上游仲裁)
//   - 其余任何带 type 的段(image_url / input_image / input_audio / file 等)
//     一律拒绝
//   - messages 以外的字段(tools / tool_calls 定义等)一概不看:工具定义
//     本身上游接受(实测透传 200),判定它们会误伤
// 明确不做静默剥离:剥掉图片后放行会让模型基于残缺上下文作答而用户不知情,
// 违反本项目"不伪造"纪律(同类取舍见 CHANGELOG 1.8.1 的运行期错误语义)。
// model 由调用方注入(同 normalizePayload),本模块保持纯函数
function checkContentSupport(payload, model) {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return { ok: true };
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = part.type;
      // type 缺省或空串 = 无类型标注(非多模态段),交上游仲裁不误伤;
      // 其余任何带 type 的段(含 base64 编码的 image_url 等)一律拒绝
      if (!type || type === 'text' || type === 'input_text') continue;
      return {
        ok: false,
        index: i,
        type,
        // 文案为维护者定稿(2026-09-18):只说事实与处置,不做论证
        message: `会话历史含不受支持的图片/多模态输入(第 ${i + 1} 条消息有 type:"${type}" 段),` +
          `上游 ${model} 不支持视觉输入,重试无效。请新开一个会话,或移除该消息中的图片后重试`,
      };
    }
  }
  return { ok: true };
}

module.exports = { parseJsonBody, normalizePayload, fitTokenBudget, checkContentSupport };
