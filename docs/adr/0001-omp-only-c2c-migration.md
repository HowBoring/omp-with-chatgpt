# 以 C2C 契约为基线迁移为 OMP 专用产品

2026-09-17 确认：当前仓库作为 C2C fork，以保留原项目产品契约并迁移到 OMP 为目标，而不是重新设计 C2C 或建设多执行器平台。相较维护 Codex 兼容或立即拆成独立插件，此选择优先保证迁移范围可控，并保留已有 Bridge、安全边界与协作流程。

## 已接受的边界

- 保留用户使用流程、C2C 控制协议、只读 MCP 与工作区访问边界，以及 OAuth、配对、tunnel、敏感文件策略。
- 保留 long-chat/project 两种模式、计划—执行—审查循环、checkpoint 恢复和最大迭代轮次规则。ChatGPT 负责规划和审查，OMP 保留工具选择与执行判断，不由 ChatGPT 微观管理工具调用。
- OMP Extension 的状态恢复与常规工具门禁属于可靠性增强，不承诺不可绕过的安全隔离。
- 保留现有审查证据模型，但当前任务与迭代必须和 EXECUTED 对齐；执行记录查询需要按任务与迭代过滤。首个迁移版本不承诺固定代码版本的强证据链或独立可验证构建。
- 同一工作区同时只支持一个 C2C 顶层任务。不承诺同工作区并发任务隔离、OMP 分支自动创建 ChatGPT 对话或多执行器支持。
- Codex 的浏览器、sandbox allowlist、安装与更新适配替换为 OMP 路径；OMP 版本不读写 Codex 配置。对外名称与本地状态目录独立，不承诺导入旧 Codex checkpoint。
- 本地文件格式、内部字段与目录名不是必须兼容的产品契约；CLI 命名和具体打包方式尚未决定。

## 任务与会话语义

- 按任务显式启用 C2C；同一任务的补充、修正和恢复继续受约束，DONE 后的新目标需要重新启用。安装 Extension 不接管普通 OMP 请求。
- 每个工作区的活跃任务只有一个 OMP 主会话拥有执行权。其他会话可查看状态，但不能覆盖或自行接管；原会话退出后由用户显式接管。等待超时不能证明原会话已失效。子代理属于主任务，不建立独立顶层任务。
- 恢复未完成任务优先继续原 ChatGPT 对话，仅在原有切换条件下 HANDOFF。project 模式的新会话开新 chat 规则用于新 OMP 会话启动新任务，不覆盖任务恢复规则；long-chat 继续复用工作区长期对话。
- 活跃任务发生历史回退或分支切换时暂停自动推进，不回退远端状态、不自动重发、不根据历史 checkpoint 重做。可返回原执行分支继续；沿新分支工作前须明确结束旧任务并显式启动新任务。
- 实现细节澄清允许继续当前计划；目标、范围或验收条件变化时，暂停执行并请求 ChatGPT 修订 PLAN。
- 用户可随时取消本地协作。取消不等于 DONE，不回滚已有修改，不自动撤销工作区连接；断开 ChatGPT 仍是独立操作。

## 支持与交付边界

- 首次完整验收以当前 WSL2 环境与 OMP 18.2.4 为基线。保留原有跨平台代码；macOS、原生 Windows 和其他 Linux 环境实际验证前标为未验证，不宣称已支持。纯无界面的远程运行不作为本次验收目标。
- 沿用源码仓库安装体验，在本 fork 内一起交付 Bridge、OMP Extension 和 Skill，通过经验证的 OMP 原生安装或链接机制加载。本次不要求 npm 发布，不拆成需要用户分别安装的多个产品。
- 保留自动检查与自动更新体验。活跃任务期间只记录更新可用，在任务启动前或结束后的安全时机应用；需要重载 OMP 时明确提示，不允许旧 Extension 配合新 CLI 继续活跃任务。

## 状态

2026-09-17 用户最终确认：本 ADR 作为本次迁移的需求基线，需求追问结束。后续仅在能力验证发现真实缺口或契约冲突时重新提交取舍，不默认扩大范围。

以上是已确认的目标与范围，不代表当前代码已实现。剩余技术核对包括 OMP 生命周期与门禁 API、状态持久化与跨会话占用协调、Extension/Skill 打包加载及 WSL2 浏览器端到端联通。仅在核对发现真实能力缺口或契约冲突时重新提交产品取舍。

## OMP 文档核对（非运行验收）

- `omp --version` 返回 18.2.4；CLI 提供 Extension 加载与 plugin install/link/upgrade 入口。
- `omp://extensions.md` 文档提供 tool_call 拦截、会话切换/分支/tree 前后事件，以及 appendEntry/getBranch 状态持久化和恢复接口。
- 同一文档说明 session_stop 仅针对主会话，等待其后台任务空闲后触发。建议性 continue 最多 8 次；显式 decision=block 不消耗该限额，直到允许结束或用户中断。这是完成门禁，不是任务循环驱动器。
- before_agent_start 可能因后续用户消息或准备阶段重试而再次触发，因此不能把每次事件当成新任务并无条件生成 INIT。
- `omp://extension-loading.md` 与 `omp://skills.md` 支持 omp.extensions 清单及扩展包旁的 skills/ 发现；子代理会重新绑定父会话的扩展工厂，因此不能仅依赖禁用自动发现来阻止子代理启动顶层任务。
- `omp://tools/browser.md` 说明无显式浏览器选择时会考虑 relay、配置的 CDP、cmux，再使用共享 Chromium。因此 browser.open({name, url}) 不能单独保证隔离的 OMP-owned 浏览器。
- 上述核对仅确认文档能力与约束，未完成 Extension 行为实测、Skill 安装实测或 ChatGPT/连接器端到端验收。

## 能力验证结果与迁移设计

### 已实测

- 使用 OMP 18.2.4 的显式 `-e /tmp/c2c-omp-probe` 临时扩展启动非交互会话，`session_start` 能读取 `ctx.sessionManager.getSessionId()`；`appendEntry` 写入的 custom 状态在同一 `--session-dir` 下用 `--continue` 恢复后可由 `getBranch()` 读取。临时探针首次和恢复分别记录了相同 session ID 与 sequence 1，证明该路径可作为 OMP 会话状态镜像。
- 同一临时扩展注册 `tool_call` 拦截并阻止自定义工具；实际日志有 gate 事件而没有工具执行体事件，证明注册表内工具的 pre-exec 阻断可用。
- 同一临时扩展注册 `session_stop` 阻断；实际日志出现两次 stop 回调且没有工具执行体事件，证明完成门禁会重新进入主会话流程。它不能据此承担状态机驱动。
- WSL2 以独立临时用户数据目录启动 Windows Edge 153.0.4234.32 的 CDP 实例（127.0.0.1:9223），OMP 18.2.4 可通过 app.cdp_url 附加、读取 ChatGPT 页面、导航并再次重新附加。用户完成登录后，专用资料目录的登录状态仍可读取。这证明 Windows Chromium CDP 是可恢复连接后端，不等同于默认 relay，也不证明完整消息收发和连接器流程可用。
- 未登录时 OMP 能打开匿名 ChatGPT 页面并读取 aria 快照；但未完成可靠输入发送。登录前的 DOM 写入实验不能作为正式消息发送实现依据。


### 文档支持但尚未端到端验证

- OMP 文档支持 `session_before_branch/session_branch`、`session_before_tree/session_tree`、`appendEntry/getBranch`、`tool_call` 和 `session_stop`。未验证启动期 `--continue/--resume` 与分支回退的具体事件序列，也未验证主会话/子代理身份是否有公开稳定字段。
- OMP 文档支持扩展包的 `omp.extensions` 清单和同级 `skills/` 发现；当前仓库尚无该清单，Skill 仍位于 `skill/SKILL.md`，因此一体安装尚未验收。

### 当前阻塞

- WSL2 本机 Chromium 不能启动：默认 browser.open 超时，显式使用 OMP 缓存 Chromium 也无法连接 CDP；`ldd` 显示缺少 `libnspr4.so`、`libnss3.so`、`libnssutil3.so`、`libsmime3.so`。Windows Edge CDP 已在专用临时资料目录下可连接，但该依赖问题仍影响 OMP 自动选择本机 Chromium 的路径。

### 实现顺序

1. 先将当前包改成 OMP plugin package：新增 `omp.extensions`，迁移 Skill 到 `skills/<name>/SKILL.md`，保留现有 CLI/Bridge 的单仓库调用方式；用 `omp plugin link <absolute checkout>` 验证加载。
2. 设计提案（待实现验证）：workspace 级磁盘状态保存不可随历史回退的任务占用与发送意图；OMP transcript 保存会话绑定和状态镜像。状态更新使用独占锁与版本校验，拒绝过期 owner/任务/轮次。浏览器发送不在本地事务中，不能保证 exactly-once：发送结果不明时必须重新观察原对话，确认前不重发、不推进；无法确认则暂停。
3. 移除 Codex sandbox 配置调用和 Codex 安装路径，修正状态目录、产品名、连接器文案、MCP 执行器描述；Bridge/Auth/Tunnel/Workspace 安全实现保持不变。
4. 在 Extension 中实现显式命令启用、workspace 单活跃任务占用、checkpoint 镜像和 `tool_call` 常规门禁；使用 `session_stop` 做未完成审查的完成保护。任务识别不能依赖 `before_agent_start` 次数；文档调查尚未找到公开稳定的主/子代理标识，不能声称该问题已解决。
5. 浏览器后端设计需要分层验证：默认 OMP-managed 本机 Chromium 是原目标；Windows Chromium CDP 已在专用临时资料目录下证明可连接和登录后恢复，可作为本环境的显式降级；relay 不进入默认路径。消息收发、ChatGPT connector 配置和 INIT/PLAN/EXECUTED/REVIEW/DONE 的端到端验收仍未完成。
