# 扩展设计文档索引

> 14 个扩展，按 pi Agent 生命周期事件分层组织。

## 🔧 工具注册层 — 让 LLM 能做的事更多

| 扩展 | 文档 | 代码行数 | 事件钩子 |
|------|------|:--:|------|
| powershell | [powershell.md](./powershell.md) | 232 | `registerTool` |
| async-tasks | [async-tasks.md](./async-tasks.md) | 217 | `registerTool` + `tool_execution_*` |
| web-fetch | [web-fetch.md](./web-fetch.md) | 448 | `registerTool` |
| windows-notify | [windows-notify.md](./windows-notify.md) | 122 | `registerTool` |
| subagent | [subagent.md](./subagent.md) | 1,504 | `registerTool` + `registerMessageRenderer` |

## 🧠 能力增强层 — 让 Agent 更聪明

| 扩展 | 文档 | 代码行数 | 事件钩子 |
|------|------|:--:|------|
| zh-compaction | [zh-compaction.md](./zh-compaction.md) | 334 | `session_before_compact` |
| zh-tools | [zh-tools.md](./zh-tools.md) | 228 | `before_agent_start` |
| auto-name | [auto-name.md](./auto-name.md) | 287 | `turn_end` |
| context-rules | [context-rules.md](./context-rules.md) | 51 | `before_provider_request` |

## 🏗 基础设施层 — 让 Agent 更稳定

| 扩展 | 文档 | 代码行数 | 事件钩子 |
|------|------|:--:|------|
| embed-guard | [embed-guard.md](./embed-guard.md) | 280 | `session_start` / `session_shutdown` |
| permission-gate | [permission-gate.md](./permission-gate.md) | 191 | `tool_call` |
| timestamp | [timestamp.md](./timestamp.md) | 73 | `message_start` / `message_end` |
| reload-notify | [reload-notify.md](./reload-notify.md) | 25 | `session_start` |
| intercom-style | [intercom-style.md](./intercom-style.md) | 108 | `registerMessageRenderer` |

## pi Agent 生命周期覆盖

```
pi 启动
  │
  ├─ resources_discover
  ├─ session_start ──────── embed-guard · reload-notify · auto-name
  │
用户输入 ──────────────────────────────── input (可拦截)
  │
  ├─ before_agent_start ─── zh-tools · context-rules
  ├─ agent_start
  │
  │   ┌── turn ─────────────────────────┐
  │   │  turn_start ───── timestamp     │
  │   │  before_provider_request ─────── context-rules
  │   │  LLM 响应
  │   │    ├─ tool_call ── permission-gate (拦截)
  │   │    │    ├─ powershell
  │   │    │    ├─ async_tasks
  │   │    │    ├─ web_fetch
  │   │    │    ├─ windows_notify
  │   │    │    └─ subagent
  │   │    └─ tool_result
  │   │  turn_end ───────── auto-name   │
  │   └─────────────────────────────────┘
  │
  ├─ session_before_compact ─ zh-compaction
  └─ session_shutdown ─────── embed-guard · async-tasks (cleanup)

intercom ──────────────────── intercom-style (渲染)
```
