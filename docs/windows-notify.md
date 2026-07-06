# windows-notify

> 让 LLM 通过 Windows 系统通知向用户发送确认请求。

## 解决什么问题

Agent 在无人值守运行时，遇到需要用户决策的情况（方案确认、关键问题）不能发声。这个扩展注册 `windows_notify` 工具，通过 Windows NotifyIcon 气球提示向用户发送通知，AI 则等待用户回应。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerTool` |
| 核心实现 | spawn `powershell.exe` → `System.Windows.Forms.NotifyIcon` → `ShowBalloonTip()` |
| 关键决策 | ① fire-and-forget 模式（`child.unref()`），通知是辅助功能，不阻塞主流程<br>② PowerShell 字符串转义函数（`` ` `` → ```` ``、`$` → `` `$ ``、`"` → `` `" ``、换行 → `` `n ``）<br>③ 进程保持活跃 16s 确保通知完整显示 |
| 代码行数 | 122 行 |

## Agent 生命周期中的位置

```
tool_call → windows_notify
  │
  ├─ 构建 PowerShell 脚本（含字符串转义）
  ├─ spawn -STA -NonInteractive 后台进程
  ├─ 立即返回（不等待用户响应）
  └─ AI 说明："已发送通知，等待用户回到对话中回应"
```

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_name` | string | 哪个会话发出的通知 |
| `task` | string | 当前任务简述 |
| `phase` | string | 阶段（方案设计 / 代码编写 / 测试验证 / 等待部署） |
| `question` | string | 需要确认的具体问题 |

## 平台限制

仅 Windows 10/11 可用（依赖 System.Windows.Forms）。
