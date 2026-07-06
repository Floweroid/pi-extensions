/**
 * Intercom 样式增强扩展 (intercom-style)
 *
 * 覆盖 pi-intercom 的 intercom_message 渲染器，
 * 使子 agent 结果和其他 intercom 消息使用暗紫色背景显示。
 *
 * 无边框布局，整行宽度填充 customMsgBg（#2d2838）暗紫色背景，
 * 文字保持默认颜色。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as {
      from?: { name?: string; id?: string; cwd?: string };
      message?: { content?: { text?: string; attachments?: Array<{ name: string }> }; replyTo?: string; expectsReply?: boolean };
      replyCommand?: string;
      bodyText?: string;
    } | undefined;
    if (!details) return undefined;
    return new PurpleInlineMessageComponent(details, theme);
  });
}

/** 暗紫色背景 Intercom 消息组件 — 无边框，整行背景填充 */
class PurpleInlineMessageComponent implements Component {
  private details: {
    from?: { name?: string; id?: string; cwd?: string };
    message?: { content?: { text?: string; attachments?: Array<{ name: string }> }; replyTo?: string; expectsReply?: boolean };
    replyCommand?: string;
    bodyText?: string;
  };
  private theme: Theme;

  constructor(
    details: {
      from?: { name?: string; id?: string; cwd?: string };
      message?: { content?: { text?: string; attachments?: Array<{ name: string }> }; replyTo?: string; expectsReply?: boolean };
      replyCommand?: string;
      bodyText?: string;
    },
    theme: Theme,
  ) {
    this.details = details;
    this.theme = theme;
  }

  invalidate(): void {}

  /** 暗紫色背景渲染 — 文字保持默认颜色 */
  private bg(text: string): string {
    // 使用主题中已有的 customMessageBg 颜色 (暗紫色背景)
    return this.theme.bg("customMessageBg", text);
  }

  /** 渲染一整行：内容靠左，剩余宽度用空格填充，整行应用背景色。muted 控制是否 dim 前景 */
  private line(text: string, fullWidth: number, muted = true): string {
    const content = muted ? this.theme.fg("dim", text) : text;
    const visible = visibleWidth(content);
    const padding = Math.max(0, fullWidth - visible);
    return this.bg(content + " ".repeat(padding));
  }

  render(width: number): string[] {
    const { from, message, replyCommand, bodyText } = this.details;
    const lines: string[] = [];

    if (width < 1) return [];

    const senderName = from?.name || from?.id?.slice(0, 8) || "unknown";
    const cwd = from?.cwd || "";

    // 发送者行 — 保持默认亮度
    const header = `📨 From: ${senderName}${cwd ? ` (${cwd})` : ""}`;
    lines.push(this.line(truncateToWidth(header, width, ""), width, false));

    // 正文 — dim 浅色
    const contentText = bodyText || message?.content?.text || "";
    const contentLines = wrapTextWithAnsi(contentText, width);
    for (const line of contentLines) {
      lines.push(this.line(truncateToWidth(line, width, ""), width));
    }

    // 回复命令
    if (replyCommand) {
      const replyLines = wrapTextWithAnsi(this.theme.fg("dim", `↩ Reply: ${replyCommand}`), width);
      for (const rl of replyLines) {
        lines.push(this.line(truncateToWidth(rl, width, ""), width));
      }
    }

    // 附件
    if (message?.content?.attachments?.length) {
      for (const att of message.content.attachments) {
        const label = this.theme.fg("dim", `📎 ${att.name}`);
        lines.push(this.line(truncateToWidth(label, width, ""), width));
      }
    }

    // 回复引用
    if (message?.replyTo && !message?.expectsReply) {
      const reply = this.theme.fg("dim", `↳ Reply to ${message.replyTo.slice(0, 8)}`);
      lines.push(this.line(truncateToWidth(reply, width, ""), width));
    }

    return lines;
  }
}
