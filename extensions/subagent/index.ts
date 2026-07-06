/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, keyHint, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const SYNC_TIMEOUT_MS = 120_000; // 2-minute timeout for sync subagent execution

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = [
		"--mode", "json", "-p", "--no-session",
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
	];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_OFFLINE: "1" },
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	mode: Type.Optional(
		StringEnum(["sync", "async"] as const, {
			description:
				'Execution mode. "sync" (default) awaits result. "async" fires and injects result as a follow-up message (single mode only).',
			default: "sync",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	let sessionUi: ExtensionContext["ui"] | null = null;

	pi.on("session_start", async (_event, ctx) => {
		sessionUi = ctx.ui;
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single ({agent, task}), parallel ({tasks: [...]}), chain ({chain: [...]}, sequential with {previous} placeholder).",
			"Execution mode: \"sync\" (default, awaits result) or \"async\" (fires and injects result as follow-up; single mode only).",
			'Default agent scope is "user" (from ~/.pi/agent/agents). Set agentScope: "both" to include project-local agents in .pi/agents.',
			"Set confirmProjectAgents: false to skip project-agent confirmation dialog.",
			"Set cwd to override the working directory for the subagent process.",
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents (scout, worker, planner, reviewer) with isolated context",
		promptGuidelines: [
			"Use subagent to offload substantial work (multi-step investigation, large-scope changes) to keep main context clean. Do NOT delegate single read/grep/edit tasks.",
			"Available agents: scout (fast read-only recon, returns compressed context), planner (read-only, creates implementation plans from context), reviewer (code review, bash limited to git-diff), worker (full-capability, isolated context, use for implementation).",
			"Single mode: {agent, task}. Parallel mode: {tasks: [{agent, task, cwd?}, ...]}. Chain mode: {chain: [{agent, task, cwd?}, ...]} with {previous} placeholder for sequential handoff.",
			'Use mode: "async" for fire-and-forget single tasks — result auto-injected when done without blocking the main session.',
			"Pass cwd per task to set the working directory for each subagent process independently.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				if (params.mode === "async") {
					return {
						content: [{ type: "text", text: "Async mode is only supported for single agent (agent + task), not chain." }],
						details: makeDetails("chain")([]),
						isError: true,
					};
				}
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [{
							type: "text",
							text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						}],
						details: makeDetails("parallel")([]),
					};

				if (params.mode === "async") {
					let doneCount = 0;
					const totalTasks = params.tasks.length;
					const taskEntries = params.tasks.map((t) => ({
						agent: t.agent,
						summary: (t.task.length > 40 ? t.task.slice(0, 40) + "..." : t.task),
						icon: "→" as string,
						activity: "" as string,
					}));

					const updateWidget = () => {
						sessionUi?.setWidget("subagent", (_tui, theme) => {
							const box = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
							box.addChild(new Text(theme.fg("toolTitle",
								theme.bold(` ⏳ parallel [${doneCount}/${totalTasks} done] `)), 0, 0));
							for (const e of taskEntries) {
								const c = e.icon === "✓" ? "success" : e.icon === "✗" ? "error" : "dim";
								box.addChild(new Text(theme.fg(c as any,
									`  ${e.icon} ${e.agent}  ${e.summary}`), 0, 0));
								if (e.activity) box.addChild(new Text(theme.fg("dim", `    ${e.activity.slice(0, 60)}`), 0, 0));
							}
							return box;
						});
					};

					sessionUi?.setStatus("subagent", `⏳ ${totalTasks} subagents running...`);
					updateWidget();

					const spawnOne = async (t: typeof params.tasks[0], index: number) => {
						if (index > 0) await new Promise((r) => setTimeout(r, 50));

						const entry = taskEntries[index];
						const agent = agents.find((a) => a.name === t.agent);
						if (!agent) {
							entry.icon = "✗";
							pi.sendUserMessage(`[subagent ${t.agent}] ❌ Unknown agent.`, { deliverAs: "followUp" });
							doneCount++;
							if (doneCount >= totalTasks) {
								sessionUi?.setWidget("subagent", undefined);
								sessionUi?.setStatus("subagent", undefined);
							} else {
								updateWidget();
							}
							return;
						}

						const args: string[] = [
							"--mode", "json", "-p", "--no-session",
							"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
						];
						if (agent.model) args.push("--model", agent.model);
						if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

						let tmpPromptDir: string | null = null;
						let tmpPromptPath: string | null = null;
						try {
							if (agent.systemPrompt.trim()) {
								const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
								tmpPromptDir = tmp.dir;
								tmpPromptPath = tmp.filePath;
								args.push("--append-system-prompt", tmpPromptPath);
							}
						} catch { /* ignore */ }

						args.push(`Task: ${t.task}`);
						const invocation = getPiInvocation(args);

						let stdout = "";
						let stderr = "";
						let wasKilled = false;
						let finalized = false;

						const proc = spawn(invocation.command, invocation.args, {
							cwd: t.cwd ?? ctx.cwd,
							shell: false,
							stdio: ["ignore", "pipe", "pipe"],
							env: { ...process.env, PI_OFFLINE: "1" },
						});

						let lastRender = 0;
						proc.stdout.on("data", (data) => {
							stdout += data.toString();
							const lines = stdout.split("\n");
							for (const line of lines.slice(-3)) {
								if (!line) continue;
								try {
									const event = JSON.parse(line);
									if (event.type === "tool_execution_start") {
										const argStr = JSON.stringify(event.args || {}).slice(0, 40);
										entry.activity = `${event.toolName}: ${argStr}`;
									} else if (event.type === "message_update" && event.message?.role === "assistant") {
										for (const part of event.message.content) {
											if (part.type === "text" && part.text) {
												entry.activity = part.text.slice(-60).replace(/\n/g, " ");
												break;
											}
										}
									}
								} catch { /* ignore */ }
							}
							const now = Date.now();
							if (now - lastRender > 100) { updateWidget(); lastRender = now; }
						});
						proc.stderr.on("data", (data) => { stderr += data.toString(); });

						const finalize = () => {
							if (finalized) return;
							finalized = true;
							if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
							if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
							doneCount++;
							if (doneCount >= totalTasks) {
								sessionUi?.setWidget("subagent", undefined);
								sessionUi?.setStatus("subagent", undefined);
							} else {
								updateWidget();
							}
						};

						proc.on("close", (code) => {
							if (wasKilled) { finalize(); return; }
							const lines = stdout.split("\n").filter(Boolean);
							const parsed: Message[] = [];
							for (const line of lines) {
								try {
									const event = JSON.parse(line);
									if ((event.type === "message_end" || event.type === "tool_result_end") && event.message)
										parsed.push(event.message as Message);
								} catch { /* ignore */ }
							}

							let output = "";
							for (let i = parsed.length - 1; i >= 0; i--) {
								if (parsed[i].role === "assistant") {
									for (const part of parsed[i].content) {
										if (part.type === "text") { output = part.text; break; }
									}
									if (output) break;
								}
							}

							const status = code === 0 ? "✅" : "❌";
							const resultText = output || stderr || "(无输出)";
							entry.icon = code === 0 ? "✓" : "✗";
							pi.sendUserMessage(
								`[subagent ${t.agent}] ${status} 完成:\n\n${resultText}`,
								{ deliverAs: "followUp" },
							);
							finalize();
						});

						proc.on("error", () => {
							pi.sendUserMessage(
								`[subagent ${t.agent}] ❌ 启动失败: ${stderr || "unknown error"}`,
								{ deliverAs: "followUp" },
							);
							finalize();
						});

						if (signal) {
							const killProc = () => {
								wasKilled = true;
								proc.kill("SIGTERM");
								setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
							};
							if (signal.aborted) killProc();
							else signal.addEventListener("abort", killProc, { once: true });
						}
					};

					// Fire-and-forget: don't await
					params.tasks.forEach((t, i) => { spawnOne(t, i); });

					return {
						content: [{ type: "text", text: `✅ ${totalTasks} 个子代理已启动，完成后各自注入结果到会话。` }],
						details: makeDetails("parallel")([]),
						terminate: true,
					};
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				if (params.mode === "async") {
					// Async fire-and-inject: spawn immediately, inject result on completion
					const args: string[] = [
						"--mode", "json", "-p", "--no-session",
						"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
					];
					if (agent.model) args.push("--model", agent.model);
					if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

					let tmpPromptDir: string | null = null;
					let tmpPromptPath: string | null = null;
					try {
						if (agent.systemPrompt.trim()) {
							const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
							tmpPromptDir = tmp.dir;
							tmpPromptPath = tmp.filePath;
							args.push("--append-system-prompt", tmpPromptPath);
						}
					} catch { /* ignore */ }

					args.push(`Task: ${params.task}`);
					const invocation = getPiInvocation(args);

					let stdout = "";
					let stderr = "";
					let wasKilled = false;
					let lastProgressText = "";
					let lastToolCallKey = "";
					let parsedIndex = 0;
					const toolLines: string[] = [];
					let latestText = "";
					const startTime = Date.now();

					sessionUi?.setStatus("subagent", `⏳ ${params.agent} 运行中...`);

					const proc = spawn(invocation.command, invocation.args, {
						cwd: params.cwd ?? ctx.cwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
						env: { ...process.env, PI_OFFLINE: "1" },
					});

					proc.stdout.on("data", (data) => {
						stdout += data.toString();
						const allLines = stdout.split("\n");
						const newLines = allLines.slice(parsedIndex);
						parsedIndex = allLines.length - 1;

						for (const line of newLines) {
							if (!line) continue;
							try {
								const event = JSON.parse(line);
								if (event.type === "tool_execution_start") {
									const key = event.toolCallId || JSON.stringify(event.args);
									if (key === lastToolCallKey) continue;
									lastToolCallKey = key;
									const argStr = JSON.stringify(event.args || {}).slice(0, 50);
									toolLines.push(`→ ${event.toolName}: ${argStr}`);
								} else if (event.type === "message_update" && event.message?.role === "assistant") {
									for (const part of event.message.content) {
										if (part.type === "text" && part.text && part.text !== lastProgressText) {
											lastProgressText = part.text;
											const trimmed = part.text.replace(/\n/g, " ").slice(-80);
											latestText = `...${trimmed}`;
											break;
										}
									}
								}
							} catch { /* ignore */ }
						}

						sessionUi?.setWidget("subagent", (_tui, theme) => {
							const elapsed = Math.floor((Date.now() - startTime) / 1000);
							const box = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));

							box.addChild(new Text(theme.fg("toolTitle", theme.bold(` ⏳ ${params.agent} [${elapsed}s] `)), 0, 0));
							for (const tl of toolLines.slice(-3)) {
								const m = tl.match(/^→ (\w+): (.+)$/);
								box.addChild(new Text(
									m
										? theme.fg("muted", "  → ") + theme.fg("accent", m[1]) + theme.fg("dim", ` ${m[2]}`)
										: theme.fg("dim", `  ${tl}`),
									0, 0));
							}
							if (latestText) {
								box.addChild(new Text(theme.fg("muted", "  ──────────"), 0, 0));
								box.addChild(new Text(theme.fg("toolOutput", ` ${latestText} `), 0, 0));
							}
							return box;
						});
					});
					proc.stderr.on("data", (data) => { stderr += data.toString(); });

					proc.on("close", (code) => {
						sessionUi?.setWidget("subagent", undefined);
						sessionUi?.setStatus("subagent", undefined);
						if (wasKilled) return;
						const lines = stdout.split("\n").filter(Boolean);
						const parsed: Message[] = [];
						for (const line of lines) {
							try {
								const event = JSON.parse(line);
								if ((event.type === "message_end" || event.type === "tool_result_end") && event.message)
									parsed.push(event.message as Message);
							} catch { /* ignore */ }
						}

						let output = "";
						for (let i = parsed.length - 1; i >= 0; i--) {
							if (parsed[i].role === "assistant") {
								for (const part of parsed[i].content) {
									if (part.type === "text") { output = part.text; break; }
								}
								if (output) break;
							}
						}

						const status = code === 0 ? "✅" : "❌";
						const resultText = output || stderr || "(无输出)";
						pi.sendUserMessage(
							`[subagent ${params.agent}] ${status} 完成:\n\n${resultText}`,
							{ deliverAs: "followUp" },
						);

						if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
						if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
					});

					proc.on("error", () => {
						sessionUi?.setWidget("subagent", undefined);
						sessionUi?.setStatus("subagent", undefined);
						pi.sendUserMessage(
							`[subagent ${params.agent}] ❌ 启动失败: ${stderr || "unknown error"}`,
							{ deliverAs: "followUp" },
						);
					});

					if (signal) {
						const killProc = () => {
							wasKilled = true;
							proc.kill("SIGTERM");
							setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
						};
						if (signal.aborted) killProc();
						else signal.addEventListener("abort", killProc, { once: true });
					}

					return {
						content: [{ type: "text", text: `✅ 子代理 "${params.agent}" 已启动，完成后自动注入结果到会话。` }],
						details: makeDetails("single")([{
							agent: params.agent,
							agentSource: agent.source,
							task: params.task,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						}]),
						terminate: true,
					};
				}

				// Sync mode: await with timeout
				const result = await Promise.race([
					runSingleAgent(
						ctx.cwd, agents, params.agent, params.task, params.cwd,
						undefined, signal, onUpdate, makeDetails("single"),
					),
					new Promise<SingleResult>((resolve) =>
						setTimeout(() => resolve({
							agent: params.agent,
							agentSource: "unknown",
							task: params.task,
							exitCode: 1,
							messages: [],
							stderr: `Sync execution timed out after ${SYNC_TIMEOUT_MS / 1000}s.`,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							stopReason: "timeout",
						}), SYNC_TIMEOUT_MS)
					),
				]);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, context) {
			const cache = context.state as { key?: string; lines?: string[]; width?: number };
			const scope: AgentScope = args.agentScope ?? "user";
			const key = JSON.stringify(args);

			return {
				invalidate() { cache.width = undefined; cache.lines = undefined; cache.key = undefined; },
				render(width: number): string[] {
					if (cache.key === key && cache.width === width && cache.lines) return cache.lines;
					const out: string[] = [];

					if (args.chain && args.chain.length > 0) {
						out.push(truncateToWidth(
							theme.fg("toolTitle", theme.bold("subagent ")) +
							theme.fg("accent", `chain (${args.chain.length} steps)`) +
							theme.fg("muted", ` [${scope}]`), width, "..."));
						for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
							const step = args.chain[i];
							const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
							const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
							out.push(truncateToWidth(
								`  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("dim", preview)}`,
								width, "..."));
						}
						if (args.chain.length > 3)
							out.push(truncateToWidth(theme.fg("muted", `  ... +${args.chain.length - 3} more`), width, "..."));
					} else if (args.tasks && args.tasks.length > 0) {
						const modeLabel = args.mode === "async" ? " 🔥" : "";
						out.push(truncateToWidth(
							theme.fg("toolTitle", theme.bold("subagent ")) +
							theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
							theme.fg("muted", ` [${scope}]${modeLabel}`), width, "..."));
						for (const t of args.tasks.slice(0, 3)) {
							const preview = t.task?.length > 40 ? `${t.task.slice(0, 40)}...` : (t.task || theme.fg("dim", "..."));
							out.push(truncateToWidth(`  ${theme.fg("accent", t.agent || "?")} ${theme.fg("dim", preview)}`, width, "..."));
						}
						if (args.tasks.length > 3)
							out.push(truncateToWidth(theme.fg("muted", `  ... +${args.tasks.length - 3} more`), width, "..."));
					} else {
						const agentName = args.agent || "...";
						const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
						const modeLabel = args.mode === "async" ? " 🔥" : "";
						out.push(truncateToWidth(
							theme.fg("toolTitle", theme.bold("subagent ")) +
							theme.fg("accent", agentName) +
							theme.fg("muted", ` [${scope}]${modeLabel}`), width, "..."));
						out.push(truncateToWidth(`  ${theme.fg("dim", preview)}`, width, "..."));
					}

					cache.key = key; cache.width = width; cache.lines = out;
					return out;
				},
			};
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			const cache: { key?: string; width?: number; lines?: string[] } = {};
			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			const key = JSON.stringify({ expanded, mode: details?.mode, rlen: details?.results?.length ?? 0 });

			return {
				invalidate() { cache.width = undefined; cache.lines = undefined; cache.key = undefined; },
				render(width: number): string[] {
					if (cache.key === key && cache.width === width && cache.lines) return cache.lines;
					const out: string[] = [];

					if (!details?.results?.length) {
						const t = result.content[0];
						out.push(truncateToWidth(t?.type === "text" ? t.text : "(no output)", width, "..."));
					} else if (details.mode === "single" && details.results.length === 1) {
						const r = details.results[0];
						const isRunning = r.exitCode === -1;
						const isError = isFailedResult(r);
						const icon = isRunning ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

						if (isRunning) {
							out.push(truncateToWidth(
								`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)} ${theme.fg("warning", "[running...]")}`,
								width, "..."));
						} else {
							const displayItems = getDisplayItems(r.messages);
							const finalOutput = getFinalOutput(r.messages);
							let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
							if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
							out.push(truncateToWidth(header, width, "..."));

							if (isError && r.errorMessage)
								out.push(truncateToWidth(theme.fg("error", `Error: ${r.errorMessage}`), width, "..."));

							if (expanded) {
								out.push(truncateToWidth(theme.fg("muted", "─── Task ───"), width, "..."));
								out.push(truncateToWidth(theme.fg("dim", r.task), width, "..."));
								out.push(truncateToWidth(theme.fg("muted", "─── Output ───"), width, "..."));
								if (displayItems.length === 0 && !finalOutput) {
									out.push(truncateToWidth(theme.fg("muted", "(no output)"), width, "..."));
								} else {
									for (const item of displayItems) {
										if (item.type === "toolCall")
											out.push(truncateToWidth(
												theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
												width, "..."));
									}
									if (finalOutput) {
										out.push("");
										out.push(...new Markdown(finalOutput.trim(), 0, 0, mdTheme).render(width));
									}
								}
							} else {
								if (displayItems.length === 0)
									out.push(truncateToWidth(theme.fg("muted", "(no output)"), width, "..."));
								else
									for (const line of renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT).split("\n"))
										out.push(truncateToWidth(line, width, "..."));
							}

							const usageStr = formatUsageStats(r.usage, r.model);
							const hint = expanded ? "" : `  ${keyHint("app.tools.expand", "expand for full output")}`;
							out.push(truncateToWidth(`${usageStr ? theme.fg("dim", usageStr) : ""}${hint}`, width, "..."));
						}

					// Chain mode
					} else if (details.mode === "chain") {
						const successCount = details.results.filter((r) => r.exitCode === 0).length;
						const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

						if (expanded) {
							out.push(truncateToWidth(
								`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`,
								width, "..."));
							for (const r of details.results) {
								const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
								const displayItems = getDisplayItems(r.messages);
								const finalOutput = getFinalOutput(r.messages);
								out.push("");
								out.push(truncateToWidth(
									`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`, width, "..."));
								out.push(truncateToWidth(`${theme.fg("muted", "Task: ")}${theme.fg("dim", r.task)}`, width, "..."));
								for (const item of displayItems) {
									if (item.type === "toolCall")
										out.push(truncateToWidth(
											theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											width, "..."));
								}
								if (finalOutput) {
									out.push("");
									out.push(...new Markdown(finalOutput.trim(), 0, 0, mdTheme).render(width));
								}
								const stepUsage = formatUsageStats(r.usage, r.model);
								if (stepUsage)
									out.push(truncateToWidth(theme.fg("dim", stepUsage), width, "..."));
							}
							const totalUsage = formatUsageStats(aggregateUsage(details.results));
							if (totalUsage) {
								out.push("");
								out.push(truncateToWidth(theme.fg("dim", `Total: ${totalUsage}`), width, "..."));
							}
						} else {
							out.push(truncateToWidth(
								`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`,
								width, "..."));
							for (const r of details.results) {
								const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
								const displayItems = getDisplayItems(r.messages);
								out.push("");
								out.push(truncateToWidth(
									`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`,
									width, "..."));
								if (displayItems.length === 0)
									out.push(truncateToWidth(theme.fg("muted", "(no output)"), width, "..."));
								else
									for (const line of renderDisplayItems(displayItems, 5).split("\n"))
										out.push(truncateToWidth(line, width, "..."));
							}
							const totalUsage = formatUsageStats(aggregateUsage(details.results));
							const hint = keyHint("app.tools.expand", "expand for full output");
							out.push(truncateToWidth(
								`${totalUsage ? theme.fg("dim", `Total: ${totalUsage}`) : ""}  ${theme.fg("muted", hint)}`,
								width, "..."));
						}

					// Parallel mode
					} else if (details.mode === "parallel") {
						const running = details.results.filter((r) => r.exitCode === -1).length;
						const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
						const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
						const isRunningMode = running > 0;
						const icon = isRunningMode ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
						const status = isRunningMode
							? `${successCount + failCount}/${details.results.length} done, ${running} running`
							: `${successCount}/${details.results.length} tasks`;

						if (expanded && !isRunningMode) {
							out.push(truncateToWidth(
								`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, width, "..."));
							for (const r of details.results) {
								const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
								const displayItems = getDisplayItems(r.messages);
								const finalOutput = getFinalOutput(r.messages);
								out.push("");
								out.push(truncateToWidth(
									`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, width, "..."));
								out.push(truncateToWidth(`${theme.fg("muted", "Task: ")}${theme.fg("dim", r.task)}`, width, "..."));
								for (const item of displayItems) {
									if (item.type === "toolCall")
										out.push(truncateToWidth(
											theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											width, "..."));
								}
								if (finalOutput) {
									out.push("");
									out.push(...new Markdown(finalOutput.trim(), 0, 0, mdTheme).render(width));
								}
								const taskUsage = formatUsageStats(r.usage, r.model);
								if (taskUsage)
									out.push(truncateToWidth(theme.fg("dim", taskUsage), width, "..."));
							}
							const totalUsage = formatUsageStats(aggregateUsage(details.results));
							if (totalUsage) {
								out.push("");
								out.push(truncateToWidth(theme.fg("dim", `Total: ${totalUsage}`), width, "..."));
							}
						} else {
							out.push(truncateToWidth(
								`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
								width, "..."));
							for (const r of details.results) {
								const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
								const displayItems = getDisplayItems(r.messages);
								out.push("");
								out.push(truncateToWidth(
									`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
									width, "..."));
								if (displayItems.length === 0)
									out.push(truncateToWidth(
										theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)"),
										width, "..."));
								else
									for (const line of renderDisplayItems(displayItems, 5).split("\n"))
										out.push(truncateToWidth(line, width, "..."));
							}
							if (!isRunningMode) {
								const totalUsage = formatUsageStats(aggregateUsage(details.results));
								const hint = keyHint("app.tools.expand", "expand for full output");
								out.push(truncateToWidth(
									`${totalUsage ? theme.fg("dim", `Total: ${totalUsage}`) : ""}  ${theme.fg("muted", hint)}`,
									width, "..."));
							} else {
								out.push(truncateToWidth(
									theme.fg("muted", keyHint("app.tools.expand", "expand for full output")),
									width, "..."));
							}
						}
					}

					cache.key = key; cache.width = width; cache.lines = out;
					return out;
				},
			};
		},
	});

}
