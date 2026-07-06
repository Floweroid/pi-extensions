# intercom-style

> 覆盖 pi-intercom 的消息渲染器，用暗紫色背景展示子代理通信。

## 解决什么问题

pi-intercom 的默认渲染与普通消息无异，难以区分子代理结果和主对话。`intercom-style` 重新渲染 `intercom_message`，用暗紫色全宽背景（`#2d2838`）区分视觉层级。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerMessageRenderer("intercom_message")` |
| 核心实现 | 自定义 React 式 Component 类 → purlpe 背景 + dim 前景 + 截断适配 |
| 关键决策 | ① 纯 TUI 组件（无 DOM），用 terminal ANSI 颜色渲染<br>② 自适应宽度：文本宽度 + 空格填充 → 整行背景色<br>③ 支持附件列表、回复引用、回复命令的分离渲染 |
| 代码行数 | 108 行 |

## Agent 生命周期中的位置

```
intercom 消息到达
  │
  └─ registerMessageRenderer → PurpleInlineMessageComponent
       ├─ 📨 From: senderName (cwd)
       ├─ 正文（dim 浅色）
       ├─ ↩ Reply 命令
       ├─ 📎 附件列表
       └─ ↳ Reply to 引用
```

## 依赖

- `@earendil-works/pi-tui`（Component, Theme, truncateToWidth, visibleWidth, wrapTextWithAnsi）
