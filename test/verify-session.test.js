// test/verify-session.test.js — verifyWebVpnSession 会话判定:探测隧道地址而非
// 登录页表单。2026-09-16 学校 WebVPN 改版,/login?oauth_login=true 对已登录
// 会话也 302 到 id 表单,旧判据(看 sm2publicKey)恒 false,watch 续期卡死
// (登录实际成功、票实际有效,被误报"登录后未见会话")。新判据与保活探活
// (probeWebvpnSession)同源:带会话 cookie 打隧道内地址,3xx=无效,其余=有效。
// 无法离线起真实学校端点:本测试注入全局 fetch mock,钉住判据调用的
// URL 形态、Cookie 携带与状态码映射,防止将来退化回"看表单"。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MadmodelAuthClient, CookieJar, MADMODEL_TUNNEL_MODELS_URL } = require('../madmodel-auth');

// mock fetch:记录请求,按脚本回状态码。redirect: 'manual' 时 fetch 返回
// 手工构造的 Response(不发真网络)
function withFetchMock(script, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), cookie: (opts.headers || {}).Cookie || '' });
    const status = script(String(url)) || 200;
    return new Response(null, { status, headers: { location: status >= 300 && status < 400 ? 'https://webvpn.tsinghua.edu.cn/login' : '' } });
  };
  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = original; });
}

test('verify:探测 madmodel 隧道地址(非登录页),携带 webvpn 会话 cookie', async () => {
  const client = new MadmodelAuthClient(new CookieJar());
  client.jar.absorb('https://webvpn.tsinghua.edu.cn/', 'wengine_vpn_ticket=VALIDTICKET; Path=/');
  await withFetchMock(() => 200, async seen => {
    const ok = await client.verifyWebVpnSession();
    assert.strictEqual(ok, true, '2xx 探测应判会话有效');
    assert.strictEqual(seen.length, 1, 'verify 只发一个探测请求');
    assert.strictEqual(seen[0].url, MADMODEL_TUNNEL_MODELS_URL, '探测地址须与保活共用同一常量(防两处漂移)');
    assert.ok(!seen[0].url.includes('/login'), '不得再探测登录页(旧判据,改版后恒 false)');
    assert.ok(seen[0].cookie.includes('wengine_vpn_ticket=VALIDTICKET'), '必须携带会话票');
  });
});

test('verify:3xx(隧道踢回登录页)判会话无效', async () => {
  const client = new MadmodelAuthClient(new CookieJar());
  client.jar.absorb('https://webvpn.tsinghua.edu.cn/', 'wengine_vpn_ticket=STALE; Path=/');
  await withFetchMock(() => 302, async () => {
    assert.strictEqual(await client.verifyWebVpnSession(), false, '302 应判无效');
  });
});

test('verify:4xx(穿过隧道,应用层拒绝)仍判有效', async () => {
  const client = new MadmodelAuthClient(new CookieJar());
  client.jar.absorb('https://webvpn.tsinghua.edu.cn/', 'wengine_vpn_ticket=OK; Path=/');
  await withFetchMock(() => 401, async () => {
    assert.strictEqual(await client.verifyWebVpnSession(), true, '4xx 已穿过隧道,会话本身有效');
  });
});

test('verify:网络错误保守判无效', async () => {
  const client = new MadmodelAuthClient(new CookieJar());
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.strictEqual(await client.verifyWebVpnSession(), false, '网络错误应判无效(与旧版 catch 行为一致)');
  } finally { globalThis.fetch = original; }
});
