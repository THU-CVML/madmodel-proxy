// 按模型能力映射思考开关、档位与响应字段；不把正文 content 当作思考字段。

'use strict';

const EFFORT_ALIASES = {
  minimal: 'low', min: 'low', low: 'low', light: 'low',
  medium: 'medium', mid: 'medium', moderate: 'medium', default: 'medium', balanced: 'medium',
  high: 'high',
  xhigh: 'xhigh', 'extra-high': 'xhigh', veryhigh: 'xhigh', 'very-high': 'xhigh',
  max: 'max', maximum: 'max', highest: 'max', ultra: 'max',
};

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

const INTENT_KEYS = ['reasoning_effort', 'thinking', 'enable_thinking', 'reasoning'];

// 原生 kwargs 优先；其余信号中显式关闭优先于开启。
function readThinkingIntent(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const kwargs = payload.chat_template_kwargs;
  if (kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs)) {
    for (const k of ['thinking', 'enable_thinking']) {
      if (typeof kwargs[k] === 'boolean') return kwargs[k];
    }
  }

  if (payload.reasoning_effort === 'none') return false;
  if (payload.thinking === false || payload.thinking?.type === 'disabled') return false;
  if (payload.enable_thinking === false) return false;
  if (payload.reasoning === false) return false;

  if (payload.thinking === true || payload.thinking?.type === 'enabled') return true;
  if (payload.enable_thinking === true) return true;
  if (payload.reasoning === true) return true;
  if (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort.trim() !== '') return true;

  return null;
}

function readRawEffort(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const v = payload.reasoning_effort;
  return typeof v === 'string' && v.trim() ? v : null;
}

// 缺少同名档位时取不低于目标的最近档；未知值不发送。
function nearestEffort(value, effortOptions) {
  if (!Array.isArray(effortOptions) || !effortOptions.length) return null;
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (effortOptions.includes(raw)) return raw;
  const normalized = EFFORT_ALIASES[raw] || raw;
  if (effortOptions.includes(normalized)) return normalized;
  const target = EFFORT_ORDER.indexOf(normalized);
  if (target < 0) return null;
  const usable = effortOptions
    .map(opt => ({ opt, i: EFFORT_ORDER.indexOf(opt) }))
    .filter(x => x.i >= 0);
  if (!usable.length) return null;
  const atOrAbove = usable.filter(x => x.i >= target).sort((a, b) => a.i - b.i);
  if (atOrAbove.length) return atOrAbove[0].opt;
  return usable.sort((a, b) => b.i - a.i)[0].opt;
}

function mergeKwargs(existing, patch) {
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return { ...existing, ...patch };
  }
  return { ...patch };
}

function stripForeignThinkingKeys(kwargs, keepParam) {
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return kwargs;
  for (const k of ['thinking', 'enable_thinking']) {
    if (k !== keepParam && k in kwargs) delete kwargs[k];
  }
  return kwargs;
}

function pruneThinkingKeys(payload, keepParam) {
  const kwargs = payload.chat_template_kwargs;
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) {
    if ('chat_template_kwargs' in payload && payload.chat_template_kwargs == null) {
      delete payload.chat_template_kwargs;
    }
    return;
  }
  stripForeignThinkingKeys(kwargs, keepParam);
  if (!Object.keys(kwargs).length) delete payload.chat_template_kwargs;
}

// 就地修改 payload；null 开关表示已知不可开关，缺失元数据则走保守回退。
function applyThinking(payload, meta) {
  const applied = [];
  if (!payload || typeof payload !== 'object') return applied;

  const intent = readThinkingIntent(payload);
  const rawEffort = readRawEffort(payload);

  for (const k of INTENT_KEYS) {
    if (payload[k] !== undefined) {
      delete payload[k];
      applied.push(`-${k}`);
    }
  }

  const hasMeta = !!(meta && typeof meta === 'object');
  const param = hasMeta && typeof meta.thinkingParam === 'string' ? meta.thinkingParam : null;
  const opts = hasMeta && Array.isArray(meta.effortOptions) ? meta.effortOptions : [];

  if (hasMeta && meta.thinkingParam === null) {
    pruneThinkingKeys(payload, null);
    const wanted = rawEffort == null ? opts[0] : nearestEffort(rawEffort, opts);
    if (wanted) {
      payload.reasoning_effort = wanted;
      applied.push(`reasoning_effort=${wanted}`);
    }
    return applied;
  }

  if (!param) {
    pruneThinkingKeys(payload, null);
    if (intent === false) {
      payload.chat_template_kwargs = mergeKwargs(payload.chat_template_kwargs, { thinking: false });
      applied.push('thinking=false');
    }
    return applied;
  }

  const on = intent !== false;

  payload.chat_template_kwargs = mergeKwargs(payload.chat_template_kwargs, { [param]: on });
  pruneThinkingKeys(payload, param);
  applied.push(`${param}=${on}`);

  if (on && opts.length) {
    const wanted = rawEffort == null ? opts[0] : nearestEffort(rawEffort, opts);
    if (wanted) {
      payload.reasoning_effort = wanted;
      applied.push(`reasoning_effort=${wanted}`);
    }
  }
  return applied;
}

// content 始终保留为正文，即便某模型将思考包含在正文中。
const REASONING_FIELDS = ['reasoning_content', 'reasoning'];

function reasoningFieldsFor(fields) {
  const list = typeof fields === 'string' ? [fields] : (Array.isArray(fields) ? fields : []);
  if (!list.length) return REASONING_FIELDS;
  const seen = new Set();
  const merged = [];
  for (const f of ['reasoning_content', ...list, ...REASONING_FIELDS]) {
    if (typeof f !== 'string' || !f || f === 'content' || seen.has(f)) continue;
    seen.add(f);
    merged.push(f);
  }
  return merged.length ? merged : REASONING_FIELDS;
}

function normalizeReasoningDelta(obj, fields) {
  const ch = obj && obj.choices && obj.choices[0];
  return normalizeReasoning(ch?.delta, fields);
}

// 多个思考方言同时出现时取首个非空值，避免重复累加。
function readReasoningDelta(delta, fields) {
  if (!delta || typeof delta !== 'object') return null;
  for (const f of reasoningFieldsFor(fields)) {
    const v = delta[f];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function normalizeCompletionReasoning(body, fields) {
  const msg = body && body.choices && body.choices[0] && body.choices[0].message;
  return normalizeReasoning(msg, fields);
}

// 上游可能同时返回两个内容相同的别名字段。与读取、聚合路径一致，
// 只取首个非空值；不要对文本本身去重，连续帧中的重复字词可能是正常内容。
function normalizeReasoning(msg, fields) {
  if (!msg || typeof msg !== 'object') return false;
  const list = reasoningFieldsFor(fields);
  if (!list.some(f => f !== 'reasoning_content' && f in msg)) return false;
  const value = readReasoningDelta(msg, fields);

  for (const f of list) {
    if (f !== 'reasoning_content') delete msg[f];
  }
  if (value !== null) msg.reasoning_content = value;
  else delete msg.reasoning_content;
  return true;
}

module.exports = {
  applyThinking, readThinkingIntent, readRawEffort, nearestEffort, stripForeignThinkingKeys,
  normalizeReasoningDelta, normalizeCompletionReasoning, readReasoningDelta,
  reasoningFieldsFor, REASONING_FIELDS,
  EFFORT_ALIASES, EFFORT_ORDER, INTENT_KEYS,
};
