/**
 * Embed Guard Extension (embed-guard)
 *
 * 管理 BGE-M3 embedding 服务（embed_server.py）的生命周期。
 * 使用文件锁实现跨 pi 窗口的互斥启动，避免多窗口重复启动 embed server。
 *
 * 命令：
 *   /embed-status — 检查服务状态
 *   /embed-start  — 启动服务
 *   /embed-stop   — 关闭服务
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";

// ============================================================================
// 配置
// ============================================================================

const PORT = 5100;
const PYTHON = path.join(process.cwd(), "scripts", "session-ingest", ".venv", "Scripts", "pythonw.exe");
const SCRIPT = path.join(process.cwd(), "scripts", "session-ingest", "embed_server.py");
const SCRIPT_DIR = path.join(process.cwd(), "scripts", "session-ingest");

/** 锁文件路径（跨进程互斥） */
const LOCK_FILE = path.join(os.tmpdir(), "pi-embed-server.lock");

/** 端口轮询间隔 (ms) */
const POLL_INTERVAL = 500;

/** 每次轮询中，每 N 次额外检查一次锁状态 */
const LOCK_CHECK_EVERY = 5;

/** 等待端口上线的最大时间 (ms) */
const MAX_WAIT = 45000;

/** 僵尸锁超时 (ms)：超过此时间未更新的锁可被抢占 */
const STALE_LOCK_MS = 60000;

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// 端口检测（使用 Node.js 内置 http，无外部依赖）
// ============================================================================

/** 完整检测（3s 超时），适合单次状态查询 */
function checkPort(): Promise<string> {
  return checkPortWithTimeout(3000);
}

/** 快速检测（1.5s 超时），适合轮询 */
function checkPortQuick(): Promise<string> {
  return checkPortWithTimeout(1500);
}

function checkPortWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${PORT}/health`,
      { timeout: timeoutMs },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve(res.statusCode === 200 ? "ok" : String(res.statusCode)));
        res.on("error", () => resolve("down"));
      },
    );
    req.on("error", () => resolve("down"));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  });
}

// ============================================================================
// 文件锁
// ============================================================================

interface LockPayload {
  pid: number;
  timestamp: number;
}

function writeLock(): boolean {
  const payload: LockPayload = { pid: process.pid, timestamp: Date.now() };
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(payload), { flag: "wx" });
    return true;
  } catch (e: any) {
    if (e.code === "EEXIST") return false;
    return false;
  }
}

function readLock(): LockPayload | null {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(raw) as LockPayload;
  } catch {
    return null;
  }
}

function deleteLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** 检查锁是否属于当前进程 */
function lockIsMine(): boolean {
  const payload = readLock();
  return payload !== null && payload.pid === process.pid;
}

/** 检查锁是否是僵尸锁（持有者进程已死 或 超时） */
function isStaleLock(payload: LockPayload): boolean {
  // 检查进程是否存活（信号 0 仅检测，不实际发送）
  try {
    process.kill(payload.pid, 0);
  } catch (e: any) {
    // ESRCH: 进程确实不存在 → 僵尸
    // EPERM: 进程存在但无权限检测 → 保守当作存活，依赖时间戳超时兜底
    if (e.code === "ESRCH") return true;
  }
  // 检查超时
  if (Date.now() - payload.timestamp > STALE_LOCK_MS) return true;
  return false;
}

/**
 * 抢占僵尸锁：原子移走旧锁后重建。
 * 用 renameSync 原子操作保证两个进程同时抢占时只有一方成功。
 * 如果竞争失败返回 false。
 */
function takeStaleLock(): boolean {
  const tmpName = LOCK_FILE + ".stale." + process.pid;
  try {
    fs.renameSync(LOCK_FILE, tmpName);
  } catch {
    return false; // 别人已抢占或锁已消失
  }
  // 原子移走成功，旧锁已不存在，现在创建新锁
  const ok = writeLock();
  try { fs.unlinkSync(tmpName); } catch { /* ignore */ }
  return ok;
}

// ============================================================================
// 启动
// ============================================================================

/**
 * 启动 embed server 进程。
 * stderr 输出到固定的临时日志文件以便排查。
 * 使用 detached + unref 避免阻塞 pi 进程退出。
 * 返回日志文件路径。
 */
function startServer(): string {
  const logFile = path.join(os.tmpdir(), "pi-embed-server.log");
  // 启动前清理旧日志（保留 7 天前的不管）
  try {
    const stat = fs.statSync(logFile);
    if (Date.now() - stat.mtimeMs > 7 * 86400000) {
      fs.writeFileSync(logFile, ""); // 清空
    }
  } catch { /* 文件不存在 */ }

  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  logStream.write(`\n--- Started at ${new Date().toISOString()} (PID ${process.pid}) ---\n`);

  const child = spawn(PYTHON, [SCRIPT], {
    cwd: SCRIPT_DIR,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    windowsHide: true,
  });

  child.stderr?.pipe(logStream);
  child.on("close", (code) => {
    logStream.write(`--- Exited code ${code} at ${new Date().toISOString()} ---\n`);
    logStream.end();
  });
  child.unref();
  return logFile;
}

// ============================================================================
// 核心逻辑：带互斥的启动
// ============================================================================

/**
 * 尝试启动 embed server（带跨进程互斥）。
 *
 * 流程：
 *   1. 检查端口 → 在线则返回
 *   2. 尝试获取文件锁
 *   3. 拿锁 → 再次查端口 → 在线则删锁返回，离线则启动 → 轮询 → 删锁
 *   4. 没拿锁 → 检查是否僵尸锁 → 是则抢占并走步骤3
 *   5. 否则轮询等待，每 N 次查一次锁状态，发现僵尸/消失则重新竞争
 */
async function ensureServerRunning(notify?: (msg: string) => void): Promise<void> {
  // 1. 端口已在线？直接返回
  if (await checkPort() === "ok") {
    notify?.("✅ BGE-M3 已在运行 (127.0.0.1:5100)");
    return;
  }

  // 2. 尝试获取锁
  const gotLock = writeLock();
  let logFile = "";

  if (gotLock) {
    // 拿到锁 — 负责启动
    if (await checkPort() === "ok") {
      deleteLock();
      notify?.("✅ BGE-M3 已在运行 (由其他窗口启动)");
      return;
    }

    notify?.("⏳ 正在启动 BGE-M3 服务...");
    logFile = startServer();

    // 轮询等待端口上线
    const deadline = Date.now() + MAX_WAIT;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      if (await checkPortQuick() === "ok") {
        deleteLock();
        notify?.("✅ BGE-M3 服务已启动 (127.0.0.1:5100)");
        return;
      }
    }

    deleteLock();
    notify?.(`❌ BGE-M3 启动超时（45s），日志: ${logFile}`);
    return;
  }

  // 3. 没拿到锁 — 检查是否僵尸锁
  const payload = readLock();
  if (payload && isStaleLock(payload)) {
    if (!takeStaleLock()) {
      // 抢占失败，回退等待
      await waitForPort(notify);
      return;
    }

    if (await checkPort() === "ok") {
      deleteLock();
      notify?.("✅ BGE-M3 已在运行");
      return;
    }

    notify?.("⏳ 检测到僵尸锁，重新启动 BGE-M3 服务...");
    logFile = startServer();

    const deadline = Date.now() + MAX_WAIT;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      if (await checkPortQuick() === "ok") {
        deleteLock();
        notify?.("✅ BGE-M3 服务已启动");
        return;
      }
    }

    deleteLock();
    notify?.(`❌ BGE-M3 启动超时，日志: ${logFile}`);
    return;
  }

  // 4. 正常竞争：等待拿锁的进程启动完成（定期重检锁状态）
  await waitForPort(notify);
}

/**
 * 等待端口上线，同时每 N 次轮询检查一次锁状态。
 * 若锁变僵尸或消失，退出等待让调用方重新竞争。
 */
async function waitForPort(notify?: (msg: string) => void): Promise<void> {
  notify?.("⏳ BGE-M3 正在由其他窗口启动，等待中...");
  const deadline = Date.now() + MAX_WAIT;
  let tick = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    if (await checkPortQuick() === "ok") {
      notify?.("✅ BGE-M3 服务已就绪");
      return;
    }
    tick++;
    if (tick % LOCK_CHECK_EVERY === 0) {
      // 定期检查锁：僵尸/消失 → 退出等待，让外层重新竞争
      const p = readLock();
      if (!p) return;                    // 锁消失
      if (isStaleLock(p)) return;        // 锁变僵尸
    }
  }

  notify?.("❌ BGE-M3 启动超时（45s），请手动执行 /embed-start");
}

// ============================================================================
// 停止服务
// ============================================================================

function stopServer(): Promise<string> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-Command",
      `$c = Get-NetTCPConnection -LocalPort ${PORT} -EA SilentlyContinue | Select -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }; 'done'`,
    ]);
    let out = "";
    ps.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    ps.on("close", () => {
      // 只清理自己的锁，不误删其他窗口的
      if (lockIsMine()) {
        deleteLock();
      }
      resolve("已关闭");
    });
    ps.on("error", () => resolve("关闭失败"));
  });
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 进程退出时清理自己的锁文件（best-effort）
  const cleanup = () => {
    if (lockIsMine()) {
      deleteLock();
    }
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  // 命令：状态查询
  pi.registerCommand("embed-status", {
    description: "检查 BGE-M3 embedding 服务状态",
    handler: async (_args, ctx) => {
      const status = await checkPort();
      const msg = status === "ok"
        ? "✅ BGE-M3 运行中 (127.0.0.1:5100)"
        : `❌ BGE-M3 未启动 (${status})`;
      ctx.ui.notify(msg);
    },
  });

  // 命令：启动
  pi.registerCommand("embed-start", {
    description: "启动 BGE-M3 embedding 服务",
    handler: async (_args, ctx) => {
      await ensureServerRunning((msg) => ctx.ui.notify(msg));
    },
  });

  // 命令：停止
  pi.registerCommand("embed-stop", {
    description: "关闭 BGE-M3 embedding 服务",
    handler: async (_args, ctx) => {
      const status = await checkPort();
      if (status !== "ok") {
        ctx.ui.notify("BGE-M3 未在运行");
        return;
      }
      const result = await stopServer();
      ctx.ui.notify(result);
    },
  });


}
