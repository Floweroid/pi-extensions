# permission-gate

> 危险操作三模式拦截器 — yolo（放行）/ warn（仅危险指令）/ strict（全部弹窗）。

## 解决什么问题

AI coding agent 可以执行任意 shell 命令、写入/编辑文件。在无人值守时，需要一道安全门。`permission-gate` 提供三种粒度：全部放行、仅拦截危险命令（rm -rf / sudo / git push --force / 格式化磁盘等）、或所有修改类工具都需人工确认。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `tool_call`（拦截） |
| 核心实现 | 正则匹配危险命令/敏感路径 → 弹出 TUI 选择器 → 允许/阻止/阻止并说明 |
| 关键决策 | ① 危险命令正则表包含 30+ 模式（系统级破坏/加密/权限变更/数据库删除/Docker/K8s/curl管道执行等）<br>② 敏感文件路径正则匹配 .env / /etc/ /boot/ /root/ .ssh/ .git/config 等<br>③ warn/strict 模式下支持子代理委托安全：subagent 也走同样的拦截逻辑<br>④ 模式状态通过 `pi.appendEntry` 持久化到 session，重启后恢复<br>⑤ 无 UI 环境（RPC 模式）自动阻止，不弹窗 |
| 代码行数 | 191 行 |

## Agent 生命周期中的位置

```
tool_call (所有工具)
  │
  ├─ [yolo] → 直接放行
  ├─ [warn] → 检查是否命中危险规则 → 是则弹窗 → 否则放行
  ├─ [strict] → 只要是修改类工具（bash/powershell/async_run/write/edit/subagent）都弹窗
  └─ [无UI] → 自动阻止并说明原因
```

## 三种模式

| 模式 | 行为 | UI 标记 |
|------|------|------|
| yolo | 全部放行 | 😎 YOLO |
| warn | 仅拦截匹配危险规则的指令（默认） | 😐 限制 |
| strict | 所有修改类工具都需确认 | 🤔 询问 |

## 命令

```
/perm-mode yolo     全部放行
/perm-mode warn     限制模式（默认）
/perm-mode strict   询问模式
```
