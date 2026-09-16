// core/errors.js
// 错误分类与映射(纯逻辑):上游错误体 → OpenAI 错误响应;上游客户端结果 →
// HTTP 状态码与日志 note。业务错误匹配优先级:结构化状态码 > 结构化错误
// 字段 > HTML 错误页 > 最后有限的文本匹配(不新增无证据的中文文案匹配)。

'use strict';

function translateUpstreamError(bodyObj, raw, status, busyHint) {
  if (status === 404) {
    return { http: 502, message: '上游返回 404:端点可能已变更' };
  }
  // HTTP 层 401/403(token 有效期内被吊销等形态)与结构化 status 10003
  // 同等映射:落在最底部会变成语义错误的 502"无法识别的响应"
  if (status === 401 || status === 403) {
    return { http: 401, message: '认证失败(token 无效或被拒绝)。请确认 watch 守护进程在运行: node refresh-token.js watch' };
  }
  // 隧道会话失效的实测形态:302 → /login,响应体为空。1.8.1 前落到兜底的
  // "无法识别的响应(空)"(2026-09-12 事故),用户无从知道该重试。会话由
  // watch 自动重签(1.7.2 起秒级自愈),稍后重试即恢复
  if (status === 301 || status === 302) {
    return { http: 502, message: 'WebVPN 会话已失效(上游 302 跳转登录页)。watch 会自动重签,稍后重试即可' };
  }
  const detail = bodyObj && (bodyObj.errorMessage || bodyObj.message || bodyObj.error?.message ||
    bodyObj.detail || (typeof bodyObj.error === 'string' ? bodyObj.error : ''));
  if (bodyObj?.status === 10003) {
    return { http: 401, message: '认证失败(token 无效或已过期)。请确认 watch 守护进程在运行: node refresh-token.js watch' };
  }
  // "疑似上下文超限"复判:上游拒绝与本地计量的组合判定,10001 与"繁忙"
  // 文案两分支共用(判定与措辞不各写一份)。upstreamShape 描述上游侧的
  // 拒绝形态,由各分支提供
  const likelyOverflow = hint => hint &&
    (hint.promptTokens + hint.tokenBudget > hint.contextWindow ||
      hint.promptTokens >= hint.contextWindow);
  const overflowMessage = (hint, upstreamShape) =>
    `疑似上下文超限:${upstreamShape},本地精确计量 prompt ${hint.promptTokens} + max_tokens ${hint.tokenBudget} 已达上限 ${hint.contextWindow}。请新开会话或压缩 history 后重试;若小请求也报此错,才是上游真的繁忙`;

  if (bodyObj?.status === 10001) {
    // 结构化 10001 与"繁忙"文案是同族拒绝(消息文案自己就写着"可能是上下文
    // 超限"),但此前不查 busyHint,超限被报 429——客户端带退避无限重试一个
    // 永远不会成功的请求。与文案分支同判(2026-09-16 补齐)。注意:10001+
    // 超限这一组合未经实测,是按同族语义的推断
    if (likelyOverflow(busyHint)) {
      return { http: 413, message: overflowMessage(busyHint, '上游以状态码 10001 拒绝(推断:与"繁忙"文案为同族拒绝,组合未经实测)') };
    }
    return { http: 429, message: `上游拒绝:${detail || '(上游未提供详情)'}(可能是上下文超限≈256K、请求体超限 1MB 或服务繁忙)` };
  }
  if (typeof bodyObj?.errorMessage === 'string' && /繁忙/.test(bodyObj.errorMessage)) {
    // 上游对上下文超限的请求也返回同一句"服务器繁忙"(2026-09-10 实测复现,
    // 当时代码密集长会话被估算口径漏放,上游秒拒,429+"稍后再试"诱导客户端
    // 无退路地循环重试;1.6.0 起预检门已精确收缩,超限请求在本地就被改写)。
    // busyHint 由调用方按本地精确分词(core/tokenizer.js)提供。覆盖面很窄的
    // 防御性保留:prompt+实际发出的 max_tokens 达上限才改判 413,给客户端
    // "新开会话/压缩 history"的处置;其余(含上游漂移——本地计数同样低估,
    // 此处无法判别)保持 429 等待语义
    if (likelyOverflow(busyHint)) {
      return { http: 413, message: overflowMessage(busyHint, '上游对超限请求也返回"服务器繁忙"(2026-09-10 实测复现)') };
    }
    return { http: 429, message: `上游繁忙(SSE 内嵌错误): ${bodyObj.errorMessage}` };
  }
  if (detail) return { http: 502, message: `上游拒绝请求: ${String(detail).slice(0, 300)}` };
  if (raw && /<html/i.test(String(raw))) {
    return { http: status >= 500 ? status : 502,
      message: `上游网关/负载均衡返回 HTML ${status} 错误页(实测形态:TsinghuaLB 502,后端瞬时不可达)。稍后重试通常自愈` };
  }
  return { http: 502, message: `上游返回无法识别的响应(前 200 字符): ${String(raw || '').slice(0, 200)}` };
}

// "流未以合法 [DONE] 结束"的形态(截断 / 坏帧 / 总时限):流式与非流式只在
// note 前缀上不同,判定与措辞不各写一份
function describeFailedStream(result, notePrefix, config) {
  if (result.type === 'protocol-error' && result.reason === 'truncated') {
    return { note: `${notePrefix}-truncated`, message: '上游流被截断(未见终止标记 [DONE])' };
  }
  if (result.type === 'protocol-error') {
    return { note: `${notePrefix}-invalid`, message: result.message || '上游 SSE 协议错误' };
  }
  return {
    note: `${notePrefix}-total-timeout`,
    message: `上游流式总超时(${Math.round(config.streamTotalTimeout / 1000)}s)`,
  };
}

module.exports = { translateUpstreamError, describeFailedStream };
