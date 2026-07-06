# pi-extensions — AI Coding Agent 扩展集合

> 14 个 TypeScript 扩展，增强 pi Agent 的能力边界、工具生态和跨平台特性。
> 日常 90% 代码由 AI 辅助生成，这些扩展是核心工具链。

## 为什么需要这些扩展？

pi 作为 AI coding agent 框架，提供了事件系统和工具注册 API，但原生能力有限。这 14 个扩展填补了四个关键缺口：

1. **跨平台** — 原生 pi 依赖 bash，Windows 支持薄弱。`powershell` + `async-tasks` 提供了完整的 Windows 工具链
2. **中文生态** — `zh-compaction`（中文压缩 pipeline）+ `zh-tools`（系统提示词中文化）让 DeepSeek 模型在中文场景表现更好
3. **自主工作** — `windows-notify` + `permission-gate` 让 Agent 能在无人值守时安全运行，关键决策通过系统通知等待用户确认
4. **多 Agent 协作** — `subagent` 支持 single/parallel/chain 三种模式子代理委派，TUI 实时进度渲染

## 架构总览

```
pi agent lifecycle
  │
  ├─ session_start ────────── embed-guard (BGE-M3 服务管理)
  │                           auto-name (统计重置)
  │                           reload-notify (热更通知)
  │
  ├─ before_agent_start ───── zh-tools (提示词中文化)
  │                           context-rules (注入 .pi/rules.md)
  │
  ├─ turn_start ───────────── timestamp (时间戳注入)
  │
  ├─ tool_call ────────────── permission-gate (危险操作拦截)
  │    │
  │    ├─ powershell ───────── Windows 宿主机命令
  │    ├─ async_tasks ──────── 后台任务系统
  │    ├─ web_fetch ────────── URL → Markdown
  │    └─ windows_notify ───── 系统通知确认
  │
  ├─ session_before_compact ── zh-compaction (中文压缩)
  │
  └─ intercom ─────────────── intercom-style (暗紫色渲染)
```

## 扩展清单

### 🔧 工具注册层 — 让 LLM 能做的事更多

| 扩展 | 事件钩子 | 功能 |
|------|---------|------|
| [powershell.ts](./extensions/powershell.ts) | `registerTool` | Windows 宿主机 PowerShell 执行，UTF-8 编码，进程树管理 |
| [web-fetch](./extensions/web-fetch/index.ts) | `registerTool` | URL → Markdown 转换，Readability 正文提取 + turndown，SSRF 防护，15min 缓存，Cloudflare 重试 |
| [async-tasks.ts](./extensions/async-tasks.ts) | `registerTool` + `tool_execution_*` | 后台任务 spawn → auto-inject result，wait 模式实时输出 |
| [windows-notify.ts](./extensions/windows-notify.ts) | `registerTool` | Windows NotifyIcon 系统通知（PowerShell + WinForms） |

### 🧠 能力增强层 — 让 Agent 更聪明

| 扩展 | 事件钩子 | 功能 |
|------|---------|------|
| [zh-compaction.ts](./extensions/zh-compaction.ts) | `session_before_compact` | 中文压缩 pipeline，替换默认英文压缩，DeepSeek API 驱动，结构化摘要格式 |
| [zh-tools.ts](./extensions/zh-tools.ts) | `before_agent_start` | 系统提示词全面中文化 — 工具描述、角色定义、行为准则正则匹配替换 |
| [auto-name.ts](./extensions/auto-name.ts) | `turn_end` | 每 5 轮调用 DeepSeek API 生成状态化 session 标题（格式：`[状态]主题:进展[时间]`） |
| [context-rules.ts](./extensions/context-rules.ts) | `before_provider_request` | 注入 `.pi/rules.md` 到上下文尾部，始终只保留 1 条规则不累积 |
| [subagent](./extensions/subagent/index.ts) | `registerTool` | 委托任务给专用子代理（scout/worker/planner/reviewer），single/parallel/chain 三模式 + 进度渲染 |

### 🏗 基础设施层 — 让 Agent 更稳定

| 扩展 | 事件钩子 | 功能 |
|------|---------|------|
| [embed-guard.ts](./extensions/embed-guard.ts) | `session_start` / `session_shutdown` | BGE-M3 embedding 服务跨进程文件锁互斥启停，僵尸锁抢占 |
| [permission-gate.ts](./extensions/permission-gate.ts) | `tool_call` | 危险操作三模式拦截（yolo / warn / strict），支持子agent 委托安全 |
| [timestamp.ts](./extensions/timestamp.ts) | `message_start` / `message_end` | 所有消息尾部注入时间戳 |
| [reload-notify.ts](./extensions/reload-notify.ts) | `session_start` | 扩展热更后注入确认消息 |
| [intercom-style.ts](./extensions/intercom-style.ts) | `registerMessageRenderer` | intercom 消息暗紫色渲染 |

## 事件覆盖度

| 事件 | 订阅的扩展数 |
|------|:--:|
| `registerTool` | 5 |
| `session_start` / `session_start(reload)` | 3 |
| `turn_end` | 1 |
| `session_before_compact` | 1 |
| `before_agent_start` | 1 |
| `before_provider_request` | 1 |
| `tool_call` (intercept) | 1 |
| `message_start` / `message_end` | 1 |
| `session_shutdown` | 2 |

## 技术栈

- **TypeScript**（jiti 运行时编译，零构建）
- **pi SDK**：`@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` + `@earendil-works/pi-tui` + `typebox`
- **外部依赖**（仅 web-fetch）：`turndown` · `@mozilla/readability` · `linkedom` · `htmlparser2`
- **API 集成**：DeepSeek API（zh-compaction + auto-name）

## Agent 定义

| 代理 | 描述 | 来源 |
|------|------|------|
| [scout](./agents/scout.md) | 快速只读审查，返回压缩上下文 | 内置 |
| [worker](./agents/worker.md) | 全能力独立实现，隔离上下文 | 内置 |
| [planner](./agents/planner.md) | 只读分析，生成实现计划 | 内置 |
| [reviewer](./agents/reviewer.md) | 代码审查，bash 限 git-diff | 内置 |

## 安装

```bash
# 从 GitHub 安装
pi install git:github.com/Floweroid/pi-extensions

# 查看已加载的扩展
pi --list-extensions
```

## 前置条件

| 扩展 | 前置条件 |
|------|---------|
| `embed-guard` | 需要 `scripts/session-ingest/embed_server.py` + `.venv` 在项目根目录 |
| `zh-compaction` / `auto-name` | 需要 DeepSeek API key 在 pi 中配置 |
| `web-fetch` | 需要 `npm install`（turndown 等外部依赖） |
| `windows-notify` | 仅 Windows 可用 |

## 许可证

MIT
