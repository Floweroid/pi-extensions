import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

export interface SubagentHistoryRecord {
	agent: string;
	agentSource: string;
	model?: string;
	task: string;
	cwd: string;
	startTime: string;
	endTime: string;
	durationMs: number;
	exitCode: number;
	hasToolErrors: boolean;
	toolErrors: Array<{ toolName: string; error: string }>;
	output: string;
	stderr: string;
	messages: Message[];
	rawStdout: string;
}

/**
 * Save subagent execution history to disk.
 * Creates: <projectRoot>/.pi/subagent-logs/<timestamp>-<agent>/
 *   metadata.json  → execution metadata
 *   messages.json  → full conversation messages
 *   stdout.txt     → raw process stdout
 *   stderr.txt     → raw process stderr
 */
export function saveSubagentHistory(
	record: SubagentHistoryRecord,
	projectRoot: string,
): void {
	try {
		const safeTimestamp = record.startTime.replace(/[:.]/g, "-");
		const dirName = `${safeTimestamp}-${record.agent}`;
		const logDir = path.join(projectRoot, ".pi", "subagent-logs", dirName);
		fs.mkdirSync(logDir, { recursive: true });

		// metadata.json
		const metadata = {
			agent: record.agent,
			agentSource: record.agentSource,
			model: record.model,
			task: record.task,
			cwd: record.cwd,
			startTime: record.startTime,
			endTime: record.endTime,
			durationMs: record.durationMs,
			exitCode: record.exitCode,
			hasToolErrors: record.hasToolErrors,
			toolErrors: record.toolErrors,
			output: record.output,
		};
		fs.writeFileSync(
			path.join(logDir, "metadata.json"),
			JSON.stringify(metadata, null, 2),
			"utf-8",
		);

		// messages.json
		fs.writeFileSync(
			path.join(logDir, "messages.json"),
			JSON.stringify(record.messages, null, 2),
			"utf-8",
		);

		// stdout.txt
		fs.writeFileSync(path.join(logDir, "stdout.txt"), record.rawStdout, "utf-8");

		// stderr.txt
		if (record.stderr) {
			fs.writeFileSync(path.join(logDir, "stderr.txt"), record.stderr, "utf-8");
		}
	} catch {
		// Silent - don't disrupt the main flow
	}
}
