# zh-compaction

> 替换 pi 默认英文压缩为中文结构化摘要，使用 DeepSeek API 驱动。

## 解决什么问题

pi 原生的 compaction（对话压缩）产出的摘要是英文，包含英文格式标签。在中文对话场景中，这对 DeepSeek 模型的理解有锚定效应。这个扩展用中文提示词替换整个压缩 pipeline，产出中文结构化摘要（含目标/进度/决策/后续步骤）。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `session_before_compact` |
| 核心实现 | 拦截 compaction 事件 → 序列化对话为中文标签 → 调用 DeepSeek API 生成摘要 |
| 关键决策 | ① 摘要格式固定为六个部分（目标 · 约束 · 进度 · 决策 · 后续步骤 · 上下文），结构可被下游 LLM 直接理解<br>② 首次压缩 vs 增量更新使用不同提示词模板<br>③ split turn 场景（一个 turn 被截断）额外生成前缀上下文摘要<br>④ DeepSeek-chat 优先（更便宜），不可用时回退 DeepSeek-v4-pro；两个都不在则回退 pi 默认压缩<br>⑤ 消息序列化时截断工具结果到 2000 字符（与默认行为一致） |
| 代码行数 | 334 行 |

## Agent 生命周期中的位置

```
session_before_compact
  │
  ├─ 消息序列化（中文标签：用户/助手/助手思考/工具结果）
  ├─ 首次压缩 → 调用 LLM（完整提示词）
  │     或
  ├─ 增量更新 → 调用 LLM（update 提示词 + previous_summary）
  ├─ [split turn] → 额外生成 turn 前缀摘要
  ├─ 追加文件操作信息（<read-files> / <modified-files>）
  └─ 返回自定义 compaction → pi 使用此摘要替代默认
```

## 摘要格式

```markdown
## 目标
[用户想要完成什么？]

## 约束与偏好
- [用户提到的约束]

## 进度
### 已完成
- [x] [已完成的任务]

### 进行中
- [ ] [当前工作]

### 阻塞
- [阻碍]

## 关键决策
- **[决策]**：[理由]

## 后续步骤
1. [接下来做什么]

## 关键上下文
- [继续工作需要的资料]
```

## 依赖

- DeepSeek API（deepseek-chat 或 deepseek-v4-pro）
- `completeSimple` from `@earendil-works/pi-ai`
