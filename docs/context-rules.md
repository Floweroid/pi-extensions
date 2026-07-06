# context-rules

> 将 `.pi/rules.md` 注入到 LLM 上下文尾部，始终只保留 1 条，不会累积。

## 解决什么问题

pi 的 system prompt 在开始时注入，但长时间对话的 recency bias 会使早期规则失效。`context-rules` 在每次 API 请求前把规则注入到消息列表**尾部**，利用 LLM 对结尾内容的高注意力。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `before_provider_request` |
| 核心实现 | 读取 `.pi/rules.md` → 过滤旧规则 system 消息（锚点 "关键规则 - 始终生效"）→ push 新规则 |
| 关键决策 | ① 挂载在 `before_provider_request` 而非 `before_agent_start`，因为在 provider 层注入确保在所有 system prompt 组装之后才追加<br>② 用锚点标记识别旧规则 → 过滤 → 始终只有 1 条，不会累积（即使后台任务重复触发也不会重复注入）<br>③ 不修改 user/assistant 消息，不影响对话历史 |
| 代码行数 | 51 行 |

## Agent 生命周期中的位置

```
before_provider_request（每次 API 调用前）
  │
  ├─ 读取 process.cwd()/.pi/rules.md
  ├─ 从 messages[] 中过滤所有旧规则（识别 "关键规则 - 始终生效" 锚点）
  ├─ push { role: "system", content: rules } 到尾部
  └─ return 修改后的 payload
```

## 设计考量

选择 `before_provider_request` 而非 `before_agent_start` 的理由：

- `before_agent_start` 修改的是 pi 的 system prompt，后段可能被其他 processor 修改
- `before_provider_request` 在最终 payload 发送前执行，能保证规则一定出现在尾部
