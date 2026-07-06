/**
 * 中文化工具描述扩展 (zh-tools)
 *
 * 在 before_agent_start 事件中拦截系统提示词，
 * 将英文的工具描述、指导、角色定义等替换为中文，
 * 减少英文概念对 LLM 思考过程的锚定效应。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// 翻译表
// ============================================================================

/** 工具摘要翻译（系统提示词中的 one-line snippet） */
const TOOL_SNIPPET_ZH: Record<string, string> = {
  // read
  "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.":
    "读取文件内容。支持文本文件和图片（jpg、png、gif、webp）。图片以附件形式发送。文本文件输出截断至 2000 行或 50KB（先到为准）。大文件使用 offset/limit 分批读取。需要完整内容时，持续递增 offset 直至读完。",

  // bash
  "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.":
    "在当前工作目录中执行 bash 命令。返回 stdout 和 stderr。输出截断至最后 2000 行或 50KB（先到为准）。如被截断，完整输出保存至临时文件。可指定超时秒数。",

  // edit
  "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.":
    "通过精确文本替换编辑文件。每个 edits[].oldText 必须匹配原文件中唯一且不重叠的区域。如需修改同一区域或相邻行，合并为一次编辑而非多次。不要包含大段不变内容仅为了连接远处修改。",

  // write
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.":
    "将内容写入文件。文件不存在则创建，存在则覆盖。自动创建父目录。",

  // async_run
  "Run a shell command. Returns immediately with a task_id; results are auto-injected when done. On Windows runs in cmd.exe, use Windows paths (D:\\path\\to\\file) and & for chaining.":
    "运行 shell 命令。立即返回 task_id；完成后结果自动注入。Windows 上在 cmd.exe 中运行，使用 Windows 路径（D:\\path\\to\\file）并用 & 串联命令。",

  // async_list
  "List all background tasks (running and completed).":
    "列出所有后台任务（运行中和已完成）。",

  // async_peek
  "Peek at the live stdout/stderr of a running or completed background task. Returns the last N characters.":
    "查看运行中或已完成后台任务的实时 stdout/stderr。返回最后 N 个字符。",

  // web_fetch
  "从指定 URL 获取内容。支持 Markdown、纯文本、HTML 三种输出格式。\n\n- 获取网页内容并转换为指定格式（默认 Markdown）\n- HTML 页面自动转换为 Markdown，保留标题、列表、代码块等结构\n- 支持图片检测，返回图片类型和大小信息\n- HTTP URL 自动升级为 HTTPS\n- 自带 15 分钟缓存，相同 URL 不重复请求\n- 内网地址自动拒绝，防止 SSRF\n\n使用注意：\n- URL 必须是完整有效的 http:// 或 https:// 地址\n- 内容超过 100K 字符会自动截断\n- 最大响应 10MB，超时默认 30 秒\n- 仅做 GET 请求，不会修改任何文件":
    "从指定 URL 获取内容。支持 Markdown、纯文本、HTML 三种输出格式。\n\n- 获取网页内容并转换为指定格式（默认 Markdown）\n- HTML 页面自动转换为 Markdown，保留标题、列表、代码块等结构\n- 支持图片检测，返回图片类型和大小信息\n- HTTP URL 自动升级为 HTTPS\n- 自带 15 分钟缓存，相同 URL 不重复请求\n- 内网地址自动拒绝，防止 SSRF\n\n使用注意：\n- URL 必须是完整有效的 http:// 或 https:// 地址\n- 内容超过 100K 字符会自动截断\n- 最大响应 10MB，超时默认 30 秒\n- 仅做 GET 请求，不会修改任何文件",

  // session_rag (already Chinese-ish but has English fragments)
  "语义搜索历史会话片段。传入自然语言查询，返回最相关的对话 chunks。":
    "语义搜索历史会话片段。传入自然语言查询，返回最相关的对话 chunks。",

  // session_peek
  "查看某个 session 的特定对话段落。按 ref（行号/轮次）定位。":
    "查看某个 session 的特定对话段落。按 ref（行号/轮次）定位。",

  // session_card
  "生成/更新某个 session 的 L2 索引卡到 Wiki（较重：解析全部 JSONL + 调 DeepSeek API，延迟 10-30s）。查看已缓存的索引卡请用 wiki_search。":
    "生成/更新某个 session 的 L2 索引卡到 Wiki（较重：解析全部 JSONL + 调 DeepSeek API，延迟 10-30s）。查看已缓存的索引卡请用 wiki_search。",

  // wiki_search
  "搜索 Wiki 知识库（memo/ 下的个人知识库）。用于查找项目约定、历史决策、技术文档、设计参考。先调用此工具获取匹配条目列表，再用 read 工具查看条目标题文件获取正文。支持限定搜索范围：title（标题）、description（描述）、body（正文）、all（全部）。多关键词默认 AND 匹配（全部命中），可选 OR（任一命中）。":
    "搜索 Wiki 知识库（memo/ 下的个人知识库）。用于查找项目约定、历史决策、技术文档、设计参考。先调用此工具获取匹配条目列表，再用 read 工具查看条目标题文件获取正文。支持限定搜索范围：title（标题）、description（描述）、body（正文）、all（全部）。多关键词默认 AND 匹配（全部命中），可选 OR（任一命中）。",

  // windows_notify
  "当需要用户确认某个决策、回答问题、或需要用户介入时，通过 Windows 系统通知向用户发送通知。通知包含会话信息、任务进展和需要确认的问题。\n\n**何时使用：**\n- 需要用户对某个方案/决策进行确认时\n- 需要用户回答关键问题才能继续时\n- 长时间任务完成，等待用户审查结果时\n- 发现了需要用户注意的重要事项时\n\n调用后用户会在 Windows 通知区域看到弹出提示，AI 应等待用户回到对话中给出回应。":
    "当需要用户确认某个决策、回答问题、或需要用户介入时，通过 Windows 系统通知向用户发送通知。通知包含会话信息、任务进展和需要确认的问题。\n\n**何时使用：**\n- 需要用户对某个方案/决策进行确认时\n- 需要用户回答关键问题才能继续时\n- 长时间任务完成，等待用户审查结果时\n- 发现了需要用户注意的重要事项时\n\n调用后用户会在 Windows 通知区域看到弹出提示，AI 应等待用户回到对话中给出回应。",

  // subagent
  "Delegate to subagents or manage agent definitions.":
    "委派任务给子 agent 或管理 agent 定义。",
};

/** 根据工具名+英文描述查找中文翻译，找不到返回原文 */
function translateSnippet(name: string, english: string): string {
  // 精确匹配
  if (TOOL_SNIPPET_ZH[english]) return TOOL_SNIPPET_ZH[english];
  // 尝试模糊匹配（去首尾空格）
  const trimmed = english.trim();
  if (TOOL_SNIPPET_ZH[trimmed]) return TOOL_SNIPPET_ZH[trimmed];
  return english;
}

// ============================================================================
// 固定文本替换表
// ============================================================================

const FIXED_REPLACEMENTS: Array<[RegExp, string]> = [
  // 角色定义
  [
    /You are an expert coding assistant operating inside pi, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\./,
    "你是一名在 pi（编程 agent 框架）内运行的专家编程助手。通过读取文件、执行命令、编辑代码和编写新文件来帮助用户。",
  ],

  // 可用工具标题
  [/^Available tools:$/m, "## 可用工具"],

  // 附加工具说明
  [
    /In addition to the tools above, you may have access to other custom tools depending on the project\./,
    "上述工具之外，可能还有其他根据项目配置的自定义工具。",
  ],

  // 指导标题
  [/^Guidelines:$/m, "## 行为准则"],

  // 文件探索指导
  [
    /Use bash for file operations like ls, rg, find/,
    "使用 bash 进行文件操作（如 ls、rg、find 等）",
  ],
  [
    /Be concise in your responses/,
    "回复保持简洁",
  ],
  [
    /Show file paths clearly when working with files/,
    "处理文件时清晰标注文件路径",
  ],

  // Pi 文档块
  [
    /Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):/,
    "## Pi 文档\n\n仅在用户询问 pi 本身、SDK、扩展、主题、技能或 TUI 相关问题时读取：",
  ],
  [
    /- Main documentation: ([^\n]+)/,
    "- 主文档：$1",
  ],
  [
    /- Additional docs: ([^\n]+)/,
    "- 补充文档：$1",
  ],
  [
    /- Examples: ([^\n]+)/,
    "- 示例：$1",
  ],
  [
    /- When reading pi docs or examples, resolve docs\/\.\.\. under Additional docs and examples\/\.\.\. under Examples, not the current working directory/,
    "- 阅读 pi 文档或示例时，docs/... 需在补充文档目录下解析，examples/... 在示例目录下解析，而非当前工作目录",
  ],
  [
    /- When asked about: extensions \(docs\/extensions\.md, examples\/extensions\/\), themes \(docs\/themes\.md\), skills \(docs\/skills\.md\), prompt templates \(docs\/prompt-templates\.md\), TUI components \(docs\/tui\.md\), keybindings \(docs\/keybindings\.md\), SDK integrations \(docs\/sdk\.md\), custom providers \(docs\/custom-provider\.md\), adding models \(docs\/models\.md\), pi packages \(docs\/packages\.md\)/,
    "- 被问及以下内容时：扩展（docs/extensions.md、examples/extensions/）、主题（docs/themes.md）、技能（docs/skills.md）、提示模板（docs/prompt-templates.md）、TUI 组件（docs/tui.md）、快捷键（docs/keybindings.md）、SDK 集成（docs/sdk.md）、自定义 provider（docs/custom-provider.md）、添加模型（docs/models.md）、pi 包（docs/packages.md）",
  ],
  [
    /- When working on pi topics, read the docs and examples, and follow \.md cross-references before implementing/,
    "- 处理 pi 相关任务时，请完整阅读文档和示例，并遵循 .md 交叉引用，然后再实施",
  ],
  [
    /- Always read pi \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)/,
    "- 始终完整阅读 pi 的 .md 文件，并追踪相关文档链接（如 TUI API 详见 tui.md）",
  ],

  // 日期/工作目录
  [/^Current date:/m, "当前日期："],
  [/^Current working directory:/m, "当前工作目录："],
];

// ============================================================================
// 工具摘要段处理
// ============================================================================

/**
 * 处理 "Available tools:" 段落。
 * 格式：每行 "- 工具名: 英文描述"，将英文描述替换为中文。
 */
function translateAvailableToolsBlock(block: string): string {
  const lines = block.split("\n");
  const header = lines[0]; // "Available tools:" or translated header
  const toolLines = lines.slice(1);

  const translated = toolLines.map((line) => {
    // 匹配 "- name: description" 格式
    const match = line.match(/^- (\w+): (.+)$/);
    if (!match) return line;
    const [, name, english] = match;
    const zh = translateSnippet(name, english);
    return `- ${name}：${zh}`;
  });

  return [header, ...translated].join("\n");
}

// ============================================================================
// 主逻辑
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    let prompt = event.systemPrompt;

    // 1. 处理 "Available tools:" 段落
    // 匹配从 "Available tools:" 到下一个空行前的 "In addition..." 或 "\n\nGuidelines:"
    prompt = prompt.replace(
      /(^Available tools:\n)((?:- \w+: .+\n)+)(\nIn addition to the tools above[\s\S]*?\n)(?=\nGuidelines:)/m,
      (match, header, toolLines, addendum) => {
        const translatedTools = translateAvailableToolsBlock(header + toolLines.trimEnd());
        const translatedAddendum = translateFixed(addendum.trimEnd());
        return translatedTools + "\n\n" + translatedAddendum + "\n";
      },
    );

    // 如果上面没匹配到（比如 "In addition" 行不存在），尝试只匹配 tools 段
    if (!prompt.includes("可用工具")) {
      prompt = prompt.replace(
        /(^Available tools:\n)((?:- \w+: .+\n)+)/m,
        (_match, header, toolLines) => {
          return translateAvailableToolsBlock(header + toolLines.trimEnd());
        },
      );
    }

    // 2. 应用固定文本替换
    for (const [regex, replacement] of FIXED_REPLACEMENTS) {
      prompt = prompt.replace(regex, replacement);
    }

    // 3. 替换 "(none)" 占位符
    prompt = prompt.replace(/^\(none\)$/m, "（无）");

    return { systemPrompt: prompt };
  });
}

/** 对 addendum 文本应用固定替换 */
function translateFixed(text: string): string {
  let result = text;
  for (const [regex, replacement] of FIXED_REPLACEMENTS) {
    result = result.replace(regex, replacement);
  }
  return result;
}
