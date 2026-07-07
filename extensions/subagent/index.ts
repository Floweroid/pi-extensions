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
import { StringEnum, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";


import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { saveSubagentHistory } from "./history.ts";
import { renderCall, renderResult } from "./render.ts";
import { runSingleAgent } from "./runner.ts";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.ts";
import {
    COLLAPSED_ITEM_COUNT,
    MAX_CONCURRENCY,
    MAX_PARALLEL_TASKS,
    PER_TASK_OUTPUT_CAP,
    SYNC_TIMEOUT_MS,
    formatUsageStats,
    getDisplayItems,
    getFinalOutput,
    getPiInvocation,
    getResultOutput,
    isFailedResult,
    mapWithConcurrencyLimit,
    writePromptToTempFile,
} from "./utils.ts";

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
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
	let sessionCwd: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		sessionUi = ctx.ui;
		sessionCwd = ctx.cwd;
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
const widgetId = `subagent-${Date.now()}`;
					let doneCount = 0;
					const totalTasks = params.tasks.length;
					const taskEntries = params.tasks.map((t) => ({
						agent: t.agent,
						summary: (t.task.length > 40 ? t.task.slice(0, 40) + "..." : t.task),
						icon: "→" as string,
						activity: "" as string,
					}));

					const updateWidget = () => {
						sessionUi?.setWidget(widgetId, (_tui, theme) => {
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

					sessionUi?.setStatus(widgetId, `⏳ ${totalTasks} subagents running...`);
					updateWidget();

					const spawnOne = async (t: typeof params.tasks[0], index: number) => {
						const startTimeMs = Date.now();
						const startTime = new Date().toISOString();
						if (index > 0) await new Promise((r) => setTimeout(r, 50));

						const entry = taskEntries[index];
						const agent = agents.find((a) => a.name === t.agent);
						if (!agent) {
							entry.icon = "✗";
							pi.sendUserMessage(`[subagent ${t.agent}] ❌ Unknown agent.`, { deliverAs: "followUp" });
							doneCount++;
							if (doneCount >= totalTasks) {
								sessionUi?.setWidget(widgetId, undefined);
								sessionUi?.setStatus(widgetId, undefined);
							} else {
								updateWidget();
							}
							return;
						}

						const args: string[] = [
							"--mode", "json", "-p", "--no-session",
							"--no-skills", "--no-prompt-templates", "--no-context-files",
						];
						if (!(agent.tools && agent.tools.length > 0)) args.push("--no-extensions");
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
							cwd: t.cwd ?? sessionCwd,
							shell: false,
							stdio: ["ignore", "pipe", "pipe"],
							env: { ...process.env, PI_OFFLINE: "1" },
						});

						let lastParallelStateKey = "";
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
							const stateKey = taskEntries.map(e => `${e.icon}|${e.activity?.slice(-20)}`).join("||");
							if (stateKey !== lastParallelStateKey) {
								lastParallelStateKey = stateKey;
								updateWidget();
							}
						});
						proc.stderr.on("data", (data) => { stderr += data.toString(); });

						const finalize = () => {
							if (finalized) return;
							finalized = true;
							if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
							if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
							doneCount++;
							if (doneCount >= totalTasks) {
								sessionUi?.setWidget(widgetId, undefined);
								sessionUi?.setStatus(widgetId, undefined);
							} else {
								updateWidget();
							}
						};

						proc.on("close", (code) => {
							if (wasKilled) { finalize(); return; }
							const rawStdout = stdout;
							const lines = stdout.split("\n").filter(Boolean);
							const parsedMessages: Message[] = [];
							const toolExecutions: Array<{ 
								toolName: string; 
								args: string; 
								isError: boolean; 
								result: string 
							}> = [];

							for (const line of lines) {
								try {
									const event = JSON.parse(line);
									if ((event.type === "message_end" || event.type === "tool_result_end") && event.message)
										parsedMessages.push(event.message as Message);
									if (event.type === "tool_execution_start") {
										toolExecutions.push({
											toolName: event.toolName,
											args: JSON.stringify(event.args || {}),
											isError: false,
											result: "",
										});
									}
									if (event.type === "tool_execution_end") {
										const last = toolExecutions[toolExecutions.length - 1];
										if (last && last.toolName === event.toolName && !last.result) {
											last.isError = event.isError === true;
											last.result = event.isError
												? (event.result?.content?.[0]?.text || "unknown error")
												: event.result?.content?.[0]?.text || "(done)";
										}
									}
								} catch { /* ignore */ }
							}

							const toolErrors = toolExecutions.filter(e => e.isError);

							let output = "";
							for (let i = parsedMessages.length - 1; i >= 0; i--) {
								if (parsedMessages[i].role === "assistant") {
									for (const part of parsedMessages[i].content) {
										if (part.type === "text") { output = part.text; break; }
									}
									if (output) break;
								}
							}

							const hasToolErrors = toolErrors.length > 0;
							const statusIcon = hasToolErrors ? "⚠️" : code === 0 ? "✅" : "❌";
							const statusText = hasToolErrors
								? `完成（${toolErrors.length}/${toolExecutions.length} 工具失败）`
								: `完成（${toolExecutions.length} 工具调用）`;

							let resultText = output || stderr || "(无输出)";
							if (toolExecutions.length > 0) {
								const maxArgs = 60;
								resultText += `\n\n📋 工具执行:\n${toolExecutions.map(e => {
									const argsPreview = e.args.length > maxArgs ? e.args.slice(0, maxArgs) + "..." : e.args;
									const icon = e.isError ? "✗" : "✓";
									return `  ${icon} ${e.toolName} ${argsPreview}${e.isError ? ` → ${e.result}` : ""}`;
								}).join("\n")}`;
							}

							entry.icon = hasToolErrors ? "⚠" : code === 0 ? "✓" : "✗";
							pi.sendUserMessage(
								`[subagent ${t.agent}] ${statusIcon} ${statusText}:\n\n${resultText}`,
								{ deliverAs: "followUp" },
							);

							// Save execution history
							const endTime = new Date().toISOString();
							saveSubagentHistory({
								agent: t.agent,
								agentSource: agent.source,
								model: agent.model,
								task: t.task,
								cwd: t.cwd ?? sessionCwd,
								startTime,
								endTime,
								durationMs: Date.now() - startTimeMs,
								exitCode: code ?? 1,
								hasToolErrors,
								toolErrors,
								output: resultText,
								stderr,
								messages: parsedMessages,
								rawStdout,
							}, sessionCwd);

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
					const widgetId = `subagent-${Date.now()}`;
					// Async fire-and-inject: spawn immediately, inject result on completion
					const args: string[] = [
						"--mode", "json", "-p", "--no-session",
						"--no-skills", "--no-prompt-templates", "--no-context-files",
					];
					if (!(agent.tools && agent.tools.length > 0)) args.push("--no-extensions");
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
					let lastSingleStateKey = "";
					const startTime = Date.now();

					sessionUi?.setStatus(widgetId, `⏳ ${params.agent} 运行中...`);

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

						const stateKey = `${toolLines.length}|${latestText?.slice(-30)||""}`;
						if (stateKey === lastSingleStateKey) return;
						lastSingleStateKey = stateKey;

						sessionUi?.setWidget(widgetId, (_tui, theme) => {
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
						sessionUi?.setWidget(widgetId, undefined);
						sessionUi?.setStatus(widgetId, undefined);
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

						// Save execution history
						try {
							const endTime = new Date().toISOString();
							const agent = agents.find(a => a.name === params.agent);
							const toolExecutions: Array<{ toolName: string; args: string; isError: boolean; result: string }> = [];
							for (const line of lines) {
								try {
									const event = JSON.parse(line);
									if (event.type === "tool_execution_start") {
										toolExecutions.push({
											toolName: event.toolName,
											args: JSON.stringify(event.args || {}),
											isError: false,
											result: "",
										});
									}
									if (event.type === "tool_execution_end") {
										const last = toolExecutions[toolExecutions.length - 1];
										if (last && last.toolName === event.toolName && !last.result) {
											last.isError = event.isError === true;
											last.result = event.isError
												? (event.result?.content?.[0]?.text || "unknown error")
												: event.result?.content?.[0]?.text || "(done)";
										}
									}
								} catch { /* ignore */ }
							}
							const toolErrors = toolExecutions.filter(e => e.isError);
							saveSubagentHistory({
								agent: params.agent,
								agentSource: agent?.source ?? "user",
								model: agent?.model,
								task: params.task,
								cwd: params.cwd ?? sessionCwd ?? process.cwd(),
								startTime: startTime instanceof Date ? startTime.toISOString() : new Date(startTime).toISOString(),
								endTime,
								durationMs: Date.now() - startTime,
								exitCode: code ?? 1,
								hasToolErrors: toolErrors.length > 0,
								toolErrors,
								output: resultText,
								stderr,
								messages: parsed,
								rawStdout: stdout,
							}, sessionCwd ?? process.cwd());
						} catch { /* silent */ }

						if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
						if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
					});

					proc.on("error", () => {
						sessionUi?.setWidget(widgetId, undefined);
						sessionUi?.setStatus(widgetId, undefined);
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

				// Sync mode: await with timeout via AbortController
				const timeoutController = new AbortController();
				const timeoutId = setTimeout(() => timeoutController.abort(new Error("timeout")), SYNC_TIMEOUT_MS);

				// Forward original signal (if any) to timeout controller
				if (signal) {
					if (signal.aborted) {
						clearTimeout(timeoutId);
						timeoutController.abort(signal.reason);
					} else {
						signal.addEventListener("abort", () => {
							clearTimeout(timeoutId);
							timeoutController.abort(signal.reason);
						}, { once: true });
					}
				}

				let result: SingleResult;
				try {
					result = await runSingleAgent(
						ctx.cwd, agents, params.agent, params.task, params.cwd,
						undefined, timeoutController.signal, onUpdate, makeDetails("single"),
					);
					clearTimeout(timeoutId);
				} catch (err: unknown) {
					clearTimeout(timeoutId);
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.includes("aborted") || msg.includes("timeout")) {
						result = {
							agent: params.agent,
							agentSource: "unknown",
							task: params.task,
							exitCode: 1,
							messages: [],
							stderr: `Sync execution timed out after ${SYNC_TIMEOUT_MS / 1000}s.`,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							stopReason: "timeout",
						};
					} else {
						throw err;
					}
				}
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

		renderCall,
		renderResult,
	});

}

