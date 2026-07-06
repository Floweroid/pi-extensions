# timestamp

> 所有消息尾部注入 `[YYYY-MM-DD HH:MM:SS]` 时间戳。

## 解决什么问题

pi 默认不显示消息时间。在审查长对话时无法定位某条消息的生成时刻。`timestamp` 在每条消息的 content 尾部追加时间戳，同时出现在 TUI 和 LLM 上下文中。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `message_start` · `message_end` |
| 核心实现 | 读取 `event.message.timestamp` → 格式化为 Markdown 行内代码 → 追加到 content 尾部 |
| 关键决策 | ① user 消息在 `message_start` 注入（因为 `message_end` 时 TUI 可能已渲染），assistant/toolResult 在 `message_end` 注入<br>② 时间戳防重复：已有 `[YYYY-MM-DD HH:MM:SS]` 格式则跳过<br>③ 使用 Markdown 行内代码样式（`` `[2026-07-06 22:30:09]` ``）|
| 代码行数 | 73 行 |

## Agent 生命周期中的位置

```
message_start
  ├─ [user 消息] → injectTimestamp (直接修改 event.message.content)

message_end
  ├─ [assistant/toolResult/custom] → injectTimestamp → return { message }
```

## 输出示例

```
当前日期：2026-07-06

[2026-07-06 22:30:09]
```
