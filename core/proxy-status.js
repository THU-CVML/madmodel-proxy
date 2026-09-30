'use strict';

async function isProxyRunning(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return response.status === 200 && body?.proxy === 'madmodel';
  } catch { return false; }
}

module.exports = { isProxyRunning };
