/**
 * Permission Gate Extension
 *
 * 三种模式切换：
 *   yolo   — 全部放行
 *   warn   — 仅拦截危险指令（默认）
 *   strict — 所有修改类工具都需确认
 *
 * 命令：/perm-mode <yolo|warn|strict>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type GateMode = "yolo" | "warn" | "strict";

// ── Dangerous command patterns ──
const dangerousCommandPatterns = [
  /\brm\s+(-rf?|--recursive)/i,
  /\b(rmdir|rd)\s+\/s\b/i,
  /\bdel\s+\/f\s+\/s\b/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
  /Remove-Item\s+.*-Recurse/i,
  /Stop-Process\s+.*-Force/i,
  /\bdel\s+\/f\b/i,
  /\bformat\b/i,
  /\bdrop\s+database\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/,
  /\bgit\s+push\s+--force\b/i,
  /\bdocker\s+rm\b/i,
  /\bkubectl\s+delete\b/i,
  // ── WSL / Linux ──
  /\bwsl\s+--unregister\b/i,
  /\bwsl\s+--terminate\b/i,
  /\bwsl\s+--shutdown\b/i,
  /\bwsl\s+--set-version\b/i,
  /\bwsl\.exe\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bchroot\b/i,
  />\s*\/dev\/sd/i,
  /\b(mount|umount)\b.*\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  /\bshutdown\s+-/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\biptables\s+-F\b/i,
  /\bkill\s+-9\s+-1\b/i,
  // ── curl 管道执行 ──
  /curl\s+.*\|\s*(ba)?sh\b/i,
  /curl\s+.*\|\s*sudo\s+(ba)?sh\b/i,
];

// ── Sensitive file paths ──
const sensitivePathPatterns = [
  /\.env$/i,
  /\.env\./i,
  /\/etc\//,
  /C:\\Windows\\/i,
  /\/boot\//,
  /\.ssh\//,
  /\.gnupg\//,
  /id_rsa/i,
  /\/root\//,
  /\.git\/config$/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
];

// ── 可修改的工具 ──
const MUTATING_TOOLS = new Set(["bash", "powershell", "async_run", "write", "edit", "subagent"]);

// ── 模式 UI 映射 ──
const MODE_LABELS: Record<GateMode, string> = {
  yolo: "工具权限: 😎 YOLO",
  warn: "工具权限: 😐 限制",
  strict: "工具权限: 🤔 询问",
};

function isDangerous(toolName: string, detail: string): string | null {
  if (toolName === "write" || toolName === "edit") {
    for (const p of sensitivePathPatterns) {
      if (p.test(detail)) return `敏感路径: ${detail}`;
    }
    return null;
  }
  // bash / powershell / async_run
  for (const p of dangerousCommandPatterns) {
    if (p.test(detail)) return `危险指令: ${detail.slice(0, 80)}`;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  let mode: GateMode = "warn";

  function updateStatus(ctx?: any) {
    if (ctx?.ui?.setStatus) {
      ctx.ui.setStatus("perm-gate", MODE_LABELS[mode]);
    }
  }

  // ── 恢复上次模式 ──
  pi.on("session_start", async (_event, ctx) => {
    let found = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "perm-mode") {
        mode = (entry.data as any)?.mode ?? "warn";
        found = true;
        break;
      }
    }
    updateStatus(ctx);
  });

  // ── /perm-mode 命令 ──
  pi.registerCommand("perm-mode", {
    description: `切换权限门模式：yolo / warn / strict（当前: ${mode}）`,
    async handler(args, ctx) {
      const input = args?.trim().toLowerCase();
      const validModes: GateMode[] = ["yolo", "warn", "strict"];

      if (!input || !validModes.includes(input as GateMode)) {
        ctx.ui.notify(
          `用法: /perm-mode <yolo|warn|strict>\n当前: ${MODE_LABELS[mode]}`,
          "info",
        );
        return;
      }

      mode = input as GateMode;
      pi.appendEntry("perm-mode", { mode });
      updateStatus(ctx);

      const descriptions: Record<GateMode, string> = {
        yolo: "全部放行，不拦截任何工具",
        warn: "仅拦截匹配危险规则的指令",
        strict: "所有修改类工具都需确认",
      };

      ctx.ui.notify(
        `${MODE_LABELS[mode]}\n${descriptions[mode]}`,
        "info",
      );
    },
  });

  // ── 初始状态栏（由 session_start 负责） ──

  // ── 工具拦截 ──
  pi.on("tool_call", async (event, ctx) => {
    // yolo 模式全部放行
    if (mode === "yolo") return undefined;

    const { toolName, input } = event;

    // 不关心只读工具
    if (!MUTATING_TOOLS.has(toolName)) return undefined;

    let detail = "";
    if (toolName === "write" || toolName === "edit") {
      detail = (input as any)?.path ?? "";
    } else {
      detail = (input as any)?.command ?? "";
    }

    // subagent: build task summary for display
    if (toolName === "subagent") {
      const tasks = (input as any)?.chain ?? (input as any)?.tasks ??
        ((input as any)?.agent ? [{ agent: (input as any).agent, task: (input as any).task }] : []);
      detail = (tasks as any[]).map((t: any) => `${t.agent}: ${(t.task || "").slice(0, 50)}`).join("\n");
    }

    // warn 模式：仅危险指令弹窗
    if (mode === "warn") {
      const reason = toolName === "subagent" ? "subagent" : isDangerous(toolName, detail);
      if (!reason) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: `用户拒绝工具调用，原因: 无交互 UI（${reason}）` };
      }

      const choice = await ctx.ui.select(
        `⚠️ 危险指令 — ${reason}`,
        ["允许", "阻止", "阻止并说明原因"],
      );

      if (choice === "阻止") {
        return { block: true, reason: `用户拒绝工具调用，原因: ${reason}` };
      }

      if (choice === "阻止并说明原因") {
        const msg = await ctx.ui.input(
          `阻止原因（可选） — ${reason}`,
          "",
        );
        return { block: true, reason: `用户拒绝工具调用，原因: ${msg?.trim() || reason}` };
      }

      if (choice !== "允许") {
        return { block: true, reason: `用户拒绝工具调用，原因: ${reason}` };
      }

      return undefined;
    }

    // strict 模式：所有修改类工具都弹窗
    if (mode === "strict") {
      if (!ctx.hasUI) {
        return { block: true, reason: `用户拒绝工具调用，原因: 无交互 UI（询问模式）` };
      }

      const label = detail.slice(0, 100) || toolName;

      const choice = await ctx.ui.select(
        `⚙️ 询问 — ${toolName}: ${label}`,
        ["允许", "阻止", "阻止并说明原因"],
      );

      if (choice === "阻止") {
        return { block: true, reason: `用户拒绝工具调用，原因: 询问模式（${toolName}）` };
      }

      if (choice === "阻止并说明原因") {
        const msg = await ctx.ui.input(
          `阻止原因（可选） — ${toolName}`,
          "",
        );
        return { block: true, reason: `用户拒绝工具调用，原因: ${msg?.trim() || `询问模式（${toolName}）`}` };
      }

      if (choice !== "允许") {
        return { block: true, reason: `用户拒绝工具调用，原因: 询问模式（${toolName}）` };
      }

      return undefined;
    }

    return undefined;
  });
}
