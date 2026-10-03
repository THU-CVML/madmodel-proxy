// test/cookie-jar.test.js — CookieJar 的删除语义与导出范围。
//
// 为什么需要:这两处都在 2026-09-22 的审阅里暴露出真实缺陷,且都影响会话本身——
//   1. 删除只认"值为空",漏掉 Max-Age=0 / Expires 已过期两种标准写法,
//      服务端作废的会话 cookie 会被继续发出去;
//   2. 导出给上游时按根路径匹配,漏掉设在隧道深路径上的会话 cookie。
// 纯类,离线可测,不需要 fetch。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');

const { CookieJar, MADMODEL_VPN_PREFIX, TUNNEL_COOKIE_SCOPE } = require('../madmodel-auth');

const HOST = 'https://webvpn.tsinghua.edu.cn';

test('删除 cookie:值为空是删除', () => {
  const jar = new CookieJar();
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
  assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), 'abc');
  jar.absorb(`${HOST}/x`, ['SID=; Path=/']);
  assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), '', '空值未删除');
});

test('删除 cookie:Max-Age=0 与负值都是删除', () => {
  for (const attr of ['Max-Age=0', 'Max-Age=-1']) {
    const jar = new CookieJar();
    jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
    jar.absorb(`${HOST}/x`, [`SID=abc; Path=/; ${attr}`]);
    assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), '',
      `${attr} 未删除(服务端用标准写法作废 cookie 时旧值会留下)`);
  }
});

test('删除 cookie:Expires 已过去是删除,未过去保留', () => {
  const jar = new CookieJar();
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), '', '过期 Expires 未删除');

  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT']);
  assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), 'abc', '未过期的 Expires 被误删');
});

test('未过期的 Max-Age 不误删', () => {
  const jar = new CookieJar();
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/; Max-Age=3600']);
  assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), 'abc', '正数 Max-Age 被误删');
});

test('headerFor 按路径匹配:根路径取不到深路径 cookie', () => {
  const jar = new CookieJar();
  jar.absorb(`${HOST}/https/app/v1/x`, ['DEEP=d; Path=/https/app/v1']);
  jar.absorb(`${HOST}/`, ['ROOT=r; Path=/']);
  assert.strictEqual(jar.headerFor(`${HOST}/`), 'ROOT=r');
  assert.strictEqual(jar.headerFor(`${HOST}/https/app/v1/y`), 'DEEP=d; ROOT=r');
});

test('按隧道前缀取 cookie:深路径的在、同域其他应用的排除在外', () => {
  // 导出隧道会话时若按根路径取,会漏掉设在深路径上的隧道 cookie;而按整域取
  // 又会把同域其他应用(如 info 门户)的 cookie 一起带出去——上游只该拿到隧道的
  const jar = new CookieJar();
  const MM = '/https/madmodel-hash';
  const INFO = '/https/info-hash';
  jar.absorb(`${HOST}${MM}/v1/x`, [`TUNNEL=t; Path=${MM}`]);
  jar.absorb(`${HOST}${INFO}/f/x`, [`PORTAL=p; Path=${INFO}`]);
  jar.absorb(`${HOST}/`, ['ROOT=r; Path=/']);
  const h = jar.headerFor(`${HOST}${MM}/`);
  assert.ok(h.includes('TUNNEL=t'), '漏了深路径的隧道 cookie: ' + h);
  assert.ok(h.includes('ROOT=r'), '漏了根路径的公共 cookie: ' + h);
  assert.ok(!h.includes('PORTAL=p'), '带上了同域其他应用的 cookie: ' + h);
});

test('按隧道前缀取:同名 cookie 取更深的路径(不重复)', () => {
  const jar = new CookieJar();
  const MM = '/https/madmodel-hash';
  jar.absorb(`${HOST}/`, ['SID=shallow; Path=/']);
  jar.absorb(`${HOST}${MM}/x`, [`SID=deep; Path=${MM}`]);
  assert.strictEqual(jar.headerFor(`${HOST}${MM}/`), 'SID=deep');
});

test('按隧道前缀取:不跨域', () => {
  const jar = new CookieJar();
  jar.absorb('https://id.tsinghua.edu.cn/', ['IDC=1; Path=/']);
  jar.absorb(`${HOST}/`, ['VPN=2; Path=/']);
  assert.strictEqual(jar.headerFor(`${HOST}/`), 'VPN=2');
});

test('Max-Age 优先于 Expires(RFC 6265 §5.3)', () => {
  // 两者并存时按 Max-Age 判定,Expires 被忽略。否则"过去的 Expires +
  // 正数 Max-Age"这种自相矛盾组合会被误删(2026-09-22 审阅指出)
  const mk = (attr) => {
    const jar = new CookieJar();
    jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
    jar.absorb(`${HOST}/x`, [`SID=abc; Path=/; ${attr}`]);
    return jar.valueFor(`${HOST}/y`, 'SID');
  };
  assert.strictEqual(mk('Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600'), 'abc',
    '过去 Expires 不该压过正数 Max-Age');
  assert.strictEqual(mk('Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=0'), '',
    'Max-Age=0 该压过未来的 Expires');
});

test('Max-Age 的宽容形态都能识别(空格/加号/引号)', () => {
  // 收紧到只认 "-?\d+" 会在这些形态上静默漏删,失效 cookie 继续被发出
  for (const attr of ['Max-Age = 0', 'Max-Age=+0', 'Max-Age="0"', 'max-age=0']) {
    const jar = new CookieJar();
    jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
    jar.absorb(`${HOST}/x`, [`SID=abc; Path=/; ${attr}`]);
    assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), '',
      `${attr} 未识别为删除`);
  }
});

test('Expires 的宽容形态:空格与属性名大小写', () => {
  const jar = new CookieJar();
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/']);
  jar.absorb(`${HOST}/x`, ['SID=abc; Path=/; expires = Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.strictEqual(jar.valueFor(`${HOST}/y`, 'SID'), '', '小写 expires 未生效');
});


test('TUNNEL_COOKIE_SCOPE 指向隧道前缀,不是 webvpn 域根', () => {
  // 导出给上游与会话探测共用这个常量。它必须落在隧道前缀上:
  //   用域根 → 漏掉 Path 更深的隧道会话 cookie
  //   用域根 → 还会把同域其他应用(如 info 门户)的 cookie 一起带出去
  // 钉住它,防有人"顺手"改回 WEBVPN 前缀
  assert.ok(TUNNEL_COOKIE_SCOPE.startsWith(MADMODEL_VPN_PREFIX),
    'TUNNEL_COOKIE_SCOPE 不在隧道前缀下: ' + TUNNEL_COOKIE_SCOPE);
  assert.notStrictEqual(TUNNEL_COOKIE_SCOPE, `${HOST}/`,
    'TUNNEL_COOKIE_SCOPE 被改成了 webvpn 域根');
  assert.ok(TUNNEL_COOKIE_SCOPE.includes('/https/'),
    'TUNNEL_COOKIE_SCOPE 里没有隧道路径段: ' + TUNNEL_COOKIE_SCOPE);
});

test('用 TUNNEL_COOKIE_SCOPE 取 cookie:隧道在、门户不在', () => {
  const jar = new CookieJar();
  const mm = '/https/' + 'a'.repeat(64);
  const info = '/https/' + 'b'.repeat(64);
  jar.absorb(`${HOST}${mm}/v1/x`, [`TUNNEL=t; Path=${mm}`]);
  jar.absorb(`${HOST}${info}/f/x`, [`PORTAL=p; Path=${info}`]);
  jar.absorb(`${HOST}/`, ['ROOT=r; Path=/']);
  const h = jar.headerFor(TUNNEL_COOKIE_SCOPE.replace(HOST, HOST));
  // 用常量本身作为作用域(把它的主机换成测试主机)
  const scope = TUNNEL_COOKIE_SCOPE.replace(/^https:\/\/[^/]+/, HOST);
  const out = jar.headerFor(scope);
  assert.ok(out.includes('ROOT=r'), '根路径公共 cookie 应带上: ' + out);
  assert.ok(!out.includes('PORTAL=p'), '不该带同域其他应用的 cookie: ' + out);
});
