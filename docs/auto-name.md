# auto-name

> 每 5 轮对话自动调用 DeepSeek API 生成状态化 session 标题。

## 解决什么问题

pi 默认用第一句话作为 session 名，不适合长对话。`auto-name` 定期用 LLM 生成结构化标题，包含任务状态、主题、当前进展和时间戳。格式：`[进行中]Agent扩展:编写subagent文档[22:30:09 2026-07-06]`

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `turn_end` · `session_start` |
| 核心实现 | 每 5 轮触发 → 提取最近 8 条消息 → 序列化 → 调用 DeepSeek-chat API → 解析 `状态|标题|进展` 输出 |
| 关键决策 | ① 状态标签固定为四个：进行中/已完成/暂停/闲置（限制 LLM 选择范围，避免发散）<br>② 首次尝试 deepseek-chat（极便宜），不可用回退 deepseek-v4-pro<br>③ 支持手动指定状态（`/auto-name 进行中`），跳过状态判断只问标题和进展<br>④ 连续失败 3 次才通知用户（容忍间歇性 API 故障）<br>⑤ 累计 token 和费用统计，每次通知展示 |
| 代码行数 | 287 行 |

## Agent 生命周期中的位置

```
turn_end (每 5 轮)
  │
  ├─ 提取最近 8 条消息（user/assistant）
  ├─ 序列化为 "[用户]: xxx\n[助手]: xxx"
  ├─ 调用 DeepSeek API（maxToken=60）
  ├─ 解析 "进行中|扩展开发|编写subagent插件"
  ├─ pi.setSessionName("[进行中]扩展开发:编写subagent插件[22:30:09 2026-07-06]")
  └─ ctx.ui.notify（含 token 统计）
```

## 命令

| 命令 | 描述 |
|------|------|
| `/auto-name` | 手动触发 AI 命名 |
| `/auto-name 已完成` | 指定状态标签 |
| `/auto-name to-session` | WT 标签名 → session 名（不消耗 token） |
| `/auto-name to-tab` | session 名 → WT 标签 |

## 依赖

- DeepSeek API（deepseek-chat 优先）
- `completeSimple` from `@earendil-works/pi-ai`
