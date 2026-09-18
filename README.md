# OMP with ChatGPT

> ChatGPT thinks. OMP works.
> ChatGPT 负责思考，OMP 负责干活。

> [!IMPORTANT]
> **遇到问题？** 请先向 OMP 发送 **「更新 OMP with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。
> **Having trouble?** First ask OMP to **“Update OMP with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，OMP 却在消耗紧张的
模型额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
OMP 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce model tokens on planning and review. This project moves the thinking
to the subscription you already pay for; OMP only executes. No API keys, no
reverse proxy — official web UI plus a read-only MCP bridge.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 OMP 编码任务的"规划与审查大脑"，执行权
完全保留在 OMP 手里。你的工作区永远不会被上传：ChatGPT 通过一条安全的、
OAuth 保护的**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

**EN** — Use the ChatGPT web app as the planning and review brain for your
OMP coding sessions, while OMP keeps full ownership of execution. Your
workspacesitory is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected, **read-only** MCP connection to your current
workspace.

OMP integration ships as an **OMP plugin**: one checkout provides both the
Extension (`/c2c-*` commands, task state, tool gates) and the Skill that
drives the ChatGPT browser workflow.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（OMP），然后去倒杯咖啡：

```text
请帮我完整安装并配置 OMP with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
   （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/HowBoring/omp-with-chatgpt 克隆到
   ~/omp-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install && corepack pnpm build。
4. 安装插件：在该目录里执行 omp plugin link "$PWD"（Extension 与
   skills/omp-with-chatgpt/SKILL.md 会一起被 OMP 发现，无需复制文件）。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用专用浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用专用浏览器，禁止打开日常浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。
   我不懂 MCP、OAuth、隧道、端口这些词，不用给我解释。
   如果出问题，你自己先修。
```

**EN** — Paste this to your coding agent (OMP) verbatim:

```text
Install and configure OMP with ChatGPT end-to-end. Do everything yourself:

1. Check prerequisites: git and Node.js >= 20 (install whatever is missing),
   plus cloudflared.
2. Download: clone https://github.com/HowBoring/omp-with-chatgpt into
   ~/omp-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install && corepack pnpm build`.
4. Install the plugin: inside that folder run `omp plugin link "$PWD"`
   (the Extension and skills/omp-with-chatgpt/SKILL.md are discovered
   together; no files to copy).
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the DEDICATED browser,
   enter the pairing code). Never open the daily browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```

## Install → Setup → Use (manual)

1. Install the OMP plugin: run `omp plugin link <this checkout>`.
2. Tell OMP: **"Set up OMP with ChatGPT."** (中文: "使用 OMP with ChatGPT 完成首次配置。")
3. Use OMP normally: **"Use OMP with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — OMP configures everything automatically and you
just see:

```
OMP with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. OMP
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

## The dedicated browser

ChatGPT always runs in a **dedicated automation browser**, never your daily
one. The backend is selected and verified explicitly:

```bash
c2c browser status --json   # what will be used, and whether it verifies
c2c browser set --backend omp                     # default: OMP-managed Chromium
c2c browser set --backend cdp --cdp-url http://127.0.0.1:9223 \
    --profile-dir 'C:\Temp\omp-c2c-edge-profile'  # WSL2: Windows Edge, isolated profile
c2c browser verify                                # endpoint + profile identity check
```

- `omp` (default): OMP-managed dedicated Chromium.
- `cdp`: an existing Chromium-family CDP endpoint running with a dedicated,
  non-daily profile. On WSL2 this is the verified path — start it with
  `scripts/wsl2-edge-cdp.sh`, which launches Windows Edge with an isolated
  profile and CDP port.

The ChatGPT login persists in the dedicated profile across restarts. If a
prerequisite is missing, `c2c browser verify` names exactly one action.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and OMP repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or the login fails, OMP stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## Updates

The Skill checks GitHub once a day (`c2c update-check`). When a newer commit
exists it reports availability — and, if any workspace has an **active C2C
task**, the update is deferred (`deferred: true`) until the task finishes.
Applying an update means `git pull && pnpm install && pnpm build` in the checkout plus a
bridge restart; because the plugin is linked, the new Extension and Skill
load on the **next OMP session** — an OMP reload/restart is required and is
surfaced in the update output (`reloadRequired: true`).

## State location

All local state lives in the OS-convention directory (never in the project):

- Linux: `~/.local/state/omp-with-chatgpt`
- macOS: `~/Library/Application Support/omp-with-chatgpt`
- Windows: `%LOCALAPPDATA%\omp-with-chatgpt`

Override with `C2C_STATE_DIR`. Tasks, checkpoints, tokens (hashed), tunnel
metadata, and prefs live there; the OMP transcript carries a checkpoint
mirror for session recovery.

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Dedicated browser
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  read-only MCP      │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick/Named Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│     OMP Harness     │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (dedicated browser)**: OMP and ChatGPT exchange tiny
  structured `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW →
  DONE`. No diffs, no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs itself through 9 read-only
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`,
  `execution_output`.
- **Independent review**: after OMP executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.
- **Task discipline (Extension)**: one active C2C task per workspace, owned by
  the main OMP session (`/c2c-enable`, `/c2c-finish`, `/c2c-takeover`).
  While a review is pending, modifying tools are gated and the session cannot
  silently stop. Subagents share the owning task; they never start their own.

## Security model (short version)

- **Read-only by construction**: write/delete/shell/commit tools simply do not
  exist on the server. No prompt injection can enable them.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest: unit + integration + real-OMP extension e2e

c2c setup           # bridge + tunnel + pairing code, all in one
c2c status / doctor / pair / unpair / logs / stop
c2c browser status  # dedicated-browser backend + verification
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you). If QUIC is blocked, set
`C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        9 read-only tools, stateless Streamable HTTP
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  process/    daemon lifecycle
  browser/    dedicated-browser backend selection + verification
  extension/  OMP extension: /c2c-* commands, task state, protocol gates
  cli/        the c2c CLI
skills/       the OMP Skill (the real UX layer), discovered via plugin link
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting / adr
```

## Status & disclaimer

**Verified acceptance environment**: WSL2 on Windows 11, OMP 18.2.4, dedicated
Windows Edge via CDP (isolated profile), Cloudflare quick/named tunnel code
paths exercised in tests. The full browser-driven loop was validated end to
end in this environment.

**Unverified platforms** (code is cross-platform, but not yet validated):
macOS, native Windows, other Linux distributions, and purely headless/remote
operation. Treat those as untested until validated.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)
