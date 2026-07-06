# embed-guard

> 管理 BGE-M3 embedding 服务生命周期，跨 pi 窗口文件锁互斥。

## 解决什么问题

session-rag 依赖 BGE-M3 embedding 服务（Python 脚本），但多个 pi 窗口同时启动会重复启动服务。`embed-guard` 用文件锁实现跨进程互斥：只有第一个拿到锁的 pi 窗口负责启动，其他窗口轮询等待。

## 技术方案

| 项目 | 内容 |
|------|------|
| 事件钩子 | `session_start` · `session_shutdown` |
| 核心实现 | 文件锁（`%TEMP%/pi-embed-server.lock`）→ 端口轮询（127.0.0.1:5100/health）→ spawn Python 服务 |
| 关键决策 | ① 僵尸锁抢占：每 5 次轮询检查锁持有者进程是否存活（`process.kill(pid, 0)`），发现死进程自动 `renameSync` 抢锁<br>② 超时兜底：锁超过 60s 未更新视为僵尸<br>③ 退出时清理自己的锁（`lockIsMine()` 检查 pid）<br>④ 日志写入临时文件，7 天后自动清空 |
| 代码行数 | 280 行 |

## Agent 生命周期中的位置

```
session_start
  │
  ├─ 端口检测 → 在线则返回
  ├─ 拿锁 → 启动 embed_server.py → 轮询上线 → 删锁
  ├─ 没拿锁 → 检查是否僵尸 → 是则抢占启动
  ├─ 否则 → 轮询等待（每 5 次检查锁状态）
  └─ session_shutdown → 清理自己的锁
```

## 命令

| 命令 | 描述 |
|------|------|
| `/embed-status` | 检查 BGE-M3 服务状态 |
| `/embed-start` | 启动服务（带互斥） |
| `/embed-stop` | 关闭服务（仅关闭自己启动的） |

## 前置条件

需要 `scripts/session-ingest/embed_server.py` + `.venv/Scripts/pythonw.exe` 在项目根目录。
