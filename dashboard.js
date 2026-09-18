#!/usr/bin/env node
// dashboard.js — 单窗口模式:同一控制台里运行 watch 续期守护与反代,
// 两边输出加 [代理]/[watch] 前缀交错显示,Ctrl+C 或关窗即全部停止。
// 本文件只是编排器:两个子进程仍是完全独立的进程(凭据隔离/爆炸半径的
// 拆分理由全部成立),调试时可绕过它分别运行
//   node refresh-token.js watch   与   node proxy.js   (行为与从前一致)
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { checkForUpdate } = require('./core/update-check');
const { classifyChildExit } = require('./core/child-supervision');
const { TOKEN_FILE } = require('./platform/paths');
const {
  decide, readChoice, writeChoice, choiceFile, CAMPUS_UPSTREAM, MODE_CAMPUS, MODE_OFFCAMPUS,
  HINT_MANUAL_GONE, PROMPT_LINES, chosenLines, normalizeArg, isCampusUpstream,
} = require('./network-choice');
const pkg = require('./package.json');

const children = new Set();

let shuttingDown = false;

// 自动重启:崩溃(非零退出)5 秒后重启,支撑"无人值守"卖点(watch 崩了 token
// 5h 后过期、代理崩了端点消失)。防崩溃循环:启动 30s 内连续崩溃 3 次放弃该
// 子进程,两个都放弃才退出 dashboard。明确正常退出(code 0 且 <30s,如"已有
// 实例在运行")不重启
const crashStreaks = new Map();
const givenUp = new Set();
// 需人工等待恢复中的 tag(退出码 2 后等 login):收尾出口必须把它们计入
// "仍有关切对象"——否则代理先死会把恢复轮询连同进程一起带走,用户此后
// login 也无人拉起 watch
const waitingRecovery = new Set();
let pendingRestarts = 0; // 已排未触发的重启定时器数(spawn 失败收尾要避让它们)

// tag → 存活中的子进程(网络切换按 tag 找到要重启的那个)。崩溃重启路径
// 也经 launch() 维护它,始终与 children 一致
const childByTag = new Map();
// 因网络切换被主动杀掉的 tag:exit 处理器见到它不走崩溃逻辑(否则被
// classifyChildExit 记为 restart,5 秒后又拉一个,双实例撞端口),立即以
// 新上游重启
const switching = new Set();

function launch(tag, script, args) {
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.log(`[${tag}] === 子进程启动失败: ${e.message} ===`);
    return null;
  }
  children.add(child);
  childByTag.set(tag, child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    readline.createInterface({ input: stream }).on('line', line => {
      process.stdout.write(`[${tag}] ${line}\n`);
    });
  }
  // spawn 的异步失败(如脚本路径不存在)走 'error' 而非 try/catch
  child.on('error', (e) => {
    console.log(`[${tag}] === 子进程错误: ${e.message} ===`);
    children.delete(child);
    // 身份校验:迟到的 error(exit 后才到)不得抹掉新子进程的映射——
    // 无条件按 tag 删会把切换刚拉起的新进程从 map 里清掉,之后的切换
    // 误报"端点不在运行"而实际旧上游还在服务
    if (childByTag.get(tag) === child) childByTag.delete(tag);
    // spawn 失败只发 'error' 不发 'exit'(Node 文档):不排重启,但也不能
    // 让窗口无子进程无定时器地空挂。其他 tag 若有挂起的重启定时器则避让
    // ——那是一次本可自动恢复的恢复
    if (!children.size && pendingRestarts === 0) {
      console.log('\n没有存活/待重启的子进程,窗口可关闭;修复后重开 start.cmd。');
      process.exit(1);
    }
  });
  child.on('exit', (code) => {
    children.delete(child);
    if (childByTag.get(tag) === child) childByTag.delete(tag);
    // 网络切换的主动重启:立即以新 PROXY_UPSTREAM 拉起,不进崩溃分类
    // (kill 的退出形态是 code null,会被当 restart 排 5 秒双拉)
    if (switching.has(tag)) {
      switching.delete(tag);
      if (!shuttingDown) launch(tag, script, args);
      return;
    }
    const ranMs = Date.now() - startedAt;
    const kind = classifyChildExit(code, ranMs);
    if (kind === 'needs-human') {
      // 退出码 2 = 需要人工处理(凭据失效/二次认证,cli 层协议)。停止重启,
      // 给明确指引;watch 等 login 写入新凭据后自动恢复(轮询 token 文件
      // mtime——watch 已死,唯一会动它的就是人工 login/once)
      console.log(`[${tag}] === 需要人工处理(退出码 2),停止自动重启 ===`);
      console.log(`[${tag}] 请重新登录: node refresh-token.js login(登录成功后自动恢复)`);
      if (tag === 'watch') { waitingRecovery.add(tag); waitForRecovery(); }
      return;
    }
    const intentional = kind === 'intentional';
    if (intentional) {
      console.log(`[${tag}] === 子进程正常退出(code 0,不重启)` +
        (children.size ? ',其余进程继续运行 ===' : ' ==='));
    } else if (ranMs < 30000) {
      const streak = (crashStreaks.get(tag) || 0) + 1;
      crashStreaks.set(tag, streak);
      if (streak >= 3) {
        givenUp.add(tag);
        console.log(`[${tag}] === 连续 ${streak} 次快速崩溃,停止自动重启;排查看上方输出 ===`);
        if (givenUp.size >= 2) {
          console.log('\n全部子进程均已停止自动重启,窗口可关闭;修复后重开 start.cmd。');
          process.exit(1);
        }
      } else {
        console.log(`[${tag}] === 子进程崩溃(code ${code}),5 秒后自动重启(${streak}/3)===`);
      }
    } else {
      crashStreaks.set(tag, 0);
      console.log(`[${tag}] === 子进程退出(code ${code},运行 ${Math.round(ranMs / 1000)}s),5 秒后自动重启 ===`);
    }
    // intentional(如 watch 撞单实例锁)与已放弃的不排重启,其余 5 秒后重启
    if (!intentional && !givenUp.has(tag)) {
      pendingRestarts++;
      setTimeout(() => { pendingRestarts--; if (!shuttingDown) launch(tag, script, args); }, 5000);
    }
    // 没有存活/待重启/待恢复的子进程时收尾(有定时器待重启或有恢复等待
    // 则不退——恢复轮询是本进程的持续关切)
    if (!children.size && !waitingRecovery.size && (intentional || givenUp.has(tag))) {
      console.log('\n没有存活/待重启的子进程,窗口可关闭;需要时重开 start.cmd。');
      process.exit(givenUp.size ? 1 : 0);
    }
  });
  return child;
}

// 需人工状态下等待恢复:轮询 token 文件 mtime,变化即重新拉起 watch。
// login/once 都会原子替换 token.json,变化必是人工动作(watch 已死,没有
// 别的写者)。若新凭据仍无效,重启的 watch 会再次退出码 2,回到等待——
// 循环安全。不设"已有子进程"守卫:代理还活着会让它误判;双拉起由 watch
// 自身的单实例锁自愈(后来者退出码 0,dashboard 按正常退出处理)
function waitForRecovery() {
  let baseline = 0;
  try { baseline = fs.statSync(TOKEN_FILE).mtimeMs; } catch (e) { /* 无 token 文件 */ }
  const timer = setInterval(() => {
    if (shuttingDown) { clearInterval(timer); waitingRecovery.delete('watch'); return; }
    try {
      if (fs.statSync(TOKEN_FILE).mtimeMs > baseline) {
        clearInterval(timer);
        waitingRecovery.delete('watch');
        console.log('[watch] 检测到新凭据,自动恢复续期守护…');
        launch('watch', 'refresh-token.js', ['watch']);
      }
    } catch (e) { /* 文件暂缺(写入窗口):继续等 */ }
  }, 10000);
}

// ===== 网络场景(校园网直连 / 校外隧道)=====
// Windows 侧由 start.cmd 负责询问(它已把结果设进 PROXY_UPSTREAM 或状态文件),
// 本函数在两边都是**共同**的那一段:补记 manual 标记、打直连提示、并处理
// start.cmd 不覆盖的入口(npm start / node dashboard.js)。
// 判定全在 network-choice.js 的 decide(单一来源),此处不重复任何优先级逻辑。
// 与 readChoice"坏文件当无记录"同一原则:写失败(权限/只读盘)不得拦住
// 启动——记不下只是下次再问一遍,代价远小于 dashboard 崩掉或询问回调
// 永不 resolve 导致子进程不拉起。两处写调用(记录判定结果/询问结果)共用
function safeWriteChoice(mode) {
  try { writeChoice(choiceFile(), mode); }
  catch (e) { console.warn(`[network-choice] 记录选择失败(不影响启动): ${e?.message || e}`); }
}

function resolveNetworkScenario() {
  const d = decide({
    envUpstream: process.env.PROXY_UPSTREAM || '',
    argMode: null,
    choice: readChoice(choiceFile()),
  });
  if (d.record) safeWriteChoice(d.record);
  // manual-gone(此前手设的 PROXY_UPSTREAM 已不在)也要在非 Windows 入口
  // 可见,否则 npm start 用户删掉变量后静默回隧道、无从知道覆盖已失效。
  // 文案复用 network-choice.js 的常量,不在此处再抄一份
  if (d.hint === 'manual-gone') for (const l of HINT_MANUAL_GONE) console.log(l);
  // 记录/参数给出的场景要真正生效——不能只打横幅。漏了这一步的后果是:
  // 用户选了校园网、记录也在,实际却仍走隧道,且没有任何提示
  if (d.action === 'set' && d.url) process.env.PROXY_UPSTREAM = d.url;

  // 模式可见化:每次启动都亮明当前场景(对称显示,不猜)。直连用户要知道
  // 怎么切回(否则症状是全量请求失败且难排查);隧道用户要知道校内可切快
  // 路径;手动指定端点的用户要确认覆盖仍在生效
  const upstream = process.env.PROXY_UPSTREAM || '';
  if (isCampusUpstream(upstream)) {
    console.log('当前:校园网直连');
  } else if (upstream) {
    console.log(`当前:按手动设置的 PROXY_UPSTREAM 运行(${upstream})`);
  } else {
    console.log('当前:校外WebVPN 隧道');
  }

  if (d.action !== 'ask') return Promise.resolve();

  // 走到这里 = 无记录、无 PROXY_UPSTREAM(start.cmd 已处理过 Windows 的询问,
  // 所以这里只可能是 npm start / node dashboard.js 直接入口)。
  // 只在有 TTY 时问:非交互(CI/管道/计划任务)静默走默认隧道
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve();
  return askNetworkScenario();
}

function askNetworkScenario() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    // 问题文案复用 network-choice.js 的常量(去首空行),不在此处再抄一份
    for (const l of PROMPT_LINES.slice(1)) console.log(l);
    let done = false;
    const finish = campus => {
      // stdin 提前关闭(EOF / Ctrl+Z)时 question 的回调永不触发;没有这个
      // 兜底,首次启动会卡在这里、子进程永远不拉起。兜底走安全方向(隧道)
      if (done) return;
      done = true;
      rl.close();
      const mode = campus ? MODE_CAMPUS : MODE_OFFCAMPUS;
      safeWriteChoice(mode);
      if (campus) process.env.PROXY_UPSTREAM = CAMPUS_UPSTREAM;
      // 回执复用 chosenLines,不在此处另写一份(语义:未来怎么切回去)
      for (const l of chosenLines(campus)) console.log(l);
      resolve();
    };
    // 默认方向不能反:误选直连=全量请求失败,误选隧道=只是慢一点
    rl.question('输入 1 或 2: ', answer => finish(String(answer).trim() === '1'));
    rl.on('close', () => finish(false));
  });
}

// ===== 窗口内网络切换 =====
// 运行窗口里输 campus / offcampus 回车:写记录、改 PROXY_UPSTREAM、按新场景
// 重启端点与 watch 两个子进程(切换立即生效)。watch 的重启不是为了续期——
// token 续期走统一认证链,不经代理上游——而是对齐它的隧道保活开关:该开关
// 在 watch 出生时按当时形态判定,不重启的话直连下它仍探 WebVPN cookie
// (无害但困惑,2026-09-18 用户实测遇到)。判定输入合法性沿用 normalizeArg
// (大小写/空白容错,拼错静默忽略——窗口里还混着日志输出,对无关输入逐句
// 回应是噪音)
function applyScenario(mode) {
  const wantCampus = mode === MODE_CAMPUS;
  const prev = process.env.PROXY_UPSTREAM || '';
  const prevIsCampus = isCampusUpstream(prev);
  // 已在目标场景:不重启(重启会白白掐断在途请求)
  if (wantCampus ? prevIsCampus : !prev) {
    console.log(wantCampus ? '已是校内直连模式,无需切换。' : '已是校外网络模式,无需切换。');
    return;
  }
  safeWriteChoice(mode);
  // 手设过自定义 PROXY_UPSTREAM(既非直连也非空)的用户:切换会覆盖它,说一声
  const manualNote = prev && !prevIsCampus ? '(此前手动设置的 PROXY_UPSTREAM 不再生效)' : '';
  if (wantCampus) process.env.PROXY_UPSTREAM = CAMPUS_UPSTREAM;
  else delete process.env.PROXY_UPSTREAM;
  console.log(wantCampus ? `已切换:校内直连${manualNote}` : `已切换:校外WebVPN 隧道${manualNote}`);
  const proxyChild = childByTag.get('代理');
  const watchChild = childByTag.get('watch');
  if (proxyChild) {
    console.log('按新场景重启端点与续期守护(在途请求会中断几秒,客户端重试即恢复)…');
  } else {
    // 端点不在运行的两形态:已放弃自动重启(givenUp,只有下次启动)与重启
    // 定时器已排(那次拉起会用新环境)。watch 若存活仍会当场重启(保活对齐),
    // 在文案里说清,免得"[watch] 突然重启"显得无来由
    const note = watchChild ? ';续期守护将当场重启以对齐保活开关' : '';
    if (givenUp.has('代理')) console.log(`端点进程已停止自动重启,下次启动将按新场景运行${note}。`);
    else console.log(`端点进程当前不在运行,稍后自动重启时将按新场景运行${note}。`);
  }
  // 存活着的才主动重启;不在运行的(崩溃重启定时器已排/等人工恢复)由既有
  // 的重启/恢复路径带新环境拉起。**逐 tag 判定,不做全局早退**:代理 exit
  // 先落地、watch 未到的窗口里再切换一次,早退会让已重建到中间态的代理
  // 停留在旧场景静默服务(2026-09-18 审阅必修项)——逐 tag kill 才能保证
  // 每个存活进程最终都带着最新环境重建
  for (const [tag, child] of [['代理', proxyChild], ['watch', watchChild]]) {
    if (!child) continue;
    if (switching.has(tag)) {
      // 该 tag 的重启在途(kill 已发、exit 未到):env 已改好,其 exit 处理器
      // 会按最新环境重建;再 kill 将死进程若同步抛错会回滚 switching
      console.log(`[${tag}] 上一次切换的重启还在途,新场景将随之生效。`);
      continue;
    }
    switching.add(tag);
    try { child.kill(); } catch (e) { switching.delete(tag); }
  }
}

function startSwitchListener() {
  // 只在有真实终端时启用:非交互(CI/管道/计划任务)没有键盘可敲,行为不变
  if (!process.stdin.isTTY) return;
  console.log('切换网络:在本窗口输入 campus(校内直连)或 offcampus(校外网络)后回车');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    const cmd = normalizeArg(line);
    if (cmd) applyScenario(cmd);
  });
  // Ctrl+C 仍走全局 shutdown(process 的 SIGINT 处理保持不变;这里兜住
  // readline 拦下的 SIGINT,双入口由 shuttingDown 标记幂等)
  rl.on('SIGINT', () => shutdown());
}

console.log('madmodel 单窗口模式:watch 续期守护 + 本地端点同窗运行');
console.log('停止:本窗口 Ctrl+C 或直接关窗(两者一起停;watch 锁残留由下次启动自动探活接管)');
console.log('日志会显示每次对话的 token 用量;想看状态再双击一次 start.cmd(在跑即显示体检)');
console.log('──────────────────────────────────────────────');

// 启动时检查新版本:匿名请求 GitHub releases/latest(不带任何凭据,失败静默,
// 不阻塞子进程启动),有新版时打一行提示。PROXY_NO_UPDATE_CHECK=1 可关闭
// (=0 视为开启,其余非空值关闭)。catch 兜底:响应在关窗后才落地时,向已
// 关闭的 stdout 写入会抛错,不能让它变成未处理拒绝
const noUpdate = process.env.PROXY_NO_UPDATE_CHECK;
if (!noUpdate || noUpdate === '0') {
  checkForUpdate('noroadback/madmodel-proxy', pkg.version)
    .then(r => {
      if (r && r.update) {
        console.log(`[dashboard] 有新版本 ${r.update}(当前 v${pkg.version})。项目文件夹 git pull 后重开本窗口;变更说明见 github.com/noroadback/madmodel-proxy/releases`);
      }
    })
    .catch(() => {});
}

// 网络场景先定:可能包含一次询问,必须在拉起子进程之前完成(子进程继承
// process.env,PROXY_UPSTREAM 一旦在这里设好,proxy.js/config.js 无需改动
// 就会走直连——含"隧道保活自动关闭"等既有判定)。之后启用窗口内切换
resolveNetworkScenario().then(() => {
  launch('watch', 'refresh-token.js', ['watch']);
  launch('代理', 'proxy.js', []);
  startSwitchListener();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dashboard] 正在停止全部子进程…');
  for (const c of children) { try { c.kill(); } catch (e) {} }
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
// 注:Windows 控制台的 Ctrl+C 会同时送达同一控制台的所有进程,子进程通常
// 自行退出,上面的 kill 只是兜底;关窗则直接终止全部进程(无信号),watch
// 锁靠"死 PID 自动接管"自愈——与从前直接关窗口的行为一致。
