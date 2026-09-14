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

launch('watch', 'refresh-token.js', ['watch']);
launch('代理', 'proxy.js', []);

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
