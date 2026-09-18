#!/usr/bin/env node
// network-choice.js — 启动层:网络场景选择(校园网直连 / 校外隧道)。
//
// 设计取舍:cmd 无法 require platform/paths.js(paths.js 文件头已注明该限制),
// 所以本模块同时是**唯一**的选择来源——start.cmd 只做「问一句」与「按结果设
// 环境变量」,判定逻辑全在这里(于是可单测,dashboard.js 也复用同一份判定)。
// 上游路径**只由 PROXY_UPSTREAM 环境变量承载**,config.js 现有的直连判定与
// 隧道保活自动关闭逻辑原样复用,core/ 零改动。
//
// 子命令(供 start.cmd 调用):
//   prompt                    打印询问文本块(中文由 Node 输出——cmd 的 echo 走
//                             OEM 代码页,UTF-8 中文会被打碎,所以中文一律由
//                             Node 打,start.cmd 保持纯 ASCII)
//   plan [campus|offcampus]   判定本次启动该怎么做,必要时顺带记 manual
//   show                      打印当前记录(排障用)
// 动作行(stdout,**只有这一行**,供 cmd 的 for /f 读取):
//   ASK                        缺记录,需要询问用户
//   PASS                       走现有默认(隧道)
//   PASS manual-gone           记录是 manual 但变量已消失 → 走默认并提示
//   SET <url>                  设 PROXY_UPSTREAM=<url> 后启动
// 面向用户的提示走 stderr(不被 for /f 捕获,直接显示在控制台)
//
// 安全方向(维护者定的兜底):询问的默认值必须是「校外/隧道」。误选直连的代价
// 是全量请求失败且用户难排查;误选隧道只是慢一点。
'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./platform/paths');
const { atomicWrite } = require('./platform/file-store');

// 校园网直连端点。**全项目第一处代码级出现**(此前只在 README/CHANGELOG/测试
// 里以文档形式出现);隧道默认值则由 config.js 依 madmodel-auth.js 的前缀常量
// 拼出。改这个字符串需同步 README 的「校内 / 校外」与环境变量表。
const CAMPUS_UPSTREAM = 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions';

const MODE_CAMPUS = 'campus';
const MODE_OFFCAMPUS = 'offcampus';
const MODE_MANUAL = 'manual';
const MODES = [MODE_CAMPUS, MODE_OFFCAMPUS, MODE_MANUAL];

const CHOICE_NAME = 'network-choice.json';

function choiceFile(stateDir = STATE_DIR) {
  return path.join(stateDir, CHOICE_NAME);
}

// 记录读:文件缺失、JSON 坏、mode 不认——一律当"没有记录"。这是启动路径,
// 绝不能因为一个诊断文件坏掉就拦住启动(坏了就走默认隧道)。
function readChoice(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && MODES.includes(obj.mode)) {
      return { mode: obj.mode, chosenAt: typeof obj.chosenAt === 'string' ? obj.chosenAt : null };
    }
  } catch (e) { /* 缺失/坏文件:无记录 */ }
  return null;
}

function writeChoice(file, mode, now = new Date()) {
  if (!MODES.includes(mode)) throw new Error(`未知的网络场景: ${mode}`);
  atomicWrite(file, JSON.stringify({ mode, chosenAt: now.toISOString() }, null, 2) + '\n');
}

// 纯判定:输入环境变量、命令行参数、已存记录,输出该做什么。
// 优先级:环境变量 > 命令行参数 > 已存记录 > 询问(维护者定的顺序)。
//   envUpstream  已设的 PROXY_UPSTREAM(未设为 falsy)
//   argMode      'campus' | 'offcampus' | null
//   choice       readChoice 的结果 | null
// 返回 { action, url, hint, record }:
//   action  'ask' | 'pass' | 'set'
//   url     action==='set' 时要设的值,否则 null
//   hint    给用户的一行提示码,否则 null
//   record  需要持久化的 mode,不需要则为 null
function decide({ envUpstream, argMode, choice }) {
  // 1) 环境变量最高优先:高级用户完全接管,我们不设变量、不覆盖已有记录
  //    (仅在没有记录时落一个 manual 标记,让"为什么没问过"有据可查)
  if (envUpstream) {
    return {
      action: 'pass', url: null, record: choice ? null : MODE_MANUAL,
      hint: argMode ? 'env-arg-ignored' : null,
    };
  }
  // 2) 显式参数:强制设定并可持久化(用户明确表态,覆盖旧记录)
  if (argMode === MODE_CAMPUS) {
    return { action: 'set', url: CAMPUS_UPSTREAM, hint: null, record: MODE_CAMPUS };
  }
  if (argMode === MODE_OFFCAMPUS) {
    return { action: 'pass', url: null, hint: null, record: MODE_OFFCAMPUS };
  }
  // 3) 已存记录:静默复用,不再问
  if (choice && choice.mode === MODE_CAMPUS) {
    return { action: 'set', url: CAMPUS_UPSTREAM, hint: null, record: null };
  }
  if (choice && choice.mode === MODE_OFFCAMPUS) {
    return { action: 'pass', url: null, hint: null, record: null };
  }
  // 4) 记录是 manual 但变量已不在(用户删了变量):按隧道走 + 提示
  //    ——隧道是安全方向,且要让用户知道手动覆盖已经失效
  if (choice && choice.mode === MODE_MANUAL) {
    return { action: 'pass', url: null, hint: 'manual-gone', record: null };
  }
  // 5) 什么都没有:问
  return { action: 'ask', url: null, hint: null, record: null };
}

function actionLine(d) {
  if (d.action === 'set') return `SET ${d.url}`;
  if (d.action === 'ask') return 'ASK';
  return d.hint ? `PASS ${d.hint}` : 'PASS';
}

// "当前是否直连形态"的统一判据(dashboard 的横幅与切换共用):精确等于
// 直连端点,或同一域下的其他路径(手设 PROXY_UPSTREAM 直连域变体的用户
// 也算直连形态)
function isCampusUpstream(url) {
  return url === CAMPUS_UPSTREAM || String(url || '').startsWith('https://madmodel.cs.tsinghua.edu.cn/');
}

function normalizeArg(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === MODE_CAMPUS || v === MODE_OFFCAMPUS ? v : null;
}

// 询问文本与提示(中文集中在这里,由 Node 输出;start.cmd 只负责按单键)
const PROMPT_LINES = [
  '',
  '首次使用:你的网络环境是?(之后不再询问)',
  '  [1] 校园网',
  '  [2] 校外',
];
// 选完之后回执
function chosenLines(campus) {
  return campus
    ? ['已记住:校园网内(直连)', '']
    : ['已记住:校外(WebVPN 隧道)', ''];
}
const HINT_MANUAL_GONE = [
  '提示:你之前手动设置的 PROXY_UPSTREAM 已不存在,本次走 WebVPN 隧道。',
  '      需要切换场景:运行窗口里输 campus / offcampus 回车,或运行 start.cmd campus / offcampus',
  '',
];
const HINT_ENV_WINS = [
  '提示:检测到已手动设置 PROXY_UPSTREAM,忽略 campus/offcampus 参数',
];

module.exports = {
  CAMPUS_UPSTREAM, MODE_CAMPUS, MODE_OFFCAMPUS, MODE_MANUAL, MODES,
  CHOICE_NAME, choiceFile, readChoice, writeChoice, decide, actionLine, normalizeArg,
  isCampusUpstream, PROMPT_LINES, chosenLines, HINT_MANUAL_GONE, HINT_ENV_WINS,
};

// ===== CLI =====
// plan [campus|offcampus]:判定 + 按需落盘 + 打印动作行。start.cmd 交互前调一次
// (带参数=用户显式指定),用户选完后再调一次(plan campus / plan offcampus),
// 把这个选择持久化。两条路径共用同一份 decide,不存在第二套判定。
if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const out = s => process.stdout.write(s + '\n');   // 只有动作行走 stdout(for /f 捕获)
  const note = s => process.stderr.write(s + '\n');  // 面向用户的提示走 stderr(直接显示)

  if (cmd === 'prompt') {
    for (const l of PROMPT_LINES) out(l);
    process.exit(0);
  }

  if (cmd === 'plan') {
    const argMode = normalizeArg(arg);
    // 拼错的参数不静默忽略:用户以为切换了、实际没切是最坏的形态
    if (arg && !argMode) note(`[network-choice] 未知参数:"${arg}"(可用 campus / offcampus),按无参数处理`);
    const d = decide({
      envUpstream: process.env.PROXY_UPSTREAM || '',
      argMode,
      choice: readChoice(choiceFile()),
    });
    // 写失败不拦启动(与 dashboard 的 safeWriteChoice 同一原则):记不下
    // 只是下次再问/维持旧记录,代价远小于脚本崩掉
    if (d.record) {
      try { writeChoice(choiceFile(), d.record); }
      catch (e) { note(`[network-choice] 记录选择失败(不影响本次启动): ${e?.message || e}`); }
    }
    // 回执:只有用户显式表态(带参数)时才说话,静默复用记录时不打扰
    if (d.hint === 'manual-gone') for (const l of HINT_MANUAL_GONE) note(l);
    else if (d.hint === 'env-arg-ignored') {
      for (const l of HINT_ENV_WINS) note(l);
      // 参数被环境变量压过、未落盘:start.cmd 据此不说"recorded"(exit 3)。
      // 不能 process.exit(3):那会吞掉下面 actionLine 的输出
      out(actionLine(d));
      process.exit(3);
    }
    else if (argMode) for (const l of chosenLines(argMode === MODE_CAMPUS)) note(l);
    out(actionLine(d));
    process.exit(0);
  }

  if (cmd === 'show') {
    const c = readChoice(choiceFile());
    out(c ? `${c.mode}\t${c.chosenAt || ''}` : 'none');
    if (process.env.PROXY_UPSTREAM) out(`env\t${process.env.PROXY_UPSTREAM}`);
    process.exit(0);
  }

  note('用法: node network-choice.js prompt | plan [campus|offcampus] | show');
  process.exit(2);
}
