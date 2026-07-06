# powershell

> 让 LLM 直接调用 Windows PowerShell，消除 bash 桥接的编码和转义问题。

## 解决什么问题

pi 原生只提供 `bash` 工具。在 Windows 上通过 bash 桥接执行 PowerShell 需要额外转义引号，且输出编码（UTF-16LE）会导致字符截断。这个扩展注册 `powershell` 工具，直接 spawn `powershell.exe`，返回干净的 UTF-8 输出。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerTool` · `session_shutdown` |
| 核心实现 | `child_process.spawn("powershell.exe")` → UTF-8 强制编码 → 流式收集 stdout/stderr |
| 关键决策 | ① 用 `chcp 65001 + [Console]::OutputEncoding = UTF8` 保证编码一致<br>② 追踪子 PID 集合，session 退出时 `taskkill /F /T` 整棵树清理<br>③ 2s 节流 `onUpdate` 推送，避免高频刷新 |
| 代码行数 | 232 行 |

## Agent 生命周期中的位置

```
tool_call → powerShell
  │
  ├─ spawn powershell.exe
  ├─ 流式 onUpdate（节流 100ms）
  ├─ session_shutdown → kill 进程树
  └─ tool_result（最大输出 32KB）
```

## 参数 Schema

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | string（必填） | PowerShell 命令 |
| `timeout` | number（可选，默认 30s，最大 300s） | 超时秒数 |
| `cwd` | string（可选，默认 ctx.cwd） | 工作目录 |

## 额外能力

- `promptGuidelines`：自动注入使用提示到 LLM 系统提示词，"在 Windows 宿主机上执行 PowerShell 命令时用此工具"
- 命令前自动追加编码设置（对 LLM 透明）
