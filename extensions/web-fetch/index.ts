/**
 * Web Fetch 扩展 — 为 pi 提供网络访问能力
 *
 * 特性：
 * - HTTP→HTTPS 自动升级
 * - HTML→Markdown 转换 (turndown)
 * - 正文提取 (@mozilla/readability + linkedom，先提取正文再转换)
 * - HTML→纯文本降级 (htmlparser2)
 * - Cloudflare 机器人检测重试
 * - 图片类型检测（返回 base64）
 * - 内网 IP 黑名单
 * - 简单 Map+TTL 缓存
 * - 内容截断（100K 字符）
 * - 超时控制（默认 30s，最大 120s）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// 依赖 — 懒加载，仅在首次调用时导入（避免启动开销）
// ============================================================================

let TurndownService: typeof import("turndown").default | null = null;
let htmlparser2: typeof import("htmlparser2") | null = null;

async function getTurndownService(): Promise<InstanceType<typeof TurndownService>> {
  if (!TurndownService) {
    TurndownService = (await import("turndown")).default;
  }
  // @ts-expect-error turndown CJS/ESM 兼容
  const Ctor = TurndownService.default ?? TurndownService;
  return new Ctor({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
}

async function getHtmlparser2() {
  if (!htmlparser2) {
    htmlparser2 = await import("htmlparser2");
  }
  return htmlparser2;
}

let readabilityModule: typeof import("@mozilla/readability") | null = null;
let linkedom: typeof import("linkedom") | null = null;

async function getReadability(): Promise<typeof import("@mozilla/readability")> {
  if (!readabilityModule) {
    readabilityModule = await import("@mozilla/readability");
  }
  return readabilityModule;
}

async function getLinkedDom() {
  if (!linkedom) {
    linkedom = await import("linkedom");
  }
  return linkedom;
}

// ============================================================================
// 缓存 — 简单 Map + TTL
// ============================================================================

const CACHE_TTL = 15 * 60 * 1000; // 15 分钟
const MAX_CACHE_SIZE = 200; // 最多 200 条

interface CacheEntry {
  output: string;
  title: string;
  contentType: string;
  statusCode: number;
  format: string;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(url: string, format: string): string {
  return url + "|" + format;
}

function cacheGet(url: string, format: string): CacheEntry | null {
  const entry = cache.get(cacheKey(url, format));
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL) {
    cache.delete(cacheKey(url, format));
    return null;
  }
  return entry;
}

function cacheSet(url: string, format: string, entry: CacheEntry): void {
  // 驱逐最旧条目
  if (cache.size >= MAX_CACHE_SIZE) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.cachedAt < oldestTime) {
        oldestTime = v.cachedAt;
        oldestKey = k;
      }
    }
    cache.delete(oldestKey);
  }
  cache.set(cacheKey(url, format), { ...entry, format, cachedAt: Date.now() });
}

// ============================================================================
// 安全校验
// ============================================================================

/** 内网/保留 IP 黑名单前缀 */
const BLOCKED_HOST_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\.0\.0\.0$/,
  /^local(host)?$/i, /^\[::1\]$/, /^\[fc00:/i, /^\[fd00:/i,
];

function isBlockedHost(hostname: string): boolean {
  // 去掉 IPv6 括号
  const host = hostname.replace(/^\[|\]$/g, "");
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(host));
}

function validateUrl(url: string): string | null {
  // 截断过长 URL（2000 字符限制，与 claude-code 一致）
  if (url.length > 2000) return "URL 过长（最大 2000 字符）";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL 格式无效";
  }

  // 仅允许 http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "仅支持 http:// 和 https:// 协议";
  }

  // 禁止 URL 中包含用户名/密码
  if (parsed.username || parsed.password) {
    return "URL 不得包含用户名或密码";
  }

  // 禁止内网 IP
  if (isBlockedHost(parsed.hostname)) {
    return `禁止访问内网地址: ${parsed.hostname}`;
  }

  return null; // 校验通过
}

// ============================================================================
// 网络请求
// ============================================================================

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024; // 10MB
const MAX_OUTPUT_CHARS = 100_000; // 100K 字符截断

/** UA 池 — 模拟现代浏览器，随机轮换降低指纹一致性 */
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
];

let uaIndex = 0;

/** 轮换获取一个 User-Agent（避免同一 session 内频繁重复使用同一 UA） */
function pickUA(): string {
  const ua = UA_POOL[uaIndex % UA_POOL.length];
  uaIndex++;
  return ua;
}

/** 同域名请求节流 — 避免触发目标站点限流 */
const domainLastRequest = new Map<string, number>();
const DOMAIN_THROTTLE_MS = 2000; // 同域名最小间隔 2 秒

async function throttleDomain(hostname: string): Promise<void> {
  const last = domainLastRequest.get(hostname);
  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < DOMAIN_THROTTLE_MS) {
      await new Promise(r => setTimeout(r, DOMAIN_THROTTLE_MS - elapsed));
    }
  }
  domainLastRequest.set(hostname, Date.now());
}

interface FetchResult {
  output: string;
  title: string;
  contentType: string;
  statusCode: number;
  extractionSource?: string;
}

/**
 * 执行单次 HTTP GET 请求（内部方法）
 * 返回 Response 或 null（网络/超时错误时）
 */
async function attemptFetch(
  finalUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);

  // 外部 signal 也绑定到内部 abort
  const onExternalAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onExternalAbort);

  try {
    return await fetch(finalUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", onExternalAbort);
  }
}

async function doFetch(
  url: string,
  format: "markdown" | "text" | "html",
  timeoutMs: number,
  signal: AbortSignal,
): Promise<FetchResult> {
  // HTTP→HTTPS 自动升级
  const finalUrl = url.startsWith("http://") ? url.replace("http://", "https://") : url;

  // 构建 Accept 头（参考 OpenCode，内容协商）
  let acceptHeader = "*/*";
  switch (format) {
    case "markdown":
      acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/html;q=0.8, text/plain;q=0.7, */*;q=0.1";
      break;
    case "text":
      acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
      break;
    case "html":
      acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
      break;
  }

  const baseHeaders: Record<string, string> = {
    "Accept": acceptHeader,
    "Accept-Language": "en-US,en;q=0.9",
  };

  // GitHub 域名自动注入 Personal Access Token
  // 优先级：环境变量 GITHUB_TOKEN > 配置文件 .pi/web-fetch-config.json
  const hostname = new URL(finalUrl).hostname;
  if (/^(api\.)?github\.com$|^raw\.githubusercontent\.com$/.test(hostname)) {
    let ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      const configPath = join(process.cwd(), ".pi/web-fetch-config.json");
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          ghToken = config.githubToken || null;
        } catch {
          // 配置文件解析失败，忽略
        }
      }
    }
    if (ghToken) {
      baseHeaders["Authorization"] = `Bearer ${ghToken}`;
      // GitHub API 偏好更轻量的 UA
      baseHeaders["User-Agent"] = "opencode";
    }
  }

  // 同域名节流（避免触发目标站点限流）
  await throttleDomain(hostname);

  // 检测 signal 是否已中止（并行调用时可能已被取消）
  if (signal.aborted) {
    throw new Error(`请求已取消: ${signal.reason || "未知原因"}`);
  }

  // 构建请求 headers：baseHeaders 中的 UA 优先（如 GitHub Token 的 "opencode"），否则用随机 UA
  function buildRequestHeaders(base: Record<string, string>): Record<string, string> {
    const h = { ...base };
    if (!h["User-Agent"]) h["User-Agent"] = pickUA();
    return h;
  }

  // 策略 1：随机 Chrome/Firefox/Safari/Edge UA
  let response: Response;
  try {
    response = await attemptFetch(
      finalUrl,
      buildRequestHeaders(baseHeaders),
      timeoutMs,
      signal,
    );
  } catch (firstErr: unknown) {
    // 网络错误 → 换一个 UA 重试
    try {
      response = await attemptFetch(
        finalUrl,
        buildRequestHeaders(baseHeaders),
        timeoutMs,
        signal,
      );
    } catch (secondErr: unknown) {
      const detail = secondErr instanceof Error
        ? [secondErr.message, (secondErr as any).cause?.message].filter(Boolean).join(": ")
        : String(secondErr);
      throw new Error(classifyFetchError(detail));
    }
  }

  // 标记是否已尝试 Cloudflare 重试（用于 403 错误提示增强）
  let cloudflareRetried = false;

  // 策略 2：如果被 Cloudflare 拦截（403 + cf-mitigated），换 UA 重试
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    try {
      response = await attemptFetch(
        finalUrl,
        buildRequestHeaders(baseHeaders),
        timeoutMs,
        signal,
      );
    } catch (retryErr: unknown) {
      // 重试也失败了，用原始 response 报错
      // （不抛出，让后面的 !response.ok 检查处理）
    }
    cloudflareRetried = true;
  }

  const contentType = response.headers.get("content-type") || "";
  const statusCode = response.status;

  if (!response.ok) {
    // 提供更友好的错误信息
    if (statusCode === 429) {
      const retryAfter = response.headers.get("retry-after");
      let hint: string;
      if (retryAfter) {
        const parsed = parseInt(retryAfter);
        if (!isNaN(parsed)) {
          hint = `服务器要求等待 ${parsed} 秒后重试。`;
        } else {
          hint = `服务器要求 ${retryAfter} 之后重试。`;
        }
      } else {
        hint = "请求频率过高，请稍后重试。";
      }
      throw new Error(`HTTP 429: ${hint}`);
    }
    if (statusCode === 403) {
      const cfHint = cloudflareRetried ? "\n已尝试更换 UA 绕过 Cloudflare 防护但失败。" : "";
      const ghHint = hostname.includes("github.com")
        ? `\n提示：GitHub 访问受限。可在 .pi/web-fetch-config.json 中配置 githubToken 提升限额（60→5000次/小时）。\n获取 token: https://github.com/settings/tokens`
        : `\n提示：可能触发了反爬保护，GitHub/npm 等站点建议带 token 访问。`;
      throw new Error(
        `HTTP 403: 服务器拒绝访问。${cfHint}${ghHint}`,
      );
    }
    if (statusCode === 401) {
      const ghHint = hostname.includes("github.com")
        ? `\n提示：GitHub Token 可能无效或已过期。检查 .pi/web-fetch-config.json 中的 githubToken 或环境变量 GITHUB_TOKEN。\n管理 token: https://github.com/settings/tokens`
        : "";
      throw new Error(`HTTP 401: 认证失败。${ghHint}`);
    }
    if (statusCode === 404) {
      throw new Error(`HTTP 404: 页面不存在`);
    }
    throw new Error(`HTTP ${statusCode}: ${response.statusText || httpStatusFallback(statusCode)}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_CONTENT_LENGTH) {
    throw new Error(`响应过大（超过 ${MAX_CONTENT_LENGTH / 1024 / 1024}MB 限制）`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_CONTENT_LENGTH) {
    throw new Error(`响应过大（超过 ${MAX_CONTENT_LENGTH / 1024 / 1024}MB 限制）`);
  }

  const mime = contentType.split(";")[0]?.trim().toLowerCase() || "";

  // 图片检测 — 返回 base64 data URL
  if (mime.startsWith("image/")) {
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return {
      output: `[图片] ${finalUrl} (${mime}, ${formatSize(arrayBuffer.byteLength)})`,
      title: `${finalUrl} (${contentType})`,
      contentType,
      statusCode,
    };
  }

  const rawContent = new TextDecoder().decode(arrayBuffer);
  let title = `${new URL(finalUrl).hostname} (${contentType || "unknown"})`;

  let output: string;
  let extractionSource: string | undefined;

  if (contentType.includes("text/html")) {
    // 正文提取 — 仅在 markdown/text 格式下进行（html 格式保持原始）
    let extracted: ExtractResult | null = null;
    if (format === "markdown" || format === "text") {
      extracted = await extractMainContent(rawContent);
      // 用 Readability 提取的页面标题覆盖默认 hostname title
      if (extracted?.meta?.title) {
        title = extracted.meta.title;
      }
    }

    // HTML 内容 → 按格式转换
    const srcHtml = extracted?.html ?? rawContent;
    extractionSource = extracted?.source === "readability" ? "正文提取" : undefined;

    switch (format) {
      case "markdown": {
        const td = await getTurndownService();
        td.remove(["script", "style", "meta", "link", "noscript", "iframe"]);
        output = td.turndown(srcHtml);
        break;
      }
      case "text": {
        const hp = await getHtmlparser2();
        output = extractTextFromHTML(srcHtml, hp);
        break;
      }
      case "html":
        output = srcHtml;
        break;
    }
  } else if (contentType.includes("text/markdown")) {
    // 服务器直接返回 Markdown
    output = rawContent;
  } else {
    // 其他文本格式 → 直接返回
    output = rawContent;
  }

  // 截断
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + `\n\n[... 已截断 ${output.length - MAX_OUTPUT_CHARS} 个字符]`;
  }

  return { output, title, contentType, statusCode, extractionSource };
}

// ============================================================================
// HTML→纯文本提取（htmlparser2）
// ============================================================================

function extractTextFromHTML(
  html: string,
  hp: typeof import("htmlparser2"),
): string {
  let text = "";
  let skipDepth = 0;

  const parser = new hp.Parser({
    onopentag(name: string) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++;
      }
    },
    ontext(input: string) {
      if (skipDepth === 0) text += input;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });

  parser.write(html);
  parser.end();

  // 压缩空白
  return text.replace(/\s+/g, " ").trim();
}

// ============================================================================
// 正文提取（@mozilla/readability + linkedom）
// ============================================================================

interface ExtractResult {
  html: string;
  source: "readability" | "raw";
  /** readability 提取的元数据（title/excerpt/byline），用于增强输出 */
  meta?: {
    title?: string;
    excerpt?: string;
    byline?: string;
  };
}

/**
 * 使用 Mozilla Readability 算法从 HTML 中提取正文。
 * 失败时回退到原始 HTML。
 */
async function extractMainContent(rawHtml: string): Promise<ExtractResult> {
  try {
    const { Readability: R, isProbablyReaderable } = await getReadability();
    const { parseHTML } = await getLinkedDom();
    const { document } = parseHTML(rawHtml);

    // 预检：跳过明显不适合阅读模式的页面（纯代码页、图片站等），节省 CPU
    if (!isProbablyReaderable(document)) {
      return { html: rawHtml, source: "raw" };
    }

    const reader = new R(document, {
      charThreshold: 250,   // 降低字符阈值（默认 500），适配短文档
      keepClasses: false,   // 不保留 CSS class，减少 Markdown 噪声
    });
    const article = reader.parse();
    if (article?.content?.trim()) {
      const meta: ExtractResult["meta"] = {};
      if (article.title) meta.title = article.title;
      if (article.excerpt) meta.excerpt = article.excerpt;
      if (article.byline) meta.byline = article.byline;
      return {
        html: article.content,
        source: "readability",
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      };
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn("[web-fetch] 正文提取失败，降级为原始 HTML:", detail);
  }
  return { html: rawHtml, source: "raw" };
}

// ============================================================================
// 辅助
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 为常见 HTTP 状态码提供 fallback 描述（HTTP/2 无 statusText 时使用） */
function httpStatusFallback(code: number): string {
  const map: Record<number, string> = {
    400: "Bad Request", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 408: "Request Timeout",
    429: "Too Many Requests", 500: "Internal Server Error",
    502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return map[code] || "";
}

/** 将 Node.js fetch 网络错误分类为人类可读的提示 */
function classifyFetchError(message: string): string {
  const m = message.toLowerCase();
  // 先专项检查，最后通用兜底（避免 "fetch failed" 通吃所有错误）
  if (m.includes("timeout") || m.includes("abort")) {
    return `请求超时: ${message}\n提示：目标站点响应过慢，可稍后重试`;
  }
  if (m.includes("tls") || m.includes("ssl") || m.includes("certificate") || m.includes("unsafe legacy renegotiation") || m.includes("eproto")) {
    return `TLS 连接失败: ${message}\n提示：站点证书可能有问题，或需要更新 Node.js TLS 配置`;
  }
  if (m.includes("dns") || m.includes("getaddrinfo") || m.includes("enotfound") || m.includes("eai_again")) {
    return `DNS 解析失败: ${message}\n提示：检查 DNS 配置或尝试更换网络`;
  }
  if (m.includes("econnrefused")) {
    return `连接被拒绝: ${message}\n提示：目标站点可能未运行或端口被防火墙拦截`;
  }
  if (m.includes("fetch failed")) {
    return `网络不可达: ${message}\n提示：检查网络连接或目标站点是否可访问`;
  }
  return `请求失败: ${message}`;
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `从指定 URL 获取内容。支持 Markdown、纯文本、HTML 三种输出格式。

- 获取网页内容并转换为指定格式（默认 Markdown）
- HTML 页面自动转换为 Markdown，保留标题、列表、代码块等结构
- 支持图片检测，返回图片类型和大小信息
- HTTP URL 自动升级为 HTTPS
- 自带 15 分钟缓存，相同 URL 不重复请求
- 内网地址自动拒绝，防止 SSRF

使用注意：
- URL 必须是完整有效的 http:// 或 https:// 地址
- 内容超过 100K 字符会自动截断
- 最大响应 10MB，超时默认 30 秒
- 仅做 GET 请求，不会修改任何文件`,
    promptSnippet: "fetch content from a URL, convert HTML to markdown or plain text",
    parameters: Type.Object({
      url: Type.String({ description: "要获取内容的 URL（必须以 http:// 或 https:// 开头）" }),
      format: Type.Optional(
        Type.String({
          description: "输出格式：markdown（默认，推荐）、text（纯文本）或 html（原始 HTML）",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const url = params.url.trim();
      const format = (params.format || "markdown") as "markdown" | "text" | "html";

      // 校验 format
      if (!["markdown", "text", "html"].includes(format)) {
        return {
          content: [{ type: "text", text: `❌ 不支持的格式: "${format}"。可选: markdown, text, html` }],
          details: { error: true, url },
        };
      }

      // URL 校验
      const validationError = validateUrl(url);
      if (validationError) {
        return {
          content: [{ type: "text", text: `❌ ${validationError}` }],
          details: { error: true, url },
        };
      }

      // 检查缓存
      const cached = cacheGet(url, format);
      if (cached) {
        return {
          content: [{
            type: "text",
            text: `📄 **${cached.title}**  [缓存命中]\nHTTP ${cached.statusCode} | ${formatSize(Buffer.byteLength(cached.output))}\n\n${cached.output}`,
          }],
          details: { url, format, cached: true, statusCode: cached.statusCode },
        };
      }

      // 发起请求
      try {
        const result = await doFetch(url, format, DEFAULT_TIMEOUT, signal);
        const outputSize = Buffer.byteLength(result.output);

        // 写入缓存
        cacheSet(url, format, {
          output: result.output,
          title: result.title,
          contentType: result.contentType,
          statusCode: result.statusCode,
          format,
          cachedAt: Date.now(),
        });

        return {
          content: [{
            type: "text",
            text: `📄 **${result.title}${result.extractionSource ? ' [' + result.extractionSource + ']' : ''}**\nHTTP ${result.statusCode} | ${formatSize(outputSize)}\n\n${result.output}`,
          }],
          details: {
            url,
            format,
            statusCode: result.statusCode,
            contentType: result.contentType,
            size: outputSize,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ 获取失败: ${msg}` }],
          details: { error: true, url, message: msg },
        };
      }
    },
  });
}
