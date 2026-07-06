/**
 * 自动命名扩展 (auto-name)
 *
 * 每 5 轮对话自动更新 session 名称。
 * 格式：[状态]主体:阶段进展[HH:MM:SS YYYY-MM-DD]
 *
 * 手动触发：/auto-name
 *
 * 状态由 AI 从四个标签选择：进行中 / 已完成 / 暂停 / 闲置。
 * 使用 deepseek-chat（便宜模型），不可用时回退 deepseek-v4-pro。
 * 更新后同步到 WT 标签名。
 * 记录并展示 token 消耗。
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// ============================================================================
// 配置
// ============================================================================

/** 每 N 轮对话触发一次自动更新 */
const NAME_UPDATE_INTERVAL = 5;

/** 提取多少条最近的消息用于生成名称 */
const RECENT_MESSAGE_COUNT = 8;

// ============================================================================
// 状态标签（AI 只能从中选择）
// ============================================================================

const STATUS_LABELS = ["进行中", "已完成", "暂停", "闲置"] as const;

// ============================================================================
// 提示词
// ============================================================================

const NAME_SYSTEM_PROMPT = `你是一个编程会话状态跟踪助手。根据对话内容，为当前会话生成结构化名称。

请严格按以下格式输出（一行，不要换行）：
状态|标题|进展

规则：
- 状态：从 [进行中, 已完成, 暂停, 闲置] 中选一个
  · 进行中 = 任务正在推进
  · 已完成 = 目标已达成
  · 暂停 = 等待外部条件、用户响应，暂时搁置
  · 闲置 = 长时间无实质进展，可能被放弃
- 标题：会话的核心主题，5-12 字，纯中文
- 进展：当前最新阶段或正在做的事，5-10 字，纯中文
- 只输出一行原始文本，不要加引号、句号或任何修饰`;

const NAME_USER_PROMPT = `以下是一段编程对话。请输出当前会话状态：

<conversation>
{conversation}
</conversation>

状态|标题|进展：`;

/** 当状态已手动指定时，AI 只需输出标题和进展 */
const NAME_USER_PROMPT_FORCED = `以下是一段编程对话。已知会话状态为「{status}」，请生成标题和进展：

<conversation>
{conversation}
</conversation>

标题|进展：`;

// ============================================================================
// 类型
// ============================================================================

interface Message {
  role: "user" | "assistant";
  text: string;
}

interface NamingStats {
  consecutiveFails: number;
  accumulatedTokens: number;
  accumulatedCost: number;
  generationCount: number;
}

// ============================================================================
// 辅助函数
// ============================================================================

function extractRecentMessages(entries: SessionEntry[], count: number): Message[] {
  const messages: Message[] = [];

  for (let i = entries.length - 1; i >= 0 && messages.length < count; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;

    const msg = entry.message as { role?: string; content?: unknown };
    if (!msg || !msg.role) continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const content = msg.content;
    let text = "";

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join(" ");
    }

    if (!text.trim()) continue;

    messages.unshift({
      role: msg.role as "user" | "assistant",
      text: text.trim(),
    });
  }

  return messages;
}

function formatMessagesForPrompt(messages: Message[]): string {
  return messages
    .map((m) => {
      const label = m.role === "user" ? "用户" : "助手";
      const truncated = m.text.length > 300 ? m.text.slice(0, 300) + "…" : m.text;
      return `[${label}]: ${truncated}`;
    })
    .join("\n\n");
}

function nowTimestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${hh}:${mm}:${ss} ${yyyy}-${MM}-${dd}`;
}

function parseAiOutput(raw: string): { status: string; title: string; progress: string } | null {
  const parts = raw.split("|");
  if (parts.length < 3) return null;

  const status = parts[0].trim();
  const title = parts[1].trim();
  const progress = parts.slice(2).join("|").trim();

  if (!STATUS_LABELS.includes(status as typeof STATUS_LABELS[number])) return null;
  if (!title || !progress) return null;

  const clean = (s: string) =>
    s.replace(/["""'']/g, "").replace(/[。！？、；：]/g, "").trim();

  return {
    status,
    title: clean(title).slice(0, 39),
    progress: clean(progress).slice(0, 14),
  };
}

/** 解析强制指定状态时的 AI 输出 "标题|进展" */
function parseForcedOutput(raw: string, forcedStatus: string): { status: string; title: string; progress: string } | null {
  const parts = raw.split("|");
  if (parts.length < 2) return null;

  const title = parts[0].trim();
  const progress = parts.slice(1).join("|").trim();

  if (!title || !progress) return null;

  const clean = (s: string) =>
    s.replace(/["""'']/g, "").replace(/[。！？、；：]/g, "").trim();

  return {
    status: forcedStatus,
    title: clean(title).slice(0, 39),
    progress: clean(progress).slice(0, 14),
  };
}

function buildName(status: string, title: string, progress: string): string {
  return `[${status}]${title}:${progress}[${nowTimestamp()}]`;
}

function readWtTabTitle(): string {
  try {
    const output = execSync('powershell.exe -Command "[Console]::Title"', {
      encoding: "utf-8",
      timeout: 2000,
      windowsHide: true,
    });
    return output.trim();
  } catch {
    return "";
  }
}

function isDefaultTabTitle(title: string): boolean {
  const lower = title.toLowerCase();
  // 任何 .exe 结尾的都是进程路径，非用户自定义标签
  if (lower.endsWith(".exe")) return true;
  // 其他已知默认值
  const defaults = ["windows powershell"];
  return defaults.includes(lower) || /^[a-z]:\\windows\\.+\.exe$/.test(lower);
}

// ============================================================================
// AI 命名核心逻辑
// ============================================================================

async function runAiNaming(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stats: NamingStats,
  forcedStatus?: string,
  skipContentCheck?: boolean,
): Promise<boolean> {
  const entries = ctx.sessionManager.getEntries();
  const messages = extractRecentMessages(entries, RECENT_MESSAGE_COUNT);

  if (!skipContentCheck) {
    const hasUser = messages.some((m) => m.role === "user");
    const hasAssistant = messages.some((m) => m.role === "assistant");
    if (!hasUser || !hasAssistant) {
      ctx.ui.notify("自动命名：对话内容不足", "warning");
      return false;
    }
  }

  // 查找模型：deepseek-chat 优先
  let model = ctx.modelRegistry.find("deepseek", "deepseek-chat");
  if (!model) {
    model = ctx.modelRegistry.find("deepseek", "deepseek-v4-pro");
  }
  if (!model) {
    ctx.ui.notify("自动命名：无可用的 DeepSeek 模型", "error");
    return false;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify("自动命名：DeepSeek API key 不可用", "error");
    return false;
  }

  const oldName = pi.getSessionName();
  const conversationText = formatMessagesForPrompt(messages);
  const prompt = forcedStatus
    ? NAME_USER_PROMPT_FORCED
        .replace("{status}", forcedStatus)
        .replace("{conversation}", conversationText)
    : NAME_USER_PROMPT.replace("{conversation}", conversationText);

  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: NAME_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text" as const, text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 60, apiKey: auth.apiKey, headers: auth.headers },
    );

    if (response.stopReason === "error") {
      stats.consecutiveFails++;
      if (stats.consecutiveFails >= 3) {
        ctx.ui.notify(
          `自动命名连续失败 ${stats.consecutiveFails} 次: ${response.errorMessage || "未知错误"}`,
          "warning",
        );
      }
      return false;
    }

    // Token 统计
    const usage = response.usage;
    stats.accumulatedTokens += usage.totalTokens;
    stats.accumulatedCost += usage.cost?.total ?? 0;
    stats.generationCount++;

    const raw = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    const parsed = forcedStatus
      ? parseForcedOutput(raw, forcedStatus)
      : parseAiOutput(raw);
    if (!parsed) {
      stats.consecutiveFails++;
      if (stats.consecutiveFails >= 3) {
        ctx.ui.notify(
          `自动命名解析失败 ${stats.consecutiveFails} 次: "${raw.slice(0, 60)}"`,
          "warning",
        );
      }
      return false;
    }

    const name = buildName(parsed.status, parsed.title, parsed.progress);
    const changed = name !== oldName;

    pi.setSessionName(name);
    stats.consecutiveFails = 0;

    // WT 标签由 pi 自动同步（格式: pi - sessionName - cwd），无需手动 setTitle

    // 通知
    const tokenInfo = `本次${usage.totalTokens}t · 累计${stats.accumulatedTokens}t/${stats.generationCount}次`;
    const costInfo = stats.accumulatedCost > 0 ? ` · ¥${stats.accumulatedCost.toFixed(4)}` : "";

    if (changed) {
      ctx.ui.notify(`📝 ${name}  |  ${tokenInfo}${costInfo}`, "info");
    } else {
      ctx.ui.notify(`📝 (未变化)  |  ${tokenInfo}${costInfo}`, "info");
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.consecutiveFails++;
    if (stats.consecutiveFails >= 3) {
      ctx.ui.notify(`自动命名异常 ${stats.consecutiveFails} 次: ${message}`, "warning");
    }
    return false;
  }
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  let turnCount = 0;
  let lastWtTabTitle = "";
  const stats: NamingStats = {
    consecutiveFails: 0,
    accumulatedTokens: 0,
    accumulatedCost: 0,
    generationCount: 0,
  };

  // ============================
  // 注册手动命令 /auto-name
  // ============================
  pi.registerCommand("auto-name", {
    description: "手动触发 AI 生成并更新 session 名称",
    getArgumentCompletions(_prefix) {
      return [
        ...STATUS_LABELS.map((s) => ({ value: s, label: s })),
        { value: "to-session", label: "to-session (WT标签→会话名)" },
        { value: "to-tab", label: "to-tab (会话名→WT标签)" },
      ];
    },
    async handler(args, ctx) {
      await ctx.waitForIdle();
      const arg = args.trim();

      // /auto-name to-session — WT 标签 → session 名（不消耗 token）
      if (arg === "to-session") {
        const tabTitle = readWtTabTitle();
        if (!tabTitle || isDefaultTabTitle(tabTitle)) {
          ctx.ui.notify("WT 标签名为默认值，跳过同步", "warning");
        } else if (tabTitle === pi.getSessionName()) {
          ctx.ui.notify("WT 标签名与当前 session 名一致，无需同步", "info");
        } else {
          pi.setSessionName(tabTitle);
          lastWtTabTitle = tabTitle;
          ctx.ui.notify(`📝 已同步 WT 标签名 → session：${tabTitle}`, "info");
        }
        return;
      }

      // /auto-name to-tab — session 名 → WT 标签
      if (arg === "to-tab") {
        const currentName = pi.getSessionName();
        if (!currentName) {
          ctx.ui.notify("当前 session 名为空，无法同步", "warning");
          return;
        }
        // 格式与 pi 框架一致: pi - sessionName - cwd
        const cwd = process.cwd();
        process.title = `pi - ${currentName} - ${cwd}`;
        ctx.ui.notify(`📝 已同步 session 名 → WT 标签`, "info");
        return;
      }

      // /auto-name <状态> — 手动指定状态
      if (arg && STATUS_LABELS.includes(arg as typeof STATUS_LABELS[number])) {
        await runAiNaming(pi, ctx, stats, arg, true);
      } else if (arg) {
        ctx.ui.notify(`无效参数: ${arg}（可用: ${STATUS_LABELS.join("/")} / to-session / to-tab）`, "warning");
      } else {
        await runAiNaming(pi, ctx, stats, undefined, true);
      }
    },
  });

  // ============================
  // session 切换时重置
  // ============================
  pi.on("session_start", () => {
    turnCount = 0;
    stats.consecutiveFails = 0;
    stats.accumulatedTokens = 0;
    stats.accumulatedCost = 0;
    stats.generationCount = 0;
    lastWtTabTitle = readWtTabTitle();
  });

  // ============================
  // 自动触发：每 N 轮
  // ============================
  pi.on("turn_end", async (_event, ctx) => {
    turnCount++;

    if (turnCount % NAME_UPDATE_INTERVAL !== 0) return;

    // ---- AI 命名 ----
    await runAiNaming(pi, ctx, stats);

    // 更新 WT 标签记录（runAiNaming 内部已同步）
    const newName = pi.getSessionName();
    if (newName) {
      lastWtTabTitle = newName.replace(/\s*\[[\d:]{8}\s[\d-]{10}\]\s*$/, "");
    }
  });
}
