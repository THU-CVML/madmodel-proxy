// test/dsml.test.js — DSML 文本 → OpenAI 结构化 tool_calls 的解析。
//
// 为什么需要:2026-09-27 实测确认学校上游只在**非流式**请求下返回工具调用,
// 且以自有方言的纯文本形态(<｜DSML｜invoke name="X">…)而非结构化 tool_calls。
// 标准 OpenAI 客户端认不出这段文本,工具调用整体不可用。代理的补救路径是
// 非流式重发拿到该文本、用本模块解析后合成 tool_calls。
//
// 本文件的所有"真实样本"逐字抄自 2026-09-27 的上游实测(20 次采样),变体
// 覆盖当时观测到的全部形态——**格式在漂移,解析器按结构而非固定标签名工作**,
// 这些样本是防止它退化的基准。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseDsmlToolCalls, parseHermesToolCalls, parseToolCalls,
  looksLikeToolMarkupStart, shouldProbeSwallowedCall } = require('../core/dsml');

// ---- 真实样本(逐字) ----

test('标准形态:单工具单参数', () => {
  const text = '\n\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">\n' +
    '<｜DSML｜parameter name="command" string="true">Get-Location</｜DSML｜parameter>\n' +
    '</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'function');
  assert.strictEqual(r[0].function.name, 'Bash');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { command: 'Get-Location' });
  assert.ok(r[0].id, '应有 id');
});

test('标准形态:多参数,string="false" 还原为 JSON 类型', () => {
  const text = '\n\n<｜DSML｜tool call>\n<｜DSML｜invoke name="Bash">\n' +
    '<｜DSML｜parameter name="command" string="true">echo hello</｜DSML｜parameter>\n' +
    '<｜DSML｜parameter name="timeout" string="false">5000</｜DSML｜parameter>\n' +
    '</｜DSML｜invoke>\n</｜DSML｜tool>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r[0].function.name, 'Bash');
  const args = JSON.parse(r[0].function.arguments);
  assert.strictEqual(args.command, 'echo hello');
  assert.strictEqual(args.timeout, 5000, 'string=false 应是数字而非字符串');
});

test('值里的反斜杠路径原样保留', () => {
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="Read">' +
    '<｜DSML｜parameter name="path" string="true">C:\\Users\\xitao\\note.txt</｜DSML｜parameter>' +
    '<｜DSML｜parameter name="limit" string="false">100</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  const args = JSON.parse(r[0].function.arguments);
  assert.strictEqual(args.path, 'C:\\Users\\xitao\\note.txt');
  assert.strictEqual(args.limit, 100);
});

test('方言变体:tool_use 收尾', () => {
  const text = '<｜DSML｜tool_use><｜DSML｜invoke name="Bash">' +
    '<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_use>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r[0].function.name, 'Bash');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { command: 'ls -la' });
});

test('方言变体:半角竖线 <|DSML|>', () => {
  const text = '<|DSML|tool_calls><|DSML|invoke name="Bash">' +
    '<|DSML|parameter name="command" string="true">pwd</|DSML|parameter>' +
    '</|DSML|invoke></|DSML|tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r[0].function.name, 'Bash');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { command: 'pwd' });
});

test('畸形形态:tool call="Bash"(漏了 name=)也能取到名字', () => {
  // 20 次采样里出现过 1 次这种畸形;取不到名字就整段跳过,但这里能取到
  const text = '<｜DSML｜tool_calls><｜DSML｜tool call="Bash">' +
    '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r[0].function.name, 'Bash');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { command: 'ls' });
});

test('多个工具调用:各自独立成项', () => {
  const text = '<｜DSML｜tool_calls>' +
    '<｜DSML｜invoke name="Bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>' +
    '<｜DSML｜invoke name="Read"><｜DSML｜parameter name="path" string="true">/tmp/a.txt</｜DSML｜parameter></｜DSML｜invoke>' +
    '</｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].function.name, 'Bash');
  assert.strictEqual(r[1].function.name, 'Read');
  assert.notStrictEqual(r[0].id, r[1].id, 'id 应各不相同');
});

test('无参数工具(参数为空)仍算解析成功', () => {
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="GetTime"></｜DSML｜invoke></｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].function.name, 'GetTime');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), {});
});

test('参数值含引号与中文', () => {
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="Bash">' +
    '<｜DSML｜parameter name="command" string="true">echo "你好, 世界"</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { command: 'echo "你好, 世界"' });
});

// ---- 负样本:必须返回 null(不伪造) ----

test('普通对话文本 → null', () => {
  for (const t of ['你好，有什么可以帮你的吗？', '递归是一种函数调用自身的方法。', '']) {
    assert.strictEqual(parseDsmlToolCalls(t), null, JSON.stringify(t));
  }
});

test('非字符串输入 → null(不抛)', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.strictEqual(parseDsmlToolCalls(v), null, JSON.stringify(v));
  }
});

test('提到 DSML 但没有可解析结构 → null', () => {
  assert.strictEqual(parseDsmlToolCalls('我看到了一段 <｜DSML｜> 标记。'), null);
  assert.strictEqual(parseDsmlToolCalls('关于 <｜DSML｜tool_calls> 的说明。'), null);
});

test('invoke 取不到名字 → null(不猜工具名)', () => {
  assert.strictEqual(parseDsmlToolCalls('<｜DSML｜tool_calls><｜DSML｜invoke>正文</｜DSML｜invoke></｜DSML｜tool_calls>'), null);
});

test('parameter 无 name → 拒绝不完整调用', () => {
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="Bash">' +
    '<｜DSML｜parameter string="true">无名的值</｜DSML｜parameter>' +
    '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r, null);
});

test('string="false" 但值不是合法 JSON → 拒绝错误类型', () => {
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="F">' +
    '<｜DSML｜parameter name="x" string="false">not-json</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r, null);
});

// ---- 可靠性门:宁可不救,不可错救(2026-09-28 审阅指出的静默错误) ----

test('无 invoke 闭合标签 → null(解说文本不得被判成调用)', () => {
  // 实测:这类文本曾被判成合法调用,客户端会真执行
  assert.strictEqual(parseDsmlToolCalls('hello <｜DSML｜invoke name="Bash"> world'), null);
  assert.strictEqual(parseDsmlToolCalls('用户问:什么是 <｜DSML｜invoke name="Bash"> 格式?'), null);
});

test('参数值内含标签样文本 → null(切片不可靠,拒绝交付被裁剪的调用)', () => {
  // 实测:值里的闭合标签会让切片静默截断,而 arguments 仍是合法 JSON,
  // 客户端不报错直接执行——比失败更危险,故整次解析放弃
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="Write">' +
    '<｜DSML｜parameter name="content" string="true">看这个 </｜DSML｜parameter> 结束</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  assert.strictEqual(parseDsmlToolCalls(text), null, '值含嵌套标签应放弃解析');
});

test('值内含 invoke 标签 → null(不得裂出凭空的调用)', () => {
  // 实测:这类输入会 1 个调用裂成 2 个,第二个是模型没请求过的空调用,
  // 若名字撞上真实工具会被真的执行
  const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="Write">' +
    '<｜DSML｜parameter name="content" string="true">前<｜DSML｜invoke name="B">中</｜DSML｜invoke></｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  assert.strictEqual(parseDsmlToolCalls(text), null);
});

// ===== Qwen 系:Hermes 风格(2026-09-28 实测采集) =====
// 方言差异:标签无引号、无 DSML 前缀、无类型标注、值是"标签后换行再内容"。
// 素材全部逐字抄自 qwen3.8-27b 的实测返回(流式与非流式形态一致)

test('Hermes:单工具单参数', () => {
  const text = '\n\n<tool_call>\n<function=Calculator>\n<parameter=expression>\n12*34\n</parameter>\n</function>\n</tool_call>';
  const r = parseHermesToolCalls(text);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].function.name, 'Calculator');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { expression: '12*34' });
  assert.ok(r[0].id, '应有 id');
});

test('Hermes:多参数与含反斜杠的路径', () => {
  const text = '\n\n<tool_call>\n<function=WriteFile>\n<parameter=path>\nC:\\tmp\\a.txt\n</parameter>\n<parameter=content>\nhello\n</parameter>\n</function>\n</tool_call>';
  const r = parseHermesToolCalls(text);
  assert.strictEqual(r[0].function.name, 'WriteFile');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { path: 'C:\\tmp\\a.txt', content: 'hello' });
});

test('Hermes:多个调用并列', () => {
  const text = '\n\n<tool_call>\n<function=Calculator>\n<parameter=expression>\n12*34\n</parameter>\n</function>\n</tool_call>\n' +
    '<tool_call>\n<function=Calculator>\n<parameter=expression>\n7*58\n</parameter>\n</function>\n</tool_call>';
  const r = parseHermesToolCalls(text);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { expression: '12*34' });
  assert.deepStrictEqual(JSON.parse(r[1].function.arguments), { expression: '7*58' });
  assert.notStrictEqual(r[0].id, r[1].id);
});

test('Hermes:无参工具(空 function 体)', () => {
  const text = '\n\n<tool_call>\n<function=GetTime>\n</function>\n</tool_call>';
  const r = parseHermesToolCalls(text);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].function.name, 'GetTime');
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), {});
});

test('Hermes:值含引号与空格原样保留', () => {
  const text = '\n\n<tool_call>\n<function=Bash>\n<parameter=command>\npowershell -Command "Get-Location"\n</parameter>\n</function>\n</tool_call>';
  const r = parseHermesToolCalls(text);
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { command: 'powershell -Command "Get-Location"' });
});

test('Hermes:能当 JSON 字面量的值还原类型,否则保留字符串', () => {
  const text = '<tool_call><function=F>\n<parameter=n>\n5000\n</parameter>\n' +
    '<parameter=b>\ntrue\n</parameter>\n<parameter>s>\nnot-json\n</parameter>\n</function></tool_call>'
    .replace('<parameter>s>', '<parameter=s>');
  const r = parseHermesToolCalls(text);
  const args = JSON.parse(r[0].function.arguments);
  assert.strictEqual(args.n, 5000, '数字应还原');
  assert.strictEqual(args.b, true, '布尔应还原');
  assert.strictEqual(args.s, 'not-json', '非 JSON 保留字符串');
});

test('Hermes:负样本一律 null(不伪造)', () => {
  for (const t of [
    '你好,有什么可以帮你的?',
    '所谓 <tool_call> 是 Qwen 的格式。',                       // 提到但无结构
    '<tool_call><parameter=x>1</parameter></tool_call>',      // 无 function=
    '<tool_call><function=F><parameter=x>1</function></tool_call>', // parameter 未闭合
    '<tool_call><function=></function></tool_call>',          // 空名字
    '<tool_call><function=A><function=B></function></tool_call>', // 块内多 function
    '', null, undefined, 42,
  ]) {
    assert.strictEqual(parseHermesToolCalls(t), null, JSON.stringify(t));
  }
});

// ===== 统一入口:按内容识别方言(不依赖模型名) =====

test('parseToolCalls:两个方言都能识别', () => {
  const hermes = '<tool_call>\n<function=Calculator>\n<parameter=expression>\n1+1\n</parameter>\n</function>\n</tool_call>';
  const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="Bash">' +
    '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  assert.strictEqual(parseToolCalls(hermes)[0].function.name, 'Calculator');
  assert.strictEqual(parseToolCalls(dsml)[0].function.name, 'Bash');
  assert.strictEqual(parseToolCalls('普通文本'), null);
});

test('parseToolCalls:按内容识别而非模型名(上游换模型也不失效)', () => {
  // 同一个函数对两个方言都给结果,调用方无需知道当前是哪个模型
  const h = parseToolCalls('<tool_call><function=X>\n<parameter=a>\n1\n</parameter>\n</function></tool_call>');
  assert.strictEqual(h[0].function.name, 'X');
});

// ---- Hermes 的可靠性门(与 DSML 对等;2026-09-28 审阅指出原缺) ----

test('Hermes:值尾出现闭标签字面量 → null(不得静默裁剪)', () => {
  // 实测:模型要写的内容里含 "</parameter>" 时,非贪婪切片会把值截断成
  // "示例: ",而 arguments 仍是合法 JSON、客户端不报错直接执行被裁剪的内容。
  // 判据:合法形态的闭标签前必须是换行;不是换行即按歧义放弃
  const text = '<tool_call><function=Write>\n<parameter=content>\n示例: </parameter>\n</function>\n</tool_call>';
  assert.strictEqual(parseHermesToolCalls(text), null, '值尾闭标签字面量应放弃解析');
});

test('Hermes:值含 parameter 开标签字面量 → null', () => {
  const text = '<tool_call><function=Write>\n<parameter=content>\n规则: 遇到 <parameter=x> 开始\n</parameter>\n</function>\n</tool_call>';
  assert.strictEqual(parseHermesToolCalls(text), null);
});

test('Hermes:合法多参数仍通过(可靠性门不得误伤)', () => {
  const text = '<tool_call><function=WriteFile>\n<parameter=path>\nC:\\tmp\\a.txt\n</parameter>\n<parameter=content>\nhello\n</parameter>\n</function>\n</tool_call>';
  const r = parseHermesToolCalls(text);
  assert.deepStrictEqual(JSON.parse(r[0].function.arguments), { path: 'C:\\tmp\\a.txt', content: 'hello' });
});

// ---- stripToolMarkup:剥标记留正文(交付质量;2026-09-28 审阅指出) ----

const { stripToolMarkup } = require('../core/dsml');

test('stripToolMarkup:纯标记 → 空串', () => {
  assert.strictEqual(stripToolMarkup('\n\n<tool_call>\n<function=F>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>'), '');
  assert.strictEqual(stripToolMarkup('<｜DSML｜tool_calls><｜DSML｜invoke name="X">' +
    '<｜DSML｜parameter name="a" string="true">1</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'), '');
});

test('stripToolMarkup:正文保留、标记剥离', () => {
  const h = stripToolMarkup('我先说明一下。\n\n<tool_call>\n<function=F>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>');
  assert.strictEqual(h, '我先说明一下。');
  const d = stripToolMarkup('前言。\n<｜DSML｜invoke name="X">\n<｜DSML｜parameter name="a" string="true">1</｜DSML｜parameter>\n</｜DSML｜invoke>');
  assert.strictEqual(d, '前言。');
});

test('stripToolMarkup:无标记文本原样返回;非字符串安全', () => {
  assert.strictEqual(stripToolMarkup('就是一句话。'), '就是一句话。');
  for (const v of [null, undefined, 42, {}]) assert.strictEqual(stripToolMarkup(v), '');
});

// ---- 触发判据(1.10.1)----
// 这两个函数决定"代理要不要为非流式重发去确认一次"。1.10.1 之前用的是
// "带 tools 且没有结构化调用"——把模型正常的纯文本回答也当成故障,导致每次
// 带 tools 的请求都多打一次上游(用户实测 5 场景全 2 次;上游并发上限 3,可用
// 并发砍半),并且会把正文里的 DSML 字样伪造成真调用执行。以下是收紧后的契约。

test('起始特征:识别被截断的 DSML/Hermes 标记', () => {
  // 被上游停止序列截断的形态——只剩开头
  assert.ok(looksLikeToolMarkupStart('<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">'));
  assert.ok(looksLikeToolMarkupStart('好,我来处理。<｜DSML｜tool_calls>'));
  assert.ok(looksLikeToolMarkupStart('<tool_call>\n<function=get_weather>'));
  // 半角竖线漂移
  assert.ok(looksLikeToolMarkupStart('<|DSML|tool_calls>'));
});

test('起始特征:正常正文(含"提到"格式但不含标记起始)不误判', () => {
  // 关键区分:说明文里出现 invoke 字样但**没有** <｜DSML｜ 起始标记
  assert.ok(!looksLikeToolMarkupStart('这是一句普通回答。'));
  assert.ok(!looksLikeToolMarkupStart('函数叫 invoke,参数是 name。'));
  assert.ok(!looksLikeToolMarkupStart(''));
  for (const v of [null, undefined, 42, {}]) assert.ok(!looksLikeToolMarkupStart(v));
});

test('触发判据:有标记 → 值得重发确认', () => {
  assert.ok(shouldProbeSwallowedCall('前言。<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">'));
  assert.ok(shouldProbeSwallowedCall('<tool_call>\n<function=F>'));
});

test('触发判据:完全空回复(带 tools) → 值得重发确认', () => {
  // 模型被给了工具却一个字都不说,是"调用被吞"的典型签名(实测 EMPTY_TOOL_FRAMES)
  assert.ok(shouldProbeSwallowedCall(''));
  assert.ok(shouldProbeSwallowedCall('   \n  '));
  // 非字符串(null/undefined)表示"根本没有文本字段",不是"空文本"——
  // 不构成证据,按保守返回 false(不重发)
  for (const v of [null, undefined, 42, {}]) {
    assert.strictEqual(shouldProbeSwallowedCall(v), false, String(v));
  }
});

test('触发判据:正常纯文本回答 → 绝不重发(1.10.1 的核心)', () => {
  // 这是消除"重复请求"的判据:模型给了正文且没有标记,就是一次合法回答
  assert.ok(!shouldProbeSwallowedCall('这是一句普通回答。'));
  assert.ok(!shouldProbeSwallowedCall('我已经处理完了,结果是 42。'));
  // 即便正文里讨论工具调用格式,只要没有标记起始特征,也不算故障
  assert.ok(!shouldProbeSwallowedCall('工具调用的参数名是 name,调用标识是 invoke。'));
});
