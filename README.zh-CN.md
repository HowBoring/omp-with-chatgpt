# OMP with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，OMP 负责干活。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，OMP 却在消耗紧张的模型额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，OMP 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

## 这是什么

把 ChatGPT 网页版变成 OMP 编码会话的"规划与审查大脑"，而执行权完全保留在
OMP 手里。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的
**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

OMP 集成以 **OMP 插件**形式发布：一个仓库同时提供 Extension
（`/c2c-*` 命令、任务状态、工具门禁）和驱动 ChatGPT 浏览器流程的 Skill。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（OMP），然后去倒杯咖啡：

```text
请帮我完整安装并配置 OMP with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/HowBoring/omp-with-chatgpt 克隆到
   ~/omp-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install。
4. 安装插件：在该目录里执行 omp plugin link "$PWD"（Extension 与
   skills/omp-with-chatgpt/SKILL.md 会一起被 OMP 发现，无需复制文件）。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用专用浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用专用浏览器，禁止打开日常浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```

**更新**：Skill 每天自动检查一次 GitHub。有新版本时会提示；如果有正在进行
的 C2C 任务，更新会推迟到任务完成后再应用。应用更新后需要重启 OMP 会话，
新的 Extension 和 Skill 才会生效。也可以随时对 OMP 说"更新 OMP with ChatGPT"。

## 安装 → 配置 → 使用（手动版）

1. 安装 OMP 插件：在本仓库执行 `omp plugin link "$PWD"`。
2. 对 OMP 说：**"使用 OMP with ChatGPT 完成首次配置。"**
3. 之后正常使用：**"使用 OMP with ChatGPT，帮我实现 XXX。"**

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
OMP 会自动完成所有配置，你只会看到：

```
OMP with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。**新仓库**还会请你在 ChatGPT 里建一次项目（合集）：名字用仓库名，记忆选「仅限项目记忆」。侧栏如果没有「项目」，把鼠标放在「聊天」上，点右边三个点，选「按项目整理」。之后对话都从合集页开，不用回首页。已经在用的仓库默认还是原来的一条长对话，除非你说要改成 Project。

## 专用浏览器

ChatGPT 始终运行在**专用自动化浏览器**里，绝不用你的日常浏览器。后端显式选择并验证：

```bash
c2c browser status --json   # 查看将使用的后端及其验证状态
c2c browser set --backend omp                     # 默认：OMP 托管的 Chromium
c2c browser set --backend cdp --cdp-url http://127.0.0.1:9223 \
    --profile-dir 'C:\Temp\omp-c2c-edge-profile'  # WSL2：独立配置的 Windows Edge
c2c browser verify                                # 验证端点与专用配置目录
```

- `omp`（默认）：OMP 托管的专用 Chromium。
- `cdp`：一个以专用（非日常）配置目录运行的 Chromium 系 CDP 端点。WSL2 下
  这是已验证路径——用 `scripts/wsl2-edge-cdp.sh` 启动，它会以独立配置目录
  和 CDP 端口拉起 Windows Edge。

ChatGPT 登录态保存在专用配置目录里，重启浏览器后仍在。缺少前置条件时，
`c2c browser verify` 会明确告诉你唯一需要做的操作。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。OMP 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

如果你有 Cloudflare 账号，并且域名已经加在 Cloudflare 上，首次配置时（老用户则在下一次编码时问一次）会问你要不要用固定域名，例如 `c2c-<项目>.你的域名`。选是的话，浏览器里授权一次 Cloudflare 即可。之后重启一般不用再改插件。没有账号、不想用、登录失败：继续用临时地址，功能一样，只是修复更慢。

凭证放在系统目录，不进项目。

## 本地状态位置

所有本地状态都在系统约定的目录里（绝不写进项目）：

- Linux：`~/.local/state/omp-with-chatgpt`
- macOS：`~/Library/Application Support/omp-with-chatgpt`
- Windows：`%LOCALAPPDATA%\omp-with-chatgpt`

可用 `C2C_STATE_DIR` 覆盖。任务、checkpoint、令牌（仅存哈希）、隧道元数据
和偏好都在该目录；OMP 会话的 transcript 里保存一份 checkpoint 镜像用于恢复。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ 专用浏览器
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  只读 MCP           │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick/Named Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  只读
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│     OMP Harness     │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（专用浏览器）**：OMP 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，共 9 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`、
  `execution_output`。
- **独立审查**：OMP 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 OMP 说"测试全过"就直接相信。
- **任务纪律（Extension）**：一个工作区同时只有一个 C2C 任务，由 OMP 主会话
  持有（`/c2c-enable`、`/c2c-finish`、`/c2c-takeover`）。等待审查期间，修改类
  工具会被门禁拦截，会话也不能悄悄结束。子代理共享主任务，不能自行开任务。

## 安全模型（简版）

- **从构造上只读**：服务端根本不存在写文件/删除/Shell/提交类工具，任何提示
  注入都无法启用它们。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest：单元 + 集成 + 真实 OMP Extension 端到端

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c status / doctor / pair / unpair / logs / stop
c2c browser status  # 专用浏览器后端与验证状态
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。如果 QUIC 被拦截，设置
`C2C_TUNNEL_PROTOCOL=http2` 后重启 Bridge。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        9 个只读工具、无状态 Streamable HTTP
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick/Named Tunnel
  execution/  审查闭环所需的执行记录
  process/    守护进程生命周期
  browser/    专用浏览器后端选择与验证
  extension/  OMP Extension：/c2c-* 命令、任务状态、协议门禁
  cli/        c2c 命令行
skills/       OMP Skill（真正的 UX 层），经 plugin link 自动发现
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查 / ADR
```

## 状态与声明

**已验证环境**：Windows 11 + WSL2，OMP 18.2.4，专用 Windows Edge（独立配置
目录，CDP 接入），Cloudflare quick/named 隧道路径由测试覆盖。完整的浏览器
驱动协作闭环已在该环境端到端验证。

**未验证平台**（代码跨平台，但尚未验证）：macOS、原生 Windows、其他 Linux
发行版、纯无头远程运行。在验证前请视为未测试。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
