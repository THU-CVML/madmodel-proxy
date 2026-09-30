// 模型列表和能力快照；请求始终使用客户端指定的模型名。
'use strict';

function createModelRegistry(config) {
  let current = Object.freeze([Object.freeze({
    id: config.model, ok: null, reason: null, ms: null, meta: null,
  })]);
  return {
    publish(results) {
      if (!Array.isArray(results) || !results.length) return;
      current = Object.freeze(results.map(r => Object.freeze({
        ...r,
        meta: r.meta ? Object.freeze({
          ...r.meta,
          ...(Array.isArray(r.meta.effortOptions)
            ? { effortOptions: Object.freeze([...r.meta.effortOptions]) } : {}),
        }) : null,
      })));
    },
    snapshot() { return current; },
    available() {
      const confirmed = current.filter(m => m.ok === true);
      if (confirmed.length) return confirmed;
      // 暂时无法探测时保留可手动尝试的条目；已确认不存在的模型不再推荐。
      return current.filter(m => m.reason !== 'not-found');
    },
  };
}
module.exports = { createModelRegistry };
