/**
 * Windows 通知扩展 (windows-notify)
 *
 * 注册 windows_notify 工具，AI 在需要用户确认/回答时主动调用，
 * 通过 Windows 系统通知（NotifyIcon 气球提示）向用户发送通知。
 *
 * 通知包含：会话名、进行中的任务、阶段、问题。
 * 使用 System.Windows.Forms.NotifyIcon 实现，无需额外依赖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "windows_notify",
    label: "Windows 通知确认",
    description:
      "当需要用户确认某个决策、回答问题、或需要用户介入时，" +
      "通过 Windows 系统通知向用户发送通知。通知包含会话信息、任务进展和需要确认的问题。\n\n" +
      "**何时使用：**\n" +
      "- 需要用户对某个方案/决策进行确认时\n" +
      "- 需要用户回答关键问题才能继续时\n" +
      "- 长时间任务完成，等待用户审查结果时\n" +
      "- 发现了需要用户注意的重要事项时\n\n" +
      "调用后用户会在 Windows 通知区域看到弹出提示，AI 应等待用户回到对话中给出回应。",
    parameters: Type.Object({
      session_name: Type.String({
        description: "当前会话的名称，用于标识哪个会话发出的通知",
      }),
      task: Type.String({
        description: "当前正在进行的任务简述（一句话）",
      }),
      phase: Type.String({
        description: "当前任务所处的阶段，如：方案设计、代码编写、测试验证、等待部署",
      }),
      question: Type.String({
        description: "需要向用户询问的具体问题或需要确认的事项",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { session_name, task, phase, question } = params;

      // 构建 PowerShell 通知脚本
      // 使用 NotifyIcon 气球提示 — Windows 原生，无需额外依赖
      const psScript = buildPowerShellScript(session_name, task, phase, question);

      // 后台启动 PowerShell 进程发送通知（fire-and-forget）
      // 使用 spawn 以非阻塞方式运行，不等待进程结束
      try {
        const child = spawn("powershell", [
          "-NoProfile",
          "-STA",
          "-NonInteractive",
          "-Command",
          psScript,
        ], {
          windowsHide: true,
          stdio: "ignore",
        });

        child.on("error", (err) => {
          if (ctx?.ui) {
            ctx.ui.notify(`通知发送失败: ${err.message}`, "warning");
          }
        });

        // 不等待 child 结束，立即返回
        child.unref();
      } catch (e: any) {
        // 静默处理 — 通知是辅助功能，不应阻塞主流程
        if (ctx?.ui && e?.message) {
          ctx.ui.notify(`通知发送失败: ${e.message}`, "warning");
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `🔔 **Windows 通知已发送**\n`,
              `| 项目 | 内容 |`,
              `|------|------|`,
              `| 会话 | ${session_name} |`,
              `| 任务 | ${task} |`,
              `| 阶段 | ${phase} |`,
              `| 问题 | ${question} |`,
              ``,
              `⏳ 请查看 Windows 通知区域（系统托盘），确认后回到对话中回应。`,
            ].join("\n"),
          },
        ],
      };
    },
  });
}

/**
 * 构建 PowerShell 通知脚本。
 *
 * 使用 System.Windows.Forms.NotifyIcon 的气球提示（BalloonTip），
 * 在系统托盘区域弹出，兼容 Windows 10/11。
 * 进程保持活跃约 16 秒以确保通知完全显示。
 */
function buildPowerShellScript(
  session: string,
  task: string,
  phase: string,
  question: string,
): string {
  // PowerShell 字符串转义：` → ``、$ → `$、" → `"
  const esc = (s: string) =>
    s
      .replace(/`/g, "``")
      .replace(/\$/g, "`$")
      .replace(/"/g, '`"')
      .replace(/\r?\n/g, "`n");

  const title = esc("pi — 需要确认");
  const body = esc(
    [
      `会话: ${session}`,
      `任务: ${task}`,
      `阶段: ${phase}`,
      ``,
      `问题: ${question}`,
    ].join("\n"),
  );

  // 通知显示时长（毫秒），随后进程退出
  const displayMs = 15000;

  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.BalloonTipTitle = "${title}"
$notify.BalloonTipText = "${body}"
$notify.ShowBalloonTip(${displayMs})

$end = [DateTime]::Now.AddMilliseconds(${displayMs + 1000})
while ([DateTime]::Now -lt $end) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 250
}
$notify.Dispose()
`.trim();
}
