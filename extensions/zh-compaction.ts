/**
 * 中文压缩扩展 (zh-compaction)
 *
 * 将 pi 默认的英文压缩提示词替换为中文版本，使压缩产出的摘要为中文。
 * 使用 DeepSeek 模型进行摘要生成（更经济），若不可用则回退到默认压缩。
 *
 * 项目级安装：放在 .pi/extensions/ 下，并在 .pi/settings.json 中注册。
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

/** 中文压缩系统提示词 */
const ZH_SUMMARIZATION_SYSTEM_PROMPT = `你是一个对话摘要助手。你的任务是阅读用户与 AI 编程助手之间的对话，然后按照指定格式生成结构化摘要。

不要继续对话。不要回复对话中的任何问题。只输出结构化摘要。`;

/** 首次压缩提示词 */
const ZH_FIRST_SUMMARY_PROMPT = `以上是一条需要摘要的对话。请创建一份结构化的上下文检查点摘要，供另一个 LLM 用来继续工作。

请严格按照以下格式输出：

## 目标
[用户想要完成什么？如果会话涉及多个任务，可以列出多条。]

## 约束与偏好
- [用户提到的任何约束、偏好或要求]
- [或写"（无）"如果没有被提及]

## 进度
### 已完成
- [x] [已完成的任务/变更]

### 进行中
- [ ] [当前工作]

### 阻塞
- [阻碍进展的问题（如有）]

## 关键决策
- **[决策]**：[简要理由]

## 后续步骤
1. [接下来应该发生什么，按顺序列出]

## 关键上下文
- [继续工作所需的任何数据、示例或参考资料]
- [或写"（无）"如果不适用]

每个部分保持简洁。保留确切的文件路径、函数名和错误信息。`;

/** 增量更新提示词 */
const ZH_UPDATE_PROMPT = `以上是新的对话消息，需要整合到 <previous-summary> 标签中的已有摘要。

用新信息更新已有结构化摘要。规则如下：
- 保留已有摘要中的所有信息
- 添加新的进度、决策和上下文
- 更新"进度"部分：将"进行中"的项目移至"已完成"
- 根据已完成的工作更新"后续步骤"
- 保留确切的文件路径、函数名和错误信息
- 如果某些内容不再相关，可以移除

请严格按照以下格式输出：

## 目标
[保留已有目标，如果任务范围扩大则添加新目标]

## 约束与偏好
- [保留已有的，添加新发现的]

## 进度
### 已完成
- [x] [包含之前已完成的项目和新完成的项目]

### 进行中
- [ ] [当前工作 - 根据进展更新]

### 阻塞
- [当前阻塞 - 如已解决则移除]

## 关键决策
- **[决策]**：[简要理由]（保留所有之前的，添加新的）

## 后续步骤
1. [根据当前状态更新]

## 关键上下文
- [保留重要上下文，必要时添加新的]

每个部分保持简洁。保留确切的文件路径、函数名和错误信息。`;

/** 拆分 turn（split turn）前缀摘要提示词 */
const ZH_TURN_PREFIX_PROMPT = `这是一个被截断的 turn 的前半部分。后半部分（最近的工作）已被保留。

请摘要此前缀部分，为理解保留的后缀提供上下文：

## 原始请求
[用户在这个 turn 中要求了什么？]

## 早期进度
- [前缀部分的关键决策和已完成工作]

## 后缀上下文
- [理解保留的近期工作所需的信息]

保持简洁。聚焦于理解保留的后缀所需的内容。`;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将消息序列化为中文标签的文本格式
 */
function serializeConversationZh(messages: ReturnType<typeof convertToLlm>): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (content) parts.push(`[用户]: ${content}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const argsStr = Object.entries(block.arguments as Record<string, unknown>)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }

      if (thinkingParts.length > 0) {
        parts.push(`[助手思考]: ${thinkingParts.join("\n")}`);
      }
      if (textParts.length > 0) {
        parts.push(`[助手]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[助手工具调用]: ${toolCalls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (content) {
        // 截断到 2000 字符（与默认行为一致）
        const truncated = content.length > 2000
          ? content.slice(0, 2000) + `\n\n[... ${content.length - 2000} 更多字符已截断]`
          : content;
        parts.push(`[工具结果]: ${truncated}`);
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * 调用 LLM 生成摘要
 */
async function callModelForSummary(
  model: { provider: string; id: string; maxTokens: number; reasoning?: boolean },
  apiKey: string,
  headers: Record<string, string>,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const maxTokens = Math.min(8192, model.maxTokens > 0 ? model.maxTokens : 8192);

  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: userPrompt }],
      timestamp: Date.now(),
    },
  ];

  const response = await completeSimple(
    model,
    { systemPrompt, messages },
    { maxTokens, signal, apiKey, headers },
  );

  if (response.stopReason === "error") {
    throw new Error(`摘要生成失败: ${response.errorMessage || "未知错误"}`);
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const {
      messagesToSummarize,
      turnPrefixMessages,
      tokensBefore,
      firstKeptEntryId,
      previousSummary,
      settings,
    } = preparation;

    // 尝试使用 deepseek-chat（更轻量便宜），不行就用 deepseek-v4-pro
    let model = ctx.modelRegistry.find("deepseek", "deepseek-chat");
    if (!model) {
      model = ctx.modelRegistry.find("deepseek", "deepseek-v4-pro");
    }

    // 如果没有 DeepSeek 模型可用，回退到默认压缩
    if (!model) {
      ctx.ui.notify("未找到 DeepSeek 模型，使用默认压缩", "warning");
      return;
    }

    // 获取 API key
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify("DeepSeek 认证不可用，使用默认压缩", "warning");
      return;
    }

    ctx.ui.notify(
      `中文压缩：正在用 ${model.id} 摘要 ${messagesToSummarize.length + turnPrefixMessages.length} 条消息（${tokensBefore.toLocaleString()} tokens）...`,
      "info",
    );

    try {
      let summary: string;

      if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
        // 拆分 turn：分别生成历史摘要和前缀摘要
        const llmMessages = convertToLlm(messagesToSummarize);
        const conversationText = serializeConversationZh(llmMessages);

        let historyPrompt: string;
        let historySummary: string;

        if (messagesToSummarize.length > 0) {
          if (previousSummary) {
            historyPrompt = `<conversation>\n${conversationText}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${ZH_UPDATE_PROMPT}`;
          } else {
            historyPrompt = `<conversation>\n${conversationText}\n</conversation>\n\n${ZH_FIRST_SUMMARY_PROMPT}`;
          }
          historySummary = await callModelForSummary(
            model,
            auth.apiKey,
            auth.headers,
            ZH_SUMMARIZATION_SYSTEM_PROMPT,
            historyPrompt,
            signal,
          );
        } else {
          historySummary = "无先前历史。";
        }

        // 生成 turn 前缀摘要
        const prefixLlm = convertToLlm(turnPrefixMessages);
        const prefixText = serializeConversationZh(prefixLlm);
        const prefixPrompt = `<conversation>\n${prefixText}\n</conversation>\n\n${ZH_TURN_PREFIX_PROMPT}`;

        const prefixSummary = await callModelForSummary(
          model,
          auth.apiKey,
          auth.headers,
          ZH_SUMMARIZATION_SYSTEM_PROMPT,
          prefixPrompt,
          signal,
        );

        summary = `${historySummary}\n\n---\n\n**Turn 上下文（拆分 turn）：**\n\n${prefixSummary}`;
      } else {
        // 正常压缩
        const llmMessages = convertToLlm(messagesToSummarize);
        const conversationText = serializeConversationZh(llmMessages);

        let prompt: string;
        if (previousSummary) {
          prompt = `<conversation>\n${conversationText}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${ZH_UPDATE_PROMPT}`;
        } else {
          prompt = `<conversation>\n${conversationText}\n</conversation>\n\n${ZH_FIRST_SUMMARY_PROMPT}`;
        }

        summary = await callModelForSummary(
          model,
          auth.apiKey,
          auth.headers,
          ZH_SUMMARIZATION_SYSTEM_PROMPT,
          prompt,
          signal,
        );
      }

      if (!summary.trim()) {
        if (!signal.aborted) {
          ctx.ui.notify("压缩摘要为空，使用默认压缩", "warning");
        }
        return;
      }

      // 追加文件操作信息（与默认行为一致）
      const { readFiles, modifiedFiles } = prepareFileLists(preparation.fileOps);
      if (readFiles.length > 0 || modifiedFiles.length > 0) {
        const sections: string[] = [];
        if (readFiles.length > 0) {
          sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
        }
        if (modifiedFiles.length > 0) {
          sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
        }
        summary += `\n\n${sections.join("\n\n")}`;
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) {
        ctx.ui.notify(`中文压缩失败: ${message}，回退默认压缩`, "error");
      }
      // 返回 undefined 让 pi 使用默认压缩
      return;
    }
  });
}

/**
 * 从 fileOps 计算文件列表
 */
function prepareFileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}
