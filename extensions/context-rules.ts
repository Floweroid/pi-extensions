/**
 * Context Rules Extension — 关键规则注入到上下文尾部
 *
 * 将 .pi/rules.md 内容作为独立 system message 注入到消息列表末尾。
 * 每次 before_provider_request 时：
 *   1. 删除所有旧的用户规则 system message（识别特征："关键规则 - 始终生效"）
 *   2. 在末尾 push 一条新的 system 规则
 *
 * 优势：
 *   - 始终只有 1 条规则，不会累积
 *   - 位于尾部，recency bias 最强
 *   - 后台任务注入消息不会触发重复（因过滤逻辑不依赖 user message）
 *   - 不修改 user/assistant 消息内容，不影响对话历史
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 识别用户规则 system 消息的锚点标记 */
const RULE_MARKER = "关键规则 - 始终生效";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const rulesPath = join(process.cwd(), ".pi/rules.md");
    if (!existsSync(rulesPath)) return;

    let rules: string = "";
    try {
      rules = readFileSync(rulesPath, "utf-8").trim();
    } catch {
      return;
    }
    if (!rules) return;

    const payload = event.payload as any;
    let messages: any[] = payload?.messages;
    if (!messages || messages.length === 0) return;

    // 1. 删除所有旧的用户规则 system message
    messages = messages.filter((m: any) => {
      if (m.role !== "system") return true;
      if (typeof m.content !== "string") return true;
      return !m.content.includes(RULE_MARKER);
    });

    // 2. 在尾部注入新的系统规则（始终只有一条）
    messages.push({ role: "system", content: rules });

    return { ...payload, messages };
  });
}
