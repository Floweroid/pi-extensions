# subagent

> 将复杂任务拆分到专用子代理，实现多 Agent 协作。

## 解决什么问题

单个 LLM 的上下文窗口有限，且复杂任务（调查 + 编码 + 审查）在单一 Agent 中容易注意力稀释。`subagent` 将任务委派给独立的 `pi` 进程，每个子代理拥有独立上下文窗口，主 Agent 只接收摘要结果。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerTool` · `registerMessageRenderer` · `session_start` |
| 核心实现 | spawn 独立 `pi --mode json -p --no-session` 子进程 → JSONL 流式解析 → 结果注入 |
| 关键决策 | ① 子代理走 `--no-extensions --no-skills --no-prompt-templates --no-context-files` 保证隔离<br>② 并行模式用 `mapWithConcurrencyLimit(4)` 控制并发（最多 8 个任务）<br>③ Chain 模式用 `{previous}` 占位符传递上一步输出 → 下一任务 prompt<br>④ Async 模式 fire-and-inject，子代理结果通过 `pi.sendUserMessage` 作为新消息注入<br>⑤ TUI 实时进度：`setWidget` 显示运行中代理 + 工具调用日志<br>⑥ 代理定义通过 Markdown frontmatter 发现（`getAgentDir()` + `parseFrontmatter()`） |
| 代码行数 | 1,504 行（index.ts 1,379 + agents.ts 125）|

## Agent 生命周期中的位置

```
tool_call → subagent
  │
  ├─ 发现代理（user ~/.pi/agent/agents/ + project .pi/agents/）
  ├─ [sync single]   spawn → 等待完成 → 返回结果
  ├─ [parallel mode] 并发 4 个 spawn → 合并结果
  ├─ [chain mode]    顺序 spawn → {previous} 传递
  ├─ [async single/parallel] fire-and-inject → 结果注入为新消息
  └─ TUI 实时渲染：subagent widget
```

## 三种模式

| 模式 | 调用方式 | 场景 |
|------|------|------|
| **single** | `{agent: "worker", task: "..."}` | 单任务委派 |
| **parallel** | `{tasks: [{agent, task}, ...]}` | 多任务并行（上限 8 并发 4） |
| **chain** | `{chain: [{agent, task}, ...]}` | 顺序执行，`{previous}` 传递上一步输出 |

## 两个文件

| 文件 | 职责 |
|------|------|
| `index.ts` | 工具注册 + 三种执行模式 + TUI 渲染 |
| `agents.ts` | 代理发现（user/project/both 三级目录扫描） + 配置解析 |

## 内置代理

| 代理 | 描述 |
|------|------|
| scout | 快速只读审查（read-only），返回压缩上下文 |
| worker | 全能力独立实现，隔离上下文窗口 |
| planner | 只读分析，生成实现计划 |
| reviewer | 代码审查，bash 限于 git-diff |

代理定义为 Markdown 文件（在 `~/.pi/agent/agents/` 下），包含 YAML frontmatter（name/description/tools/model）和 Markdown body（system prompt）。
