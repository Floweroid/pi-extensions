/**
 * PowerShell Tool Extension
 *
 * 直接在 Windows 宿主机上执行 PowerShell 命令。
 * 通过 Node.js child_process.spawn 调用 powershell.exe，
 * 避免 bash 桥接带来的引号转义和编码问题。
 *
 * 参考 pi 内置 bash 工具的进程管理方式：
 * - spawn 流式输出
 * - taskkill /F /T 杀整个进程树（超时 + 中断）
 * - 追踪子 PID 以便 shutdown 时清理
 * - 通过 _onUpdate 实时推送增量输出
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

/** 追踪已启动的子进程 PID，shutdown 时清理 */
const trackedPids = new Set<number>();

/** 杀死进程树（跨平台，Windows 用 taskkill /F /T） */
function killProcessTree(pid: number) {
  try {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // 忽略错误（进程可能已结束）
  }
}

export default function (pi: ExtensionAPI) {
  // shutdown 时清理所有追踪的子进程
  pi.on("shutdown", () => {
    for (const pid of trackedPids) {
      killProcessTree(pid);
    }
    trackedPids.clear();
  });

  pi.registerTool({
    name: "powershell",
    label: "PowerShell",
    description:
      "在 Windows 宿主机上执行 PowerShell 命令。直接调用 powershell.exe，无需 bash 桥接。\n" +
      "支持任意 PowerShell 命令、cmdlet、管道等。\n" +
      "返回 stdout 和 stderr（UTF-8 解码）。\n" +
      "超时或中断时会通过 taskkill /F /T 杀死整个进程树。\n" +
      "通过 _onUpdate 实时推送增量输出，无需等待命令完成。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 PowerShell 命令" }),
      timeout: Type.Optional(
        Type.Number({ description: "超时秒数（默认 30，最大 300）" })
      ),
      cwd: Type.Optional(
        Type.String({ description: "工作目录（默认项目根目录）" })
      ),
    }),
    promptGuidelines: [
      "在 Windows 宿主机上执行 PowerShell 命令时用此工具，而非通过 bash 桥接。",
      "例如：查询进程、管理服务、操作注册表、调用 COM 对象、执行 WMI 查询等。",
    ],
    async execute(
      _toolCallId: string,
      params: { command: string; timeout?: number; cwd?: string },
      signal: AbortSignal,
      _onUpdate: any,
      ctx: { cwd: string }
    ) {
      const timeoutSec = Math.min(params.timeout ?? 30, 300);
      const workDir = params.cwd || ctx.cwd;

      return new Promise((resolve) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            // 强制 UTF-8 输出，避免 UTF-16LE 被误解导致乱码和字符截断
            // [Console]::OutputEncoding 控制 stdout/stderr 编码
            // $OutputEncoding 控制管道符 | 输出的编码（解决 stdin 传参问题）
            // chcp 65001 设置控制台代码页为 UTF-8
            `chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ${params.command}`,
          ],
          {
            cwd: workDir,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }
        );

        let timedOut = false;
        let aborted = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let output = "";
        let errorOutput = "";
        let mergedOutput = "";

        // 节流：上次 _onUpdate 推送时间
        let lastUpdate = 0;
        const THROTTLE_MS = 100;

        const pushUpdate = () => {
          if (!_onUpdate) return;
          const now = Date.now();
          if (now - lastUpdate >= THROTTLE_MS) {
            lastUpdate = now;
            _onUpdate({
              content: [{ type: "text", text: `PS> ${params.command}\n\n${mergedOutput.slice(-8000)}` }],
            });
          }
        };

        // 杀死整个进程树的回调（用于超时和中断）
        const onAbort = () => {
          if (child.pid) {
            trackedPids.delete(child.pid);
            killProcessTree(child.pid);
          }
        };

        // 超时处理
        if (timeoutSec > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            onAbort();
          }, timeoutSec * 1000);
        }

        // 中断信号处理
        if (signal) {
          if (signal.aborted) {
            aborted = true;
            onAbort();
          } else {
            signal.addEventListener("abort", () => {
              aborted = true;
              onAbort();
            }, { once: true });
          }
        }

        // 追踪子 PID
        if (child.pid) {
          trackedPids.add(child.pid);
        }

        // 流式收集 stdout
        child.stdout?.on("data", (data: Buffer) => {
          const text = data.toString("utf-8");
          output += text;
          mergedOutput += text;
          pushUpdate();
        });

        // 流式收集 stderr（Podman 进度走 stderr，视作正常输出）
        child.stderr?.on("data", (data: Buffer) => {
          const text = data.toString("utf-8");
          errorOutput += text;
          mergedOutput += text;
          pushUpdate();
        });

        // 进程关闭（正常结束或被 kill）
        child.on("close", (exitCode) => {
          if (child.pid) trackedPids.delete(child.pid);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          // 拼接输出（合并 stdout+stderr，统一截断）
          let content = `PS> ${params.command}\n\n`;
          
          if (mergedOutput) {
            content += mergedOutput.slice(-32000);
          } else {
            if (output) content += output.slice(-8000);
            if (errorOutput) content += `\n\n--- stderr ---\n${errorOutput.slice(-8000)}`;
          }

          if (timedOut) {
            content += `\n\n⏱️ 命令超时 (${timeoutSec}s)`;
            resolve({
              content: [{ type: "text", text: content }],
              details: { exitCode: 124 },
            });
            return;
          }

          if (aborted) {
            content += `\n\n🛑 命令已被中断`;
            resolve({
              content: [{ type: "text", text: content }],
              details: { exitCode: 130 },
            });
            return;
          }

          if (exitCode !== 0 && exitCode !== null) {
            content += `\n\n❌ 退出码: ${exitCode}`;
          }

          resolve({
            content: [{ type: "text", text: content || "(无输出)" }],
            details: { exitCode: exitCode ?? 1 },
          });
        });

        // spawn 失败（如 powershell.exe 不存在）
        child.on("error", (err: NodeJS.ErrnoException) => {
          if (child.pid) trackedPids.delete(child.pid);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          resolve({
            content: [
              {
                type: "text",
                text: `PS> ${params.command}\n\n❌ 错误: ${err.message}`,
              },
            ],
            details: { exitCode: (err as any).code || 1 },
          });
        });
      });
    },
  });
}
