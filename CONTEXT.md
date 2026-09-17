# OMP with ChatGPT

本领域是 ChatGPT 负责规划与审查、OMP 保留执行权的 C2C 编码协作。

## Language

**工作区（Workspace）**：
ChatGPT 获准读取的实际目录范围，是 C2C 的数据访问边界；不等同于整个 Git 仓库。
_Avoid_：用“仓库”代指访问边界

**任务（Task）**：
一次具有用户目标与验收条件的编码协作，包含一轮或多轮迭代。
_Avoid_：用“会话”代指任务

**迭代（Iteration）**：
同一任务中的一轮计划、执行与审查。

**OMP 会话**：
OMP 中承载用户与执行器交互历史的本地会话，与任务和 ChatGPT 对话是不同概念。

**ChatGPT 对话（Chat）**：
承载 C2C 控制消息及 ChatGPT 规划、审查回复的远端对话。
_Avoid_：不加限定地称为“会话”

**长期对话模式（long-chat）**：
一个工作区复用一个长期 ChatGPT 对话的协作模式。

**项目模式（project）**：
一个工作区对应一个 ChatGPT Project，新的编码会话在该 Project 内开启新对话的协作模式。

**执行器（Executor）**：
使用本地工具实施计划并提供执行记录的编码 agent；本产品的执行器是 OMP。

**审查（Review）**：
ChatGPT 通过只读访问检查工作区、差异和执行记录并给出下一轮计划、完成或阻塞结论的活动；不等同于独立重跑测试。
