# web-fetch

> 为 LLM 提供网络访问能力 — URL → Markdown/纯文本/HTML，带 SSRF 防护和缓存。

## 解决什么问题

LLM 需要阅读在线文档、API 参考、技术博客，但不能直接访问网络。这个扩展注册 `web_fetch` 工具，让 Agent 能主动 fetch 网页并转换为结构化文本。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `registerTool` |
| 核心实现 | Node.js `fetch` → Readability 正文提取 → turndown Markdown 转换 |
| 关键决策 | ① 先正文提取再 Markdown 转换（避免导航栏/广告污染格式）<br>② HTML→纯文本降级路径（htmlparser2）<br>③ Cloudflare 防护重试：403 + cf-mitigated 时换 UA 再次请求<br>④ HTTP→HTTPS 自动升级<br>⑤ 内网 IP 黑名单（10.x/172.16/192.168/127.x）防止 SSRF<br>⑥ 15 分钟 TTL 内存缓存，避免重复请求<br>⑦ UA 池轮换（Chrome/Firefox/Safari/Edge）降低指纹一致性<br>⑧ 同域名 2s 节流，避免触发目标站点限流 |
| 代码行数 | 448 行 |

## Agent 生命周期中的位置

```
tool_call → web_fetch
  │
  ├─ URL 校验（内网黑名单 · 最长 2000 字符）
  ├─ 缓存检查（命中 → 直接返回）
  ├─ HTTP→HTTPS 升级
  ├─ UA 池轮换 + Cloudflare 重试
  ├─ 正文提取（Readability · 回退原始 HTML）
  ├─ Markdown/文本/HTML 转换
  └─ 截断至 100K 字符
```

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | string（必填） | 需以 http:// 或 https:// 开头 |
| `format` | "markdown" \| "text" \| "html"（可选，默认 markdown） | 输出格式 |

## 外部依赖

使用懒加载模式（首次调用时才 import），避免 pi 启动开销：
- `turndown` — HTML → Markdown
- `@mozilla/readability` — 正文提取算法
- `linkedom` — 浏览器 DOM 模拟
- `htmlparser2` — HTML → 纯文本降级
