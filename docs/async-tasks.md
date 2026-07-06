# async-tasks

> 后台命令系统 — spawn 后立即返回，完成后自动将结果注入会话。

## 解决什么问题

LLM 执行 shell 命令时，`bash` 工具是同步阻塞的 — 命令不结束，LLM 就卡住。`async_tasks` 提供了三种模式：**fire-and-forget**（后台运行，完成后自动注入结果）、**wait**（阻塞等待，实时输出）、**peek**（查看任意任务的最新输出）。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerTool × 3` · `session_shutdown` |
| 核心实现 | `child_process.spawn` → 内存 Map 管理任务状态 → `pi.sendMessage` 自动注入结果 |
| 关键决策 | ① 30 分钟自动清理任务记录，避免内存泄漏<br>② wait 模式用 2s 轮询 + `onUpdate` 实时推送（不依赖 stream 回调，因为 Windows shell 不实时 flush）<br>③ stdout/stderr 各 1MB 截断上限 |
| 代码行数 | 217 行 |

## Agent 生命周期中的位置

```
tool_call → async_run
  │
  ├─ [非 wait 模式] 立即返回 task_id → 不阻塞
  │     └─ 进程退出 → pi.sendMessage（注入结果到会话）
  │
  ├─ [wait 模式] 2s 轮询 onUpdate → 实时输出 → 超时自动转后台
  │
  └─ session_shutdown → kill 所有运行中任务
```

## 三个工具

| 工具 | 描述 |
|------|------|
| `async_run` | 启动后台命令，返回 task_id |
| `async_list` | 列出所有任务（运行中 / 已完成） |
| `async_peek` | 查看某任务的最近 N 字符输出 |
