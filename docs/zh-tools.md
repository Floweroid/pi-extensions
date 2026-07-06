# zh-tools

> 将系统提示词中的工具描述、角色定义、行为准则替换为中文。

## 解决什么问题

pi 原生的系统提示词全是英文 — 工具描述、角色定义、行为准则。这对中文模型（如 DeepSeek）会造成两个问题：① 英文概念锚定 LLM 思考过程（降低中文生成质量）；② 中英文混合的上下文增加 token 消耗（英文 token 密度低于中文）。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `before_agent_start` |
| 核心实现 | 正则匹配替换系统提示词中的英文段落 → 中文翻译表 |
| 关键决策 | ① 工具描述用字典精确匹配（TOOL_SNIPPET_ZH），角色定义用正则替换<br>② 处理顺序：先替换 "Available tools:" 段落，再应用固定文本替换表<br>③ 翻译表覆盖全部 11 个注册工具的描述<br>④ 固定文本替换表包含所有角色定义、行为准则、Pi 文档块标注 |
| 代码行数 | 228 行 |

## Agent 生命周期中的位置

```
before_agent_start
  │
  ├─ 获取 systemPrompt
  ├─ 定位 "Available tools:" 段落 → 逐工具翻译
  ├─ 正则匹配固定文本（角色/准则/文档块） → 替换为中文
  ├─ 补充翻译 "In addition to the tools above" → 中文
  └─ return { systemPrompt: 修改后的中文提示词 }
```

## 替换范围

| 类别 | 示例 |
|------|------|
| 角色定义 | "You are an expert coding assistant..." → "你是一名在 pi 内运行的专家编程助手..." |
| 工具描述 | "Read the contents of a file..." → "读取文件内容。支持文本文件和图片..." |
| 行为准则 | "Be concise" → "回复保持简洁" |
| 文档块 | "Pi documentation..." → "## Pi 文档\n\n仅在用户询问 pi 本身..." |
| 时间/目录 | "Current date:" → "当前日期：" |
