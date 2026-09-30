# 贡献指南（CONTRIBUTING.md）

感谢你愿意为 madmodel-proxy 做贡献。本项目无 npm 运行时依赖。

## 开发环境

- Node.js 18.14 以上（`fetch` / `AbortController` 依赖这条版本线；CI 在 18.14 / 20 / 24 上验证）
- 三平台：Windows / macOS / Linux。凭据加密分别用 DPAPI / 登录钥匙串 / 机器绑定加密；登录链实测于 Windows，macOS/Linux 的存储与启动路径由 CI 冒烟覆盖（跨平台实机验证欢迎贡献）
- 保留 `.gitattributes` 中的换行约定

## 安装与运行

```sh
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
npm start
```

跑完整功能需要配凭据（`node refresh-token.js login`，要清华账号）；纯开发不需要。

## 验证改动

- `npm test`：本地离线测试（单元 + mock 上游集成）。CI 在 Ubuntu 上用 Node 18.14/20/24 跑完整测试（Node 18.14 按文件运行以绕过 Node 18 TAP 解析器问题）；三平台另用 Node 24 跑 `platform-smoke`
- `node scripts/platform-smoke.js`：跨平台存储/启动冒烟（独立状态目录与钥匙串命名空间，不触碰真实凭据，不访问学校服务）

- 改动 SSE 解析、错误处理、超时这类协议行为后，跑 `npm run smoke` 做真实流量冒烟（需要代理在线、有效 token、消耗少量配额）——mock 测不出真实网关的形态
- `npm run check:release`：检查待发布文件；新增源码必须已纳入 Git。审阅未暂存改动时可用 `node scripts/release-check.js --worktree`，该模式不会声称已验证提交内容
- PR 描述里写清楚改了什么行为、跑过上面哪几层验证

新测试在加载产品模块前调用 `require('../scripts/isolated-env').isolate()`。子进程用 `createTestEnv()` 创建环境，避免继承用户的凭据路径、上游地址或钥匙串配置。

## 提 Issue

报 bug 附上操作系统版本、Node 版本（`node -v`）和相关日志，注意先脱敏。上游行为类问题（错误翻译、SSE 帧型）附上代理访问日志里那一行和上游错误原文。登录链问题注明实测日期，学校端点改版会让协议失效，日期是排查的第一线索。

## 提 Pull Request

较大改动建议先开 issue 说明意图，再创建分支并提交 PR。涉及协议行为的改动，合并前需要真实流量冒烟通过（维护者跑或你自证）。

## 不能提交的内容

- token 和密码。包括你本机 `token.json`、`creds.json` 的内容，以及日志截图里的 Bearer 头、学号、密码
- 真实请求体。对话内容是隐私，`DUMP_FAILED=1` 产生的 `last-failed-request.json` 绝不能入库
- 本地状态文件。`~/.madmodel-proxy/` 下的一切（`.gitignore` 有兜底，别绕过）

提交前请检查 diff。不确定时看 [SECURITY.md](SECURITY.md) 的数据流向表，或在 issue 里问。
