// test/authenticate-identity.test.js — authenticateIdentity 的调用形态与表单构造。
//
// 为什么需要:该函数有 7 个位置参数,其中第 3、4 位是学号与明文密码——参数错位
// 的后果不只是 bug。此前它零测试覆盖,签名变更(删掉末位的 formVariant)只能靠
// 静态推理兜住。本测试用注入的 fetch mock 捕获实际发出的表单,钉住:
//   1. 各参数的落位(学号进 i_user、密码进 i_pass 且带 SEC1 的 04 前缀)
//   2. 提交目标就是 checkUrl(action 不再区分表单变体)
//   3. 成功判据(响应体含 ticket= 时从 <a href> 提取跳转地址)
// fetch mock 全程离线,不访问学校服务。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { MadmodelAuthClient, CookieJar } = require('../madmodel-auth');

// 学校登录页的最小形态:sm2publicKey 用一个真实生成的公钥(SEC1 未压缩点)。
// 私钥一并返回:断言"密码确实被加密进了 i_pass"必须能解回明文——只查
// 04 前缀或明文不出现,换任何一个值都满足,钉不住第 4 位实参(2026-09-21 实测:
// 把 doEncrypt 的第一个实参换成 username,四条测试全绿)
function loginPage() {
  const sm2 = require('../sm2.js');
  const { privateKey, publicKey } = sm2.generateKeyPairHex();
  return { page: `<html><script>var sm2publicKey = "${publicKey}";</script></html>`, privateKey };
}

// mock fetch:记录请求(URL + 表单体),按 script 回响应
function withFetchMock(script, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method || 'GET', body: opts.body || '' });
    const r = script(String(url), opts) || { status: 200, body: '' };
    return new Response(r.body, {
      status: r.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = original; });
}

const CHECK_URL = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check';
const FORM_URL = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/xxx/0';

test('参数落位:学号/密码/指纹各进各的字段,密码带 04 前缀', async () => {
  const { page, privateKey } = loginPage();
  await withFetchMock((url) => {
    if (url === FORM_URL) return { status: 200, body: page };
    return { status: 200, body: '登录成功<a href="https://id.tsinghua.edu.cn/ok?ticket=T1">go</a>' };
  }, async (seen) => {
    const client = new MadmodelAuthClient(new CookieJar());
    const res = await client.authenticateIdentity(
      FORM_URL, CHECK_URL, 'test-user', 'P@ssw0rd!', 'ABCDEF0123456789');
    const post = seen.find(s => s.method === 'POST');
    assert.ok(post, '未发出 POST');
    assert.strictEqual(post.url, CHECK_URL, '提交目标不是 checkUrl');
    const body = String(post.body);
    assert.ok(body.includes('i_user=test-user'), '学号未落到 i_user: ' + body.slice(0, 80));
    assert.ok(body.includes('fingerPrint=ABCDEF0123456789'), '指纹未落到 fingerPrint');
    // 密码经 SM2 加密,原文明文绝不应出现;且密文带 04 前缀(url-encoded 后为 04)
    assert.ok(!body.includes('P%40ssw0rd'), '密码明文进了表单');
    const pass = /i_pass=([^&]*)/.exec(body);
    assert.ok(pass, 'i_pass 缺失');
    const cipher = decodeURIComponent(pass[1]);
    assert.ok(cipher.startsWith('04'), 'i_pass 缺 SEC1 的 04 前缀');
    // 关键断言:密文必须能解回"第 4 位实参"。上一行的 04 前缀与
    // "明文不出现"对任何被加密的值都成立,唯有解回明文才钉住第 4 位。
    // 密文里仓库自己拼的 04 是给服务端的 SEC1 标记,doDecrypt 期望的是
    // doEncrypt 的原始输出,故先切掉。
    const sm2 = require('../sm2.js');
    assert.strictEqual(sm2.doDecrypt(cipher.slice(2), privateKey), 'P@ssw0rd!',
      'i_pass 解不回第 4 位实参(密码)——参数可能错位');
    assert.strictEqual(res.redirectUrl, 'https://id.tsinghua.edu.cn/ok?ticket=T1',
      '成功响应的跳转地址未从锚点提取');
  });
});

test('参数真的错位时,字段跟着错位(交换第 3、4 位实参)', async () => {
  const { page, privateKey } = loginPage();
  await withFetchMock((url) => {
    if (url === FORM_URL) return { status: 200, body: page };
    return { status: 200, body: '登录成功<a href="https://id.tsinghua.edu.cn/ok?ticket=T1">go</a>' };
  }, async (seen) => {
    const client = new MadmodelAuthClient(new CookieJar());
    // **真的交换**第 3、4 位(signature 是 formUrl,checkUrl,username,password,
    // fingerPrint)。先前这条只是传了不同字面量、并未交换,标题与内容不符
    // (2026-09-22 审阅指出)——那样证明不了"错位可被发现"
    const swappedUser = 'SWAPPED_USER';
    const swappedPass = 'SWAPPED_PASS';
    await client.authenticateIdentity(
      FORM_URL, CHECK_URL, swappedPass, swappedUser, 'FP');
    const body = String(seen.find(s => s.method === 'POST').body);
    // 第 3 位(实为密码)落进 i_user,第 4 位(实为学号)被加密进 i_pass
    assert.ok(body.includes('i_user=' + swappedPass),
      'i_user 未反映第 3 实参: ' + body.slice(0, 80));
    const sm2 = require('../sm2.js');
    const cipher = decodeURIComponent(/i_pass=([^&]*)/.exec(body)[1]);
    assert.strictEqual(sm2.doDecrypt(cipher.slice(2), privateKey), swappedUser,
      '交换后 i_pass 未反映第 4 实参——说明这条测试认不出错位');
  });
});

test('未带 existingFormPage 时先 GET 表单页取公钥', async () => {
  const { page } = loginPage();
  await withFetchMock((url) => {
    if (url === FORM_URL) return { status: 200, body: page };
    return { status: 200, body: '登录成功<a href="https://id.tsinghua.edu.cn/ok?ticket=T1">go</a>' };
  }, async (seen) => {
    const client = new MadmodelAuthClient(new CookieJar());
    await client.authenticateIdentity(FORM_URL, CHECK_URL, 'u', 'p', 'fp');
    assert.strictEqual(seen[0].url, FORM_URL, '第一步不是 GET 表单页');
    assert.strictEqual(seen[0].method, 'GET');
  });
});

test('登录页无公钥时明确报错,不发提交', async () => {
  await withFetchMock(() => ({ status: 200, body: '<html>改版了</html>' }), async (seen) => {
    const client = new MadmodelAuthClient(new CookieJar());
    await assert.rejects(
      () => client.authenticateIdentity(FORM_URL, CHECK_URL, 'u', 'p', 'fp'),
      (e) => e.code === 'NO_PUBLIC_KEY');
    assert.ok(!seen.some(s => s.method === 'POST'), '取不到公钥仍发了 POST');
  });
});

test('公钥标签无内容(后跟换行缩进)时报 NO_PUBLIC_KEY,不得放过', async () => {
  // 标签写成 <input id="sm2publicKey"> 且后面跟换行与缩进时,旧正则会捕获
  // 那一小段空白(truthy)通过守卫,随后 doEncrypt(password, '') 抛裸
  // TypeError。修法是抓取后做十六进制形状校验(2026-09-21)
  const page = '<html>\n  <body>\n    <input type="hidden" id="sm2publicKey">\n    <input name="pw">\n  </body>\n</html>';
  await withFetchMock(() => ({ status: 200, body: page }), async (seen) => {
    const client = new MadmodelAuthClient(new CookieJar());
    await assert.rejects(
      () => client.authenticateIdentity(FORM_URL, CHECK_URL, 'u', 'p', 'fp'),
      (e) => e.code === 'NO_PUBLIC_KEY',
      '无内容的公钥标签应报 NO_PUBLIC_KEY 而非抛裸 TypeError');
    assert.ok(!seen.some(s => s.method === 'POST'), '取不到公钥仍发了 POST');
  });
});

test('公钥形状不符时一律 NO_PUBLIC_KEY,不发提交', async () => {
  // 无 04 前缀的 128 位是"长度对但库不接受"的形态:sm2.doEncrypt 需要 SEC1
  // 未压缩点,喂无前缀会抛裸 TypeError(2026-09-22 审阅指出,实测复现)
  const sm2mod = require('../sm2.js');
  const kpNoPrefix = sm2mod.generateKeyPairHex().publicKey.slice(2);
  // 只判"抓到了非空内容"是不够的:必须验形状。逐个喂入形态对但内容错的公钥,
  // 都应被形状校验拦下——否则 doEncrypt 拿畸形公钥会抛内部错误
  const bad = [
    'not-hex-at-all',                        // 非十六进制
    '04zz' + 'a'.repeat(126),                // 含非 hex 字符
    'a'.repeat(127),                         // 长度 127(少一位)
    'a'.repeat(129),                         // 长度 129(多一位)
    '05' + 'a'.repeat(128),                  // 非法前缀(非 04)
    'a'.repeat(128),                         // 128 位无 04 前缀——sm2.doEncrypt 拒绝该形态
    kpNoPrefix,                              // 真实公钥去掉 04(库只接受未压缩点)
  ];
  for (const key of bad) {
    const page = '<html><script>var sm2publicKey = "' + key + '";</script></html>';
    await withFetchMock((url) => {
      if (url === FORM_URL) return { status: 200, body: page };
      return { status: 200, body: 'ok' };
    }, async (seen) => {
      const client = new MadmodelAuthClient(new CookieJar());
      await assert.rejects(
        () => client.authenticateIdentity(FORM_URL, CHECK_URL, 'u', 'p', 'fp'),
        (e) => e.code === 'NO_PUBLIC_KEY',
        '畸形公钥 ' + JSON.stringify(key.slice(0, 12)) + ' 未被形状校验拦下');
      assert.ok(!seen.some(s => s.method === 'POST'), '畸形公钥仍发了 POST');
    });
  }
});
