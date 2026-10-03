// 从已知的 DSML / Hermes 文本格式恢复工具调用。标签不完整或有歧义时返回 null。
'use strict';

const { randomUUID } = require('crypto');
const DSML = String.raw`[｜|]DSML[｜|]`;
const MARKUP = /<\/?(?:[｜|]DSML[｜|]|tool_call\b|function=|parameter=)/;

// 文档示例不作为调用。检查整个回复，避免部分执行示例旁边的其它标签。
function hasQuotedMarkup(text) {
  return (text.match(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g) || [])
    .some(block => MARKUP.test(block));
}

function attr(text, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(text);
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

function toolFor(tools, name) {
  return tools?.find(t => t?.type === 'function' && t.function?.name === name)?.function;
}

function makeCall(name, args) {
  return { id: `call_${randomUUID()}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } };
}

function parseDsmlToolCalls(text, tools) {
  if (typeof text !== 'string' || !text || hasQuotedMarkup(text)) return null;
  const invokes = new RegExp(`<${DSML}\\s*(invoke\\b[^<>]*|tool\\s+call\\s*=[^<>]*)>([\\s\\S]*?)<\\/${DSML}\\s*invoke\\s*>`, 'g');
  const calls = [];
  const leftover = text.replace(invokes, (_, head, body) => {
    const name = attr(head, 'name') || attr(head, 'call');
    if (!name || (tools && !toolFor(tools, name))) { calls.push(null); return ''; }
    const args = Object.create(null);
    let valid = true;
    const params = new RegExp(`<${DSML}\\s*parameter\\b([^<>]*)>([\\s\\S]*?)<\\/${DSML}\\s*parameter\\s*>`, 'g');
    const rest = body.replace(params, (match, attrs, value) => {
      const key = attr(attrs, 'name');
      if (!key || Object.hasOwn(args, key) || MARKUP.test(value)) { valid = false; return ''; }
      if (attr(attrs, 'string') === 'false') {
        try { args[key] = JSON.parse(value); } catch { valid = false; }
      } else { args[key] = value; }
      return '';
    });
    calls.push(valid && !rest.trim() ? makeCall(name, args) : null);
    return '';
  });
  // 接受已知外层包装，但不接受残留的未闭合 invoke/parameter。
  const outer = new RegExp(`<\\/?${DSML}\\s*(?:tool_calls|tool_use|tool(?:\\s+call)?)\\s*>`, 'g');
  if (MARKUP.test(leftover.replace(outer, ''))) return null;
  return calls.length && calls.every(Boolean) ? calls : null;
}

function hermesValue(raw, schema, hasTools) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  // 有定义时，字符串及未知类型保持原文；不猜测 "123" / "true" 的意图。
  if (hasTools && (types.includes('string') || !types.some(t =>
    ['number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t)))) return raw;
  try { return JSON.parse(raw.trim()); } catch { return raw; }
}

function parseHermesToolCalls(text, tools) {
  if (typeof text !== 'string' || !text || hasQuotedMarkup(text)) return null;
  const calls = [];
  const leftover = text.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_, body) => {
    const fn = /^\s*<function=([^>\s]+)\s*>([\s\S]*?)<\/function\s*>\s*$/.exec(body);
    if (!fn || (tools && !toolFor(tools, fn[1]))) { calls.push(null); return ''; }
    const definition = toolFor(tools, fn[1]);
    const args = Object.create(null);
    let valid = true;
    const rest = fn[2].replace(/<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g,
      (match, key, value) => {
        // Hermes 参数以换行分隔；缺少边界时可能是代码里的标签字面量。
        if (Object.hasOwn(args, key) || MARKUP.test(value) || (value && !/\n$/.test(value))) {
          valid = false; return '';
        }
        const raw = value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        args[key] = hermesValue(raw, definition?.parameters?.properties?.[key], !!tools);
        return '';
      });
    calls.push(valid && !rest.trim() ? makeCall(fn[1], args) : null);
    return '';
  });
  if (MARKUP.test(leftover)) return null;
  return calls.length && calls.every(Boolean) ? calls : null;
}

function parseToolCalls(text, tools) {
  return parseDsmlToolCalls(text, tools) || parseHermesToolCalls(text, tools);
}

// 仅在解析成功后调用。按完整调用块剥离，参数中的普通 < 字符不会留下残片。
function stripToolMarkup(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(new RegExp(`<${DSML}\\s*(?:invoke\\b[^<>]*|tool\\s+call\\s*=[^<>]*)>[\\s\\S]*?<\\/${DSML}\\s*invoke\\s*>`, 'g'), '')
    .replace(new RegExp(`<\\/?${DSML}\\s*(?:tool_calls|tool_use|tool(?:\\s+call)?)\\s*>`, 'g'), '').trim();
}

function looksLikeToolMarkupStart(text) {
  if (typeof text !== 'string' || hasQuotedMarkup(text)) return false;
  return /<[｜|]DSML[｜|]\s*(tool_calls|invoke)/i.test(text) ||
    /<tool_call>[\s\S]{0,80}?<function=/i.test(text);
}

function shouldProbeSwallowedCall(text) {
  return typeof text === 'string' && (text.trim() === '' || looksLikeToolMarkupStart(text));
}

module.exports = { parseDsmlToolCalls, parseHermesToolCalls, parseToolCalls,
  stripToolMarkup, looksLikeToolMarkupStart, shouldProbeSwallowedCall };
