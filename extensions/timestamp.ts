/**
 * Timestamp Extension — 为每条消息尾部注入日期时间戳
 *
 * 通过 message_start + message_end 事件在所有消息的 content 尾部注入时间戳。
 * 时间戳会同时显示在 TUI 和 LLM 上下文中。
 *
 * message_start：直接修改 event.message.content（对象引用），解决 user 消息
 *   在 message_end 时 UI 不更新的问题。
 * message_end：通过返回值修改，覆盖 assistant / toolResult / custom 等消息。
 *
 * 格式：`[YYYY-MM-DD HH:MM:SS]`（Markdown 行内代码样式）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

// ── 格式化 ────────────────────────────────────────────────

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `\`[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]\``;
}

const TIMESTAMP_RE = /\[[\d-]{10} [\d:]{8}\]/;

// ── Content 处理 ──────────────────────────────────────────

function hasTimestamp(content: unknown): boolean {
  if (typeof content === "string") return TIMESTAMP_RE.test(content);
  if (Array.isArray(content)) {
    return content.some(
      (b) =>
        typeof b === "object" && "type" in b &&
        (b as any).type === "text" && TIMESTAMP_RE.test((b as TextContent).text),
    );
  }
  return false;
}

function appendTimestamp(content: unknown, prefix: string): unknown {
  if (typeof content === "string") return `${content}\n\n${prefix}`;
  if (Array.isArray(content)) {
    return [...content, { type: "text", text: `\n\n${prefix}` } as TextContent];
  }
  return content;
}

// ── 辅助 ──────────────────────────────────────────────────

function injectTimestamp(msg: Record<string, unknown>): void {
  if (typeof msg.timestamp !== "number") return;
  if (hasTimestamp(msg.content)) return;
  msg.content = appendTimestamp(msg.content, formatTimestamp(msg.timestamp));
}

// ── 扩展入口 ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // message_start：直接修改 event.message.content（同一对象引用）
  // 这能在 UI 渲染前生效——解决 user 消息在 message_end 时 UI 不更新的问题
  pi.on("message_start", async (event, _ctx) => {
    const msg = event.message as Record<string, unknown>;
    if (msg.role === "user") injectTimestamp(msg);
  });

  // message_end：通过返回值修改，覆盖所有消息类型
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message as Record<string, unknown>;
    if (typeof msg.timestamp !== "number") return;
    if (hasTimestamp(msg.content)) return;

    injectTimestamp(msg);
    return { message: msg as any };
  });

}
