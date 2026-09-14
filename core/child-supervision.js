// core/child-supervision.js
// 子进程退出形态分类(dashboard 的重启策略据此分派)。纯函数,退出码协议:
//   0        正常退出(如"已有实例在运行"的让位)——不重启
//   2        需要人工处理(认证凭据失效/要求二次认证,cli 层约定)——
//            不重启,等用户重新 login 后由 dashboard 自动恢复
//   其他/崩溃 按既有策略(30s 内连崩 3 次放弃,否则 5s 重启)
// 退出码 2 的语义由 adapters/cli.js 的 runCli 约定:BAD_CREDENTIALS(调度器
// 连续 3 次)与 TWO_FACTOR_REQUIRED 以 exit(2) 退出。
'use strict';

function classifyChildExit(code, ranMs) {
  if (code === 2) return 'needs-human';
  // 正常退出:code 0 且启动后 30s 内(撞单实例锁等让位形态)
  if (code === 0 && ranMs < 30000) return 'intentional';
  return 'restart'; // 崩溃/非零退出/长跑后退出,交由重启策略
}

module.exports = { classifyChildExit };
