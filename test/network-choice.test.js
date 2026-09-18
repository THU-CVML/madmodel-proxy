// test/network-choice.test.js
// 启动层网络场景选择:判定优先级矩阵 + 状态文件读写容错。
// 判定是纯函数(decide),这里只喂输入断言输出——不需要真的启动代理。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nc = require('../network-choice');

// 每个用例一个独立临时状态目录;结束后清理(不碰真实状态目录)
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-nc-'));
}

test('decide: 无记录无变量无参数 → 询问', () => {
  const d = nc.decide({ envUpstream: '', argMode: null, choice: null });
  assert.strictEqual(d.action, 'ask');
  assert.strictEqual(d.url, null);
  assert.strictEqual(d.record, null);
});

test('decide: 环境变量最高优先 → 不询问、不设变量、无记录时落 manual', () => {
  const d = nc.decide({ envUpstream: 'http://127.0.0.1:9/v1', argMode: null, choice: null });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.url, null, '不得覆盖用户手设的变量');
  assert.strictEqual(d.record, nc.MODE_MANUAL);
});

test('decide: 环境变量已设且已有记录 → 不改记录', () => {
  const d = nc.decide({
    envUpstream: 'http://127.0.0.1:9/v1', argMode: null,
    choice: { mode: nc.MODE_CAMPUS, chosenAt: null },
  });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.record, null, '不该把 campus 记录改成 manual');
});

test('decide: 环境变量与显式参数同时给出 → 环境变量赢并提示参数被忽略', () => {
  const d = nc.decide({ envUpstream: 'http://127.0.0.1:9/v1', argMode: 'campus', choice: null });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.hint, 'env-arg-ignored');
});

test('decide: 参数 campus → 设直连 URL 并持久化', () => {
  const d = nc.decide({ envUpstream: '', argMode: 'campus', choice: null });
  assert.strictEqual(d.action, 'set');
  assert.strictEqual(d.url, nc.CAMPUS_UPSTREAM);
  assert.strictEqual(d.record, nc.MODE_CAMPUS);
});

test('decide: 参数 offcampus → 走默认(不设变量)并持久化', () => {
  const d = nc.decide({ envUpstream: '', argMode: 'offcampus', choice: null });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.url, null, '隧道形态不设 PROXY_UPSTREAM');
  assert.strictEqual(d.record, nc.MODE_OFFCAMPUS);
});

test('decide: 参数可覆盖旧记录(强制改回口子)', () => {
  const d = nc.decide({
    envUpstream: '', argMode: 'offcampus',
    choice: { mode: nc.MODE_CAMPUS, chosenAt: null },
  });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.record, nc.MODE_OFFCAMPUS);
});

test('decide: 记录 campus → 静默直连,不再问、不重写记录', () => {
  const d = nc.decide({ envUpstream: '', argMode: null, choice: { mode: nc.MODE_CAMPUS, chosenAt: null } });
  assert.strictEqual(d.action, 'set');
  assert.strictEqual(d.url, nc.CAMPUS_UPSTREAM);
  assert.strictEqual(d.record, null);
});

test('decide: 记录 offcampus → 静默隧道,不再问', () => {
  const d = nc.decide({ envUpstream: '', argMode: null, choice: { mode: nc.MODE_OFFCAMPUS, chosenAt: null } });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.record, null);
});

test('decide: 记录 manual 但变量已消失 → 走默认(安全方向)并提示', () => {
  const d = nc.decide({ envUpstream: '', argMode: null, choice: { mode: nc.MODE_MANUAL, chosenAt: null } });
  assert.strictEqual(d.action, 'pass');
  assert.strictEqual(d.url, null);
  assert.strictEqual(d.hint, 'manual-gone');
});

test('actionLine: start.cmd 解析用的动作行格式', () => {
  assert.strictEqual(nc.actionLine({ action: 'ask' }), 'ASK');
  assert.strictEqual(nc.actionLine({ action: 'pass', hint: null }), 'PASS');
  assert.strictEqual(nc.actionLine({ action: 'pass', hint: 'manual-gone' }), 'PASS manual-gone');
  assert.strictEqual(nc.actionLine({ action: 'set', url: 'https://x/y' }), 'SET https://x/y');
  // 动作行必须是单行:cmd 的 for /f 逐行读,多行会串
  for (const d of [{ action: 'ask' }, { action: 'pass', hint: 'manual-gone' }, { action: 'set', url: 'u' }]) {
    assert.ok(!nc.actionLine(d).includes('\n'), '动作行不得含换行');
  }
});

test('normalizeArg: 大小写与空白容错,非法值返回 null', () => {
  assert.strictEqual(nc.normalizeArg('campus'), 'campus');
  assert.strictEqual(nc.normalizeArg(' Campus '), 'campus');
  assert.strictEqual(nc.normalizeArg('OFFCAMPUS'), 'offcampus');
  assert.strictEqual(nc.normalizeArg(''), null);
  assert.strictEqual(nc.normalizeArg(undefined), null);
  assert.strictEqual(nc.normalizeArg('campus2'), null, '拼错的值不得被当成合法场景');
});

test('readChoice: 缺失/坏 JSON/未知 mode 一律当无记录(启动路径不能因此被拦)', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, nc.CHOICE_NAME);
    assert.strictEqual(nc.readChoice(f), null, '文件不存在');
    fs.writeFileSync(f, '{ 这不是 JSON');
    assert.strictEqual(nc.readChoice(f), null, '坏 JSON');
    fs.writeFileSync(f, JSON.stringify({ mode: '直连' }));
    assert.strictEqual(nc.readChoice(f), null, '未知 mode');
    fs.writeFileSync(f, JSON.stringify({ mode: 'campus' }));
    assert.deepStrictEqual(nc.readChoice(f), { mode: 'campus', chosenAt: null }, '合法但缺 chosenAt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeChoice/readChoice: 往返一致,且拒绝未知 mode', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, nc.CHOICE_NAME);
    nc.writeChoice(f, nc.MODE_OFFCAMPUS);
    const back = nc.readChoice(f);
    assert.strictEqual(back.mode, nc.MODE_OFFCAMPUS);
    assert.ok(typeof back.chosenAt === 'string' && !Number.isNaN(Date.parse(back.chosenAt)),
      'chosenAt 必须是可解析的 ISO 时间');
    assert.throws(() => nc.writeChoice(f, 'nope'), /未知的网络场景/);
    assert.strictEqual(nc.readChoice(f).mode, nc.MODE_OFFCAMPUS, '抛错不得破坏已有记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('choiceFile: 落在传入的状态目录下(与 paths.js 的 STATE_DIR 同源)', () => {
  const dir = tmpDir();
  try {
    assert.strictEqual(nc.choiceFile(dir), path.join(dir, nc.CHOICE_NAME));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// start.cmd 的 "recorded" 提示依赖 exit 3 协议:环境变量压过显式参数、
// 参数未落盘时必须以 3 退出(否则手设变量 + 带参运行 + 代理在跑的用户会被
// 一句没发生的"recorded"误导)。子进程级验证(判定在 CLI 层,单测够不到)。
// 注:decide 在 env 赢且无记录时会落 manual 标记("为什么没问过"有据可查),
// 这是设计行为——断言的是 campus 意图未被记录,而非目录完全无文件
test('CLI: plan campus 在 PROXY_UPSTREAM 已设时以 exit 3 退出且不记录 campus', () => {
  const { spawnSync } = require('child_process');
  const dir = tmpDir();
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'network-choice.js'), 'plan', 'campus'], {
      encoding: 'utf8',
      env: { ...process.env, PROXY_UPSTREAM: 'https://example/v1', MADMODEL_STATE_DIR: dir },
    });
    assert.strictEqual(r.status, 3, `预期 exit 3,实际 ${r.status}`);
    assert.match(r.stdout, /PASS env-arg-ignored/, '动作行仍要输出(start.cmd 依赖)');
    const f = path.join(dir, nc.CHOICE_NAME);
    if (fs.existsSync(f)) {
      assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).mode, 'manual',
        '参数意图不得被记录(顶多落 manual 备查标记)');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CAMPUS_UPSTREAM 与 README 记载的直连端点一致', () => {
  // 防漂移:这个常量是全项目第一处代码级出现(此前只在文档/测试里),
  // 改动必须与 README「校内 / 校外」一节同步
  assert.strictEqual(nc.CAMPUS_UPSTREAM, 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions');
});

test('询问文案:两个选项都在,且不得声称"回车即默认"', () => {
  const all = nc.PROMPT_LINES.join('\n');
  assert.match(all, /校园网/, '缺校园网选项');
  assert.match(all, /校外/, '缺校外选项');
  assert.match(all, /不再询问/, '缺"不再询问"的说明');
  // choice 只认 /c 里列出的键,回车不是合法键——所以"无输入=默认"只能靠
  // /t 超时实现,文案里说"回车即选中默认"是假的
  assert.doesNotMatch(all, /回车/, '提示不得声称回车即默认(choice 不接受回车)');
});

test('isCampusUpstream: 精确端点与同域变体算直连,空/隧道/其他不算', () => {
  assert.strictEqual(nc.isCampusUpstream(nc.CAMPUS_UPSTREAM), true);
  assert.strictEqual(nc.isCampusUpstream('https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions'), true);
  assert.strictEqual(nc.isCampusUpstream('https://madmodel.cs.tsinghua.edu.cn/other/path'), true, '同域变体(手设)也算直连形态');
  assert.strictEqual(nc.isCampusUpstream(''), false);
  assert.strictEqual(nc.isCampusUpstream(undefined), false);
  assert.strictEqual(nc.isCampusUpstream('https://webvpn.tsinghua.edu.cn/https/77726476336e6974646e75726e6865656162/anything'), false, '隧道前缀不是直连');
  assert.strictEqual(nc.isCampusUpstream('http://127.0.0.1:9/v1'), false);
});

test('回执与提示文案:覆盖两种选择与两种提示', () => {
  assert.match(nc.chosenLines(true).join('\n'), /校园网内/);
  assert.match(nc.chosenLines(false).join('\n'), /校外/);
  assert.match(nc.HINT_MANUAL_GONE.join('\n'), /PROXY_UPSTREAM/, 'manual-gone 提示要说明变量没了');
  assert.match(nc.HINT_MANUAL_GONE.join('\n'), /campus/, 'manual-gone 提示要给切换口子');
  assert.match(nc.HINT_ENV_WINS.join('\n'), /PROXY_UPSTREAM/);
  assert.match(nc.HINT_ENV_WINS.join('\n'), /忽略/, 'env-wins 提示要说参数被忽略');
  // 所有面向用户的文案都不得含换行(否则 cmd 的 for /f 会把动作行读串)
  for (const lines of [nc.PROMPT_LINES, nc.chosenLines(true), nc.HINT_MANUAL_GONE, nc.HINT_ENV_WINS]) {
    assert.ok(lines.every(l => typeof l === 'string' && !l.includes('\n')));
  }
});
