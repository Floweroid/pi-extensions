# pi-extensions

> **14 个扩展 · 8 个事件钩子 · 5 个自定义工具 · 5,000+ 行 TypeScript**  
> 为 pi AI coding agent 构建的扩展库。日常 90% 代码由 AI 辅助生成。

## 核心数据

| 维度 | 数字 |
|------|:--:|
| 注册的自定义工具（`registerTool`） | 5 |
| 拦截的事件钩子种类 | 8 |
| 单个扩展最大代码量 | 1,379 行（subagent） |
| 使用 DeepSeek API 的扩展 | 2（zh-compaction + auto-name） |
| 使用 Windows API 的扩展 | 2（powershell + windows-notify） |

## 事件覆盖度

| pi 事件钩子 | 订阅的扩展 | 深层含义 |
|--------|:--:|------|
| `registerTool` | 5 | 给 LLM 注册了 5 个新工具 |
| `tool_call`（拦截） | 1 | 对所有工具调用做安全门控 |
| `before_agent_start` | 1 | 每次 LLM 调用前改写系统提示词 |
| `before_provider_request` | 1 | Provider 请求层注入规则 |
| `session_before_compact` | 1 | 自定义压缩 pipeline |
| `message_start` / `message_end` | 1 | 所有消息生命周期干预 |
| `session_start` / `session_shutdown` | 4 | session 生命周期管理 |
| `turn_end` | 1 | 每轮结束触发命名更新 |

## 四个缺口

| 缺口 | 如果没有这些扩展 | 对应的扩展 |
|------|------|------|
| **跨平台** | pi 在 Windows 上只能走 bash 桥接，编码混乱 | powershell · async-tasks |
| **中文生态** | 压缩产出的摘要是英文，系统提示词也是英文 | zh-compaction · zh-tools |
| **自主工作** | Agent 不能离开人 — 危险操作没法确认，也没法通知用户 | permission-gate · windows-notify |
| **多 Agent 协作** | 无法拆分复杂任务到子代理并行处理 | subagent（single/parallel/chain） |

## 文档

每个扩展都有独立的设计文档，包括：解决什么问题、技术方案、关键决策、在 Agent 生命周期中的位置。

→ **[文档索引](./docs/INDEX.md)**

## 安装

```bash
pi install git:github.com/Floweroid/pi-extensions
```

## 许可证

MIT
