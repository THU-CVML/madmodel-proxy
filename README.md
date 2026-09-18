# madmodel-proxy

把清华的 DeepSeek 服务（[madmodel.cs.tsinghua.edu.cn](https://madmodel.cs.tsinghua.edu.cn/)）变成本地 OpenAI 端点。token 过期自动续期，上游接口的兼容性问题在代理层处理，客户端只需连 `http://127.0.0.1:8080/v1`。

2026-09-10 起直连域名被校园网 oauth 门禁接管，上游默认走 **WebVPN 隧道**（校内、校外网络都能访问）；首次启动会问一次你的网络环境，校园网内可改走直连换取更快的路径，见[校内 / 校外](#校内--校外)。

## 使用

前置是 Windows、macOS 或 Linux，Node.js ≥ 18.14，以及一个清华统一认证账号。

```sh
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy

# 首次配置:输入学号+密码(首次登录需二次认证)
node refresh-token.js login
```

凭据静态加密存于 `%USERPROFILE%\.madmodel-proxy\`（macOS / Linux 为 `~/.madmodel-proxy/`），加密形态与数据流向见 [SECURITY.md](SECURITY.md)。不再使用时清除本机凭据：关闭 start.cmd 后运行 `node refresh-token.js logout`（清除密码、token 与隧道会话；学校侧登录状态不受影响）。

Windows 双击 **start.cmd** 启动（首次会问两件事：是否创建桌面快捷方式、以及你的网络环境是校园网还是校外——选择会记住，之后不再询问；代理已在运行时再次运行会显示状态，不会重复启动），macOS / Linux 运行 `npm start`（首次在终端里同样会问一次网络环境，非交互环境自动按隧道）。窗口保持开启。启动成功的标志是下面这样的输出：

```
[watch] madmodel token 自动续期守护进程已启动(PID 12345)
[代理] madmodel 本地端点已启动: http://127.0.0.1:8080/v1
[代理] 当前 token 剩余 272 分钟
```

在客户端（智能体、OpenAI SDK）里填以下值。

| 配置项 | 值 |
|---|---|
| 协议 | Chat Completions |
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 任意值（本地无鉴权） |
| 模型 | `DeepSeek-V4-Flash-0731` |

客户端要求填写上下文长度时填 `262144`（学校部署的实际值）。不要按官方 DeepSeek 规格配置——部分客户端会自动匹配到官方的 1M 上下文，长会话会越过上限。输出上限（max_tokens）按客户端默认即可：`prompt + max_tokens` 超出 262,144 时代理自动把输出预算收缩到剩余空间再发，仅极长输出需要续写。

## 为什么需要它

madmodel 本身有 OpenAI 格式的 API，但直接连客户端会撞上两件事。此外，2026-09-10 起直连域名 `madmodel.cs.tsinghua.edu.cn` 还被校园网新版 TsinghuaLB 的 oauth 门禁接管：未带 LB 凭证的请求被 307 到统一认证并丢失请求体，无法直接使用；因此上游统一走 **WebVPN 隧道**（不受门禁影响，校内外网络都可达），见[校内 / 校外](#校内--校外)。

**token 有效期短**。key 只有 5 小时有效期，只能网页登录后手动复制，重度使用一天要重复数次。本工具用统一认证链自动续期，到期前 30 分钟换新，代理热加载。

**接口行为与客户端预期不符**。学校网关对上游读空闲有 60 秒硬超时（2026-09-16 实测：直连与隧道两条路径都有这堵墙，非流式请求 60.1 秒收到 504 错误页）；错误都以 `HTTP 200` 返回"服务器繁忙"；`/v1/models` 返回网页 HTML。本工具在代理层逐项适配：对上游恒以流式请求、客户端要非流式就聚合——强制流式只缓解部分场景，流式下首帧等待与流中静默同样会撞 60 秒墙，截断时错误信息给出真因与处置；错误翻译回真实状态码。

### 校内 / 校外

上游有两条路径，**首次启动时会问你一句「网络环境是校园网还是校外」**，据此自动选择：

- **校园网内** → 直连 `madmodel.cs.tsinghua.edu.cn`，更快、少一跳（仅校园网内可用）
- **校外或不确定** → 走 WebVPN 隧道，任何网络都能用（默认，也是无输入/超时时的兜底）

选择记在状态目录的 `network-choice.json`，之后启动不再询问。**换了网络环境随时在运行窗口里切换**——在窗口中输入后回车：

```
campus       # 切到校园网直连
offcampus    # 切回 WebVPN 隧道
```

切换当场生效（端点与续期守护按新场景重启几秒，在途请求会中断，客户端重试即恢复；token 与登录状态在文件里，不丢）。选择同时记住，下次启动沿用。也可以用命令行切换，适合代理没在跑的时候：

```sh
# Windows
start.cmd campus      # 改成校园网直连
start.cmd offcampus   # 改回隧道
```

命令行切换立即记住、下次启动生效——代理在跑时带参数运行 `start.cmd`，会显示状态并提示；最顺的路径是直接在运行窗口里输 `campus` / `offcampus`。想重新被问一遍，删掉状态目录里的 `network-choice.json` 即可。

macOS / Linux 没有 start.cmd，用 `node network-choice.js plan campus` / `node network-choice.js plan offcampus` 切换（重启生效），或用下面的 `PROXY_UPSTREAM` 形式指定，或删掉状态目录里的 `network-choice.json` 让下次启动重新问。

**高级用法**：`PROXY_UPSTREAM` 环境变量**优先级最高**——设了它就不问、也不被覆盖，直接按你给的端点走（此时隧道会话保活自动关闭：直连无会话 cookie 可探，且直连被门禁挡时的 3xx 会被探活误判为失效）。

```sh
# 手动指定上游（优先于上面的选择）
PROXY_UPSTREAM=https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions npm start
```

无论哪种场景，token 都由认证链经 WebVPN 隧道换取、到期自动续期，行为一致。

## 特性

- **零依赖**。纯 Node 原生，clone 即用，无 `npm install`
- **token 自动续期**。到期前 30 分钟自动走登录链换新，热加载免重启。通常无需人工干预；学校要求重新验证（如可信设备失效）时重跑一次 `node refresh-token.js login`
- **本地分词预检**。内容分词与学校部署在实测样本上逐 token 一致。预检按 `prompt+max_tokens ≤ 262,144` 判定，超限自动收缩输出预算放行（极长输出可能提前截断需续写），剩余不足最低输出预算时 413
- **静态加密存储**。Windows 用 DPAPI、macOS 用登录钥匙串、Linux 用机器绑定加密
- **单窗口运行**。Windows 双击 start.cmd、macOS / Linux 用 `npm start`，同窗拉起守护与代理，Ctrl+C 或关窗全停

## 边界

- **本地无鉴权**。只监听 `127.0.0.1` + Host 白名单，客户端 API key 填任意值
- **只有 chat completions**。无 embeddings、图像、音频；会话历史含图片（`image_url` 等内容段）的请求在本地直接 400——上游不支持视觉输入，收到会立即拒绝（见[常见问题](#常见问题)）；单模型，任意模型名都会被重写为 `DeepSeek-V4-Flash-0731`；`logprobs`/`n>1` 被剥离（上游拒绝）；`max_tokens` 收敛到 [512, 65536]（下限仅思考开启时生效）

## 常见问题

| 现象 | 处理 |
|---|---|
| 请求 401 `token 已过期` | watch 守护没在跑或续期失败。`node refresh-token.js status` 一屏看清；没跑就开 start.cmd 或 `npm start` |
| 请求 503 | 本地无 token。没做过 login，或 `[watch]` 日志有报错 |
| 请求 413 上下文超限 | 会话接近 262,144 tokens 上限（`max_tokens` 已被代理自动收缩过仍不够）。新开会话，或让客户端压缩 history |
| 启动报 `端口 8080 已被占用` | 代理已在运行，直接使用；需另开实例时用 `PROXY_PORT` |
| 换了网络环境后全部请求失败 | 直连只在校园网内可用。在**运行窗口里输 `offcampus` 回车当场切回**；代理没在跑时运行 `start.cmd offcampus`（或删掉状态目录的 `network-choice.json`，下次启动会重新问） |
| 请求 400 会话历史含图片 | 历史里有 `image_url` 内容段（Codex 等客户端的 view_image 一类工具会把图片输出写进历史，此后每轮请求都带着它）。上游不支持视觉输入，收到会立即拒绝并伪装成"服务器繁忙"，重试无效。新开会话，或移除该消息后重试 |
| 请求 502/429 | 按错误信息区分：含"繁忙"是上游过载，稍后重试；含"截断"是上游拥塞期撞了学校网关的 60 秒读空闲超时，等待后重试，持续出现按错误信息中的等待秒数减小会话上下文；含"会话失效"几秒后重试（自动重签中）；含"上下文超限"按 413 行处理；其他持续出现提 issue 附代理日志 |
| 闲置过久后请求异常 | 隧道会话空闲过期（cookie 闲置约 2 小时失效）。watch 守护每 `PROXY_KEEPALIVE_MS`（默认 25 分钟）保活隧道、会话失效自动重签 token+cookie，通常无需干预 |
| 改密码后窗口大量报错并停止续期 | 正常保护行为。重新 `node refresh-token.js login`，登录后自动恢复 |
| 切换网络后第一句响应很慢 | 会话失效正在自动重签（数秒内完成并自动重试），无需操作 |
| token 长期无人续期 | 改过密码或二次认证过期，重跑一次 `node refresh-token.js login` |
| 仓库文件夹丢失 | 重新 clone 即可，登录状态不丢：状态目录（`~/.madmodel-proxy/`）与仓库分离 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_UPSTREAM` | 默认 WebVPN 隧道 | 覆盖上游端点，**优先级最高**：设了就跳过首次的网络询问、也不会被它覆盖（高级用法）。校内直连用 `madmodel.cs.tsinghua.edu.cn/v1/chat/completions`；测试可指向本地假上游；否则保持默认，由首次询问决定 |
| `PROXY_PORT` | `8080` | 监听端口 |
| `PROXY_REFRESH_AHEAD_MS` | 1800000 | 提前续期窗口（毫秒） |
| `PROXY_NO_TOKEN_WAIT_MS` | 60000 | watch 守护未配置凭据时的重查间隔（毫秒） |
| `PROXY_MAX_SLEEP_MS` | 3600000 | watch 守护单次等待上限（毫秒），到点醒来重读 token 状态 |
| `PROXY_KEEPALIVE_MS` | 1500000 | 隧道会话保活探活间隔（默认 25 分钟）；只有默认隧道上游时生效
| `PROXY_IDLE_MS` | 65000 | 流式空闲超时（毫秒）：上游持续无数据即判挂死。默认值在学校网关 60 秒读空闲超时之上留 5 秒余量——网关掐的流以"流被截断"到达并带真因归因，守卫只兜网关掐不动的挂死（TCP 挂死时连截断都没有）；不要设到 60000 以下，否则大上下文的慢预填（实测首帧最长 58 秒）会被误杀 |
| `PROXY_STREAM_TOTAL_MS` | 1200000 | 单次流式请求总时限（毫秒） |
| `PROXY_NONSTREAM_TOTAL_MS` | 600000 | 非流式请求聚合总时限（毫秒） |
| `DUMP_FAILED` | 关 | `=1` 时被上游拒绝的请求体落盘，含完整对话（隐私），排障后删 |

## 更多

- 上游实测行为与设计取舍，见 [CHANGELOG.md](CHANGELOG.md)。
- 数据流向与安全边界，见 [SECURITY.md](SECURITY.md)。
- 参与贡献，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本工具仅供清华大学师生在遵守学校相关规定的前提下个人使用，不提供配额共享，请勿用于服务他人的用途。

## 许可证

[MIT](LICENSE)
