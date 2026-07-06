# reload-notify

> 扩展热重载（`/reload`）后注入确认消息。

## 解决什么问题

pi 的 `/reload` 命令执行后没有反馈，用户不知道重载是否成功。`reload-notify` 在 `session_start` 的 `reason === "reload"` 时注入一条紫色确认消息。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `session_start` |
| 核心实现 | `pi.sendMessage({ customType: "reload", display: true })` |
| 关键决策 | followUp 模式 → 不触发 LLM 对话，仅作为 UI 提示 |
| 代码行数 | 25 行 |

## Agent 生命周期中的位置

```
session_start (reason: "reload")
  │
  └─ pi.sendMessage("扩展已通过 /reload 重新加载", { followUp })
```
