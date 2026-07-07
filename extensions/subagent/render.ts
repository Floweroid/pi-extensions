/**
 * Subagent Render — TUI components for subagent tool call inline rendering
 *
 * Renders the inline subagent widget (agent icon + task preview in
 * chain/parallel/single modes, and completion status + tool execution summary).
 *
 * Key details:
 *   - renderCall: shows agent name, task preview, scope
 *   - renderResult: shows completion icon, duration, tool execution summary
 *   - truncateToWidth prevents TUI overflow on long lines
 *   - cache (hasToolErrors, resultCache, summary) avoids redundant reconstitution
 */

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentDetails } from "./types.ts";
import { COLLAPSED_ITEM_COUNT, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput, getResultOutput, isFailedResult } from "./utils.ts";

export function renderCall(args, theme, context) {
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
							const cleanTask = (step.task || "").replace(/\{previous\}/g, "").trim();
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
		}

export function renderResult(result, { expanded, isPartial }, theme, _context) {
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

			return {
				invalidate() { cache.width = undefined; cache.lines = undefined; cache.key = undefined; },
				render(width: number): string[] {
					const key = JSON.stringify({ expanded, isPartial, mode: details?.mode, rlen: details?.results?.length ?? 0, states: details?.results?.map(r => r.exitCode) });
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
								const box = new Box(0, 1, (text: string) => theme.bg(isFailedResult(r) ? "toolErrorBg" : "toolSuccessBg", text));
								box.addChild(new Text(
									`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
								box.addChild(new Text(
									`${theme.fg("muted", "Task: ")}${theme.fg("dim", r.task)}`, 0, 0));
								for (const item of displayItems) {
									if (item.type === "toolCall")
										box.addChild(new Text(
											theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											0, 0));
								}
								if (finalOutput) {
									const mdLines = new Markdown(finalOutput.trim(), 0, 0, mdTheme).render(width - 4);
									if (mdLines.length > 0) {
										box.addChild(new Text("", 0, 0));
										for (const line of mdLines)
											box.addChild(new Text(line, 0, 0));
									}
								}
								const taskUsage = formatUsageStats(r.usage, r.model);
								if (taskUsage)
									box.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
								out.push("");
								out.push(...box.render(width));
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
								const box = new Box(0, 1, (text: string) => theme.bg(r.exitCode === -1 ? "toolPendingBg" : isFailedResult(r) ? "toolErrorBg" : "toolSuccessBg", text));
								box.addChild(new Text(
									`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
								if (displayItems.length === 0)
									box.addChild(new Text(
										theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)"), 0, 0));
								else
									for (const line of renderDisplayItems(displayItems, 5).split("\n"))
										box.addChild(new Text(line, 0, 0));
								out.push("");
								out.push(...box.render(width));
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
		}
