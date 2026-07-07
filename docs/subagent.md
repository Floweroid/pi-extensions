# subagent

> 将复杂任务拆分到专用子代理，实现多 Agent 协作。

## 解决什么问题

单个 LLM 的上下文窗口有限，且复杂任务（调查 + 编码 + 审查）在单一 Agent 中容易注意力稀释。`subagent` 将任务委派给独立的 `pi` 进程，每个子代理拥有独立上下文窗口，主 Agent 只接收摘要结果。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerTool` · `registerMessageRenderer` · `session_start` |
| 核心实现 | spawn 独立 `pi --mode json -p --no-session` 子进程 → JSONL 流式解析 → 结果注入 |
| 模块拆分 | `index.ts`（注册+编排）+ `render.ts`（TUI 渲染）+ `runner.ts`（sync 子进程执行）+ `types.ts`（类型）+ `history.ts`（日志）+ `agents.ts`（代理发现）+ `utils.ts`（工具函数） |
| 关键决策 | ① 子代理走 `--no-extensions`（无 tools 时）保持隔离<br>② 并行模式用 `mapWithConcurrencyLimit(4)` 控制并发（最多 8 个任务）<br>③ Chain 模式用 `{previous}` 占位符传递上一步输出<br>④ Async 模式 fire-and-inject，子代理结果通过 `pi.sendMessage` 作为新消息注入<br>⑤ TUI 实时进度：`Box` + `Text` 组件渲染 widget，事件驱动更新（stateKey 比对避免冗余重绘）<br>⑥ 异步 close 回调中 session_start 捕获的 `sessionCwd`/`sessionUi` 替代 `ctx.*`（terminate:true 后 ctx 失效）<br>⑦ 子代理执行历史持久化到 `.pi/subagent-logs/` + 汇总 messages.json / metadata.json |

## Agent 生命周期中的位置

```
tool_call → subagent
  │
  ├─ 权限门控（permission-gate 拦截确认）
  ├─ 发现代理（user ~/.pi/agent/agents/ + project .pi/agents/）
  ├─ [sync single]   spawn → 等待完成 → 返回结果
  ├─ [parallel mode] 并发 4 个 spawn → 合并结果
  ├─ [chain mode]    顺序 spawn → {previous} 传递
  ├─ [async single/parallel] fire-and-inject → 结果注入为新消息
  └─ TUI 实时渲染：subagent widget（事件驱动，非 100ms 轮询）
```

## 三种模式

| 模式 | 调用方式 | 场景 |
|------|----------|------|
| **single** | `{agent: "worker", task: "..."}` | 单任务委派 |
| **parallel** | `{tasks: [{agent, task}, ...]}` | 多任务并行（上限 8 并发 4） |
| **chain** | `{chain: [{agent, task}, ...]}` | 顺序执行，`{previous}` 传递上一步输出 |

## 七模块架构

| 文件 | 行数 | 职责 |
|------|:---:|------|
| `index.ts` | ~1100 | 工具注册 + 三种模式执行 + async 编排 + 子进程生命周期 + 日志持久化 |
| `render.ts` | ~400 | TUI 渲染：renderCall/renderResult + 状态键守卫 + truncateToWidth 防溢出 |
| `runner.ts` | ~160 | sync 模式子进程执行（spawn + JSONL 解析 + 超时 kill） |
| `types.ts` | ~90 | TypeBox schema（SingleCall/ParallelCall/ChainCall）+ 内部接口 |
| `history.ts` | ~80 | 日志持久化：stdout/messages/metadata 写入 `.pi/subagent-logs/` |
| `agents.ts` | ~90 | 代理发现（user/project/both 三级扫描）+ 配置解析 |
| `utils.ts` | ~180 | 常量（`SYNC_TIMEOUT_MS`/`MAX_CONCURRENCY`）+ 工具格式化 + `getPiInvocation` |

## 关键修复记录

### sessionCwd / sessionUi 捕获（2026-07-07）

异步 close 回调中，`ctx`（工具级上下文）在 `terminate: true` 返回后可能失效。修复方式：在 `session_start` 钩子中捕获 `sessionUi` 和 `sessionCwd`，异步回调中全部使用捕获值而非 `ctx.*`。

### 事件驱动 widget（2026-07-07）

原每 100ms 强制重绘 widget，导致 600 次/分的无意义 TUI 重绘和内存增长。改为 stateKey 比对（`toolLines.length + latestText` / `entry.icon + activity`）——只有实际变化才触发重绘。长运行子 agent 下重绘频率从 ~600/min 降到 ~5/min。

### 异步日志缺失（2026-07-07）

单 async 模式从未调用 `saveSubagentHistory`，原因是该调用从未在单 async 的 close 处理器中存在。补上后同时修复 `ctx.cwd` 失效问题（改用 `sessionCwd`）。

### render.ts chain 空值崩溃（2026-07-07）

LLM 生成的 chain 步骤 `task` 字段为 `undefined` 时，`step.task.replace(...)` 抛出 TypeError。修复：`(step.task || "").replace(...)`。

## 内置代理

| 代理 | 模型 | tools | 描述 |
|------|------|-------|------|
| scout | deepseek-v4-pro | bash, ls, find, grep, read, powershell | 快速只读审查（read-only），返回压缩上下文 |
| worker | deepseek-v4-pro | bash, read, write, edit, ls, find, grep, powershell, web_fetch | 全能力独立实现，隔离上下文窗口 |
| planner | deepseek-v4-pro | bash, ls, find, grep, read, powershell (read-only) | 只读分析，生成实现计划 |
| reviewer | deepseek-v4-pro | bash (限于 git-diff), ls, find, grep, read | 代码审查 |

代理定义为 Markdown 文件（在 `~/.pi/agent/agents/` 下），包含 YAML frontmatter（name/description/tools/model）和 Markdown body（system prompt）。
