/**
 * Async Tasks Extension — 后台命令 + 自动注入结果 + 实时输出查看
 *
 *   async_run  — spawn 后台命令，立即返回 task_id，完成后自动注入结果
 *   async_list — 列出全部任务（运行中 / 已完成）
 *   async_peek — 查看运行中任务的实时 stdout/stderr
 *
 * 所有命令均以非阻塞方式运行。Windows 走 powershell.exe。Task 状态存储在内存 Map 中。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";

interface TaskInfo {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "done" | "failed" | "killed";
  child?: ChildProcess;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  createdAt: number;
  finishedAt: number | null;
}

const tasks = new Map<string, TaskInfo>();
let taskSeq = 0;

export default function (pi: ExtensionAPI) {

  // ── session_shutdown：kill 所有运行中的后台进程并注入已中断结果 ──
  pi.on("session_shutdown", () => {
    for (const [, task] of tasks) {
      if (task.status === "running" && task.child) {
        task.child.kill();
        task.status = "killed";
        task.exitCode = -1;
        task.finishedAt = Date.now();
        injectResult(pi, task);
      }
    }
  });

  // ── async_run 工具 ──
  pi.registerTool({
    name: "async_run",
    label: "Async Run",
    description:
      "Run a shell command. Returns immediately with a task_id; results are auto-injected when done. On Windows runs in powershell.exe, use Windows paths (D:\\path\\to\\file) and ; for chaining.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run (Windows: powershell with ;, Unix: bash)" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: project root)" })),
      wait: Type.Optional(Type.Boolean({ description: "If true, block and return live stdout/stderr with progress every ~2s (default: false). Timeout after 120s." })),
    }),

    // ── execute ──
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workDir = params.cwd || ctx.cwd;
      const startTime = Date.now();
      const taskId = `task_${Date.now().toString(36)}_${++taskSeq}`;
      const task: TaskInfo = {
        id: taskId,
        command: params.command,
        cwd: workDir,
        status: "running",
        exitCode: null,
        stdout: "",
        stderr: "",
        createdAt: startTime,
        finishedAt: null,
      };
      tasks.set(taskId, task);

      const isWindows = process.platform === "win32";
      const child = isWindows
        ? spawn("powershell.exe", ["-NoProfile", "-Command", params.command], {
            cwd: workDir,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn(params.command, {
            cwd: workDir,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
          });

      task.child = child;

      child.stdout.on("data", (data: Buffer) => {
        task.stdout += data.toString();
        if (task.stdout.length > 1_000_000) task.stdout = task.stdout.slice(-1_000_000);
      });
      child.stderr.on("data", (data: Buffer) => {
        task.stderr += data.toString();
        if (task.stderr.length > 1_000_000) task.stderr = task.stderr.slice(-1_000_000);
      });

      // ── wait 模式：阻塞等待，实时输出，可打断 ──
      if (params.wait) {
        const timeoutMs = 2 * 60 * 1000;
        const pollMs = 2000;
        let lastLen = 0;
        const startTime = Date.now();

        const pollProgress = () => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const t = tasks.get(taskId);
          if (!t) return;
          const newStdout = t.stdout.slice(lastLen);
          lastLen = t.stdout.length;
          let progress = `⏳ 运行中 (${elapsed}s)\n--- stdout ---\n${newStdout.slice(-3000)}`;
          if (t.stderr) progress += `\n--- stderr ---\n${t.stderr.slice(-2000)}`;
          try { onUpdate?.({ content: [{ type: "text", text: progress }] }); } catch { /* ignore */ }
        };

        const interval = setInterval(pollProgress, pollMs);

        return new Promise<{ content: { type: string; text: string }[] }>((resolve) => {
          const finish = () => {
            clearInterval(interval);
            const t = tasks.get(taskId);
            if (!t) return resolve({ content: [{ type: "text", text: `❓ 任务 ${taskId} 丢失` }] });
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const statusLabel = t.status === "done" ? "✅ 完成" : "❌ 失败";
            let text = `${statusLabel} | 耗时: ${elapsed}s | 退出码: ${t.exitCode}\n命令: ${t.command}`;
            if (t.stdout) text += `\n\n--- stdout ---\n${t.stdout.slice(-6000)}`;
            if (t.stderr) text += `\n\n--- stderr ---\n${t.stderr.slice(-4000)}`;
            resolve({ content: [{ type: "text", text }] });
          };

          // 可打断：接收用户中断信号
          const abortHandler = () => {
            clearInterval(interval);
            child.kill("SIGTERM");
            const t = tasks.get(taskId);
            const text = t
              ? `⛔ 已中断\ntask_id: ${taskId}\n--- stdout ---\n${t.stdout.slice(-4000)}`
              : `⛔ 已中断`;
            resolve({ content: [{ type: "text", text }] });
          };
          if (signal) {
            signal.addEventListener("abort", abortHandler, { once: true });
          }

          // 子进程退出
          child.on("close", (code) => {
            if (signal) signal.removeEventListener("abort", abortHandler);
            clearInterval(interval);
            const t = tasks.get(taskId);
            if (t) {
              t.status = code === 0 ? "done" : "failed";
              t.exitCode = code ?? 1;
              t.finishedAt = Date.now();
              injectResult(pi, t);
            }
            setTimeout(finish, 500);
          });

          // 超时转为后台
          setTimeout(() => {
            if (!child.exitCode && !child.killed) return; // 还在跑
            clearInterval(interval);
            const t = tasks.get(taskId);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            resolve({
              content: [{
                type: "text",
                text: `⏳ 超时 (${elapsed}s)，已转为后台任务\ntask_id: ${taskId}\n\n--- stdout ---\n${t?.stdout.slice(-4000) ?? ""}`,
              }],
            });
          }, timeoutMs);
        });
      }

      // ── 非 wait 模式：后台运行 ──
      let settled = false;

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        const t = tasks.get(taskId);
        if (t) {
          t.status = "failed";
          t.exitCode = 1;
          t.stderr = (t.stderr ? t.stderr + "\n" : "") + `[spawn error] ${err.message}`;
          t.finishedAt = Date.now();
          injectResult(pi, t);
        }
      };

      child.on("error", onError);

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        const t = tasks.get(taskId);
        if (!t) return;
        t.status = code === 0 ? "done" : "failed";
        t.exitCode = code ?? 1;
        t.finishedAt = Date.now();
        injectResult(pi, t);
      });

      return { content: [{ type: "text", text: `✅ 后台任务已启动: ${taskId}\n命令: ${params.command}` }] };
    },
  });

  // ── async_list 工具 ──
  pi.registerTool({
    name: "async_list",
    label: "Async List",
    description: "List all background tasks (running and completed).",
    parameters: Type.Object({}),
    async execute() {
      if (!tasks.size) return { content: [{ type: "text", text: "无后台任务" }] };

      const all = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
      const icons: Record<string, string> = { running: "⏳", done: "✅", failed: "❌", killed: "⛔" };
      const lines = all.map(t =>
        `${icons[t.status] || "❓"} ${t.id}  [${t.status}]  ${t.command.slice(0, 60)}`
      );

      return { content: [{ type: "text", text: lines.join("\n") }], details: { tasks: all.map(({ child: _, ...rest }) => rest) } };
    },
  });

  // ── async_peek 工具 ──
  pi.registerTool({
    name: "async_peek",
    label: "Async Peek",
    description:
      "Peek at the live stdout/stderr of a running or completed background task. Returns the last N characters.\n\nUsage: Use peek once to check progress, then STOP. Do NOT loop peek calls.\nInstead, use windows_notify to alert the user and request their next action while waiting.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID returned by async_run" }),
      tail: Type.Optional(Type.Number({ description: "Return last N characters (default: 2000, max: 8000)" })),
    }),
    async execute(_toolCallId, params) {
      const task = tasks.get(params.task_id);
      if (!task) {
        return { content: [{ type: "text", text: `任务 ${params.task_id} 不存在或已被清理（30 分钟后自动清理）。` }] };
      }

      const tail = Math.min(params.tail ?? 2000, 8000);
      const elapsed = ((Date.now() - task.createdAt) / 1000).toFixed(1);
      const icons: Record<string, string> = { running: "⏳", done: "✅", failed: "❌", killed: "⛔" };
      const icon = icons[task.status] || "❓";

      let content = `${icon} ${task.id}  [${task.status}]  运行 ${elapsed}s | ${task.command.slice(0, 80)}`;

      if (task.stdout) {
        content += `\n\n--- stdout (最近 ${tail} 字符) ---\n${task.stdout.slice(-tail)}`;
      } else {
        content += `\n(尚无 stdout 输出)`;
      }

      if (task.stderr) {
        content += `\n\n--- stderr (最近 ${tail} 字符) ---\n${task.stderr.slice(-tail)}`;
      }

      if (task.status !== "running") {
        content += `\n\n退出码: ${task.exitCode}`;
      }

      return { content: [{ type: "text", text: content }] };
    },
  });
}

function injectResult(pi: ExtensionAPI, task: TaskInfo) {
  const icons: Record<string, string> = { done: "✅", failed: "❌", killed: "⛔" };
  const labels: Record<string, string> = { done: "完成", failed: "失败", killed: "已中断" };
  const icon = icons[task.status] || "❓";
  const label = labels[task.status] || task.status;
  const elapsed = ((task.finishedAt! - task.createdAt) / 1000).toFixed(1);
  let content = `[后台任务${label} ${task.id}]\n${icon} 状态: ${label} | 耗时: ${elapsed}s | 退出码: ${task.exitCode}\n命令: ${task.command}`;

  if (task.stdout) content += `\n\n--- stdout ---\n${task.stdout.slice(-4000)}`;
  if (task.stderr) content += `\n\n--- stderr ---\n${task.stderr.slice(-4000)}`;

  try {
    pi.sendMessage(
      { customType: "async_task_result", content, display: true },
      { triggerTurn: true },
    );
  } catch {
    // 扩展已失效（reload/session 切换），静默忽略
  }

  // 30 分钟后清理，避免内存泄漏
  setTimeout(() => tasks.delete(task.id), 30 * 60 * 1000);
}
