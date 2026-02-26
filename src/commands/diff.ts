import type { OpencodeClient } from "@opencode-ai/sdk";
import { config } from "../config";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/diff",
	description: "Show file additions and deletions",
	run,
	running: false,
};

export default command;

interface DiffLine {
	type: "add" | "remove" | "same";
	line: string;
	oldIndex?: number;
	newIndex?: number;
}

async function run(client: OpencodeClient, state: State): Promise<void> {
	const cwd = process.cwd();
	if (!config.sessionIDs[cwd]) {
		console.log("No active session.\n");
		return;
	}

	console.log("Fetching file changes...");

	const result = await client.session.diff({
		path: { id: config.sessionIDs[cwd] },
	});

	if (result.error) {
		throw new Error(
			`Failed to fetch diff (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	const allDiffs = result.data;

	if (!allDiffs || allDiffs.length === 0) {
		console.log("No file changes found.\n");
		return;
	}

	for (const file of allDiffs) {
		console.log(`\x1b[36;1m${file.file}\x1b[0m`);

		if (!file.before && file.after) {
			console.log(`\x1b[32m+ new file\x1b[0m\n`);
			const lines = file.after.split("\n");
			for (let i = 0; i < lines.length; i++) {
				console.log(`\x1b[90m${i + 1}\x1b[0m \x1b[32m+ ${lines[i]!}\x1b[0m`);
			}
			console.log();
			continue;
		}

		if (file.before && !file.after) {
			console.log(`\x1b[31m- deleted file\x1b[0m\n`);
			const lines = file.before.split("\n");
			for (let i = 0; i < lines.length; i++) {
				console.log(`\x1b[90m${i + 1}\x1b[0m \x1b[31m- ${lines[i]!}\x1b[0m`);
			}
			console.log();
			continue;
		}

		if (file.before && file.after) {
			const diff = computeDiff(file.before, file.after);
			for (const diffLine of diff) {
				if (diffLine.type === "add") {
					console.log(`\x1b[90m${diffLine.newIndex! + 1}\x1b[0m \x1b[32m+ ${diffLine.line}\x1b[0m`);
				} else if (diffLine.type === "remove") {
					console.log(`\x1b[90m${diffLine.oldIndex! + 1}\x1b[0m \x1b[31m- ${diffLine.line}\x1b[0m`);
				}
			}
			console.log();
		}
	}
}

function computeDiff(before: string, after: string): DiffLine[] {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");

	const lcs = computeLCS(beforeLines, afterLines);

	const result: DiffLine[] = [];
	let oldIdx = 0;
	let newIdx = 0;

	for (const lcsItem of lcs) {
		while (oldIdx < lcsItem.oldIndex!) {
			result.push({ type: "remove", line: beforeLines[oldIdx]!, oldIndex: oldIdx });
			oldIdx++;
		}
		while (newIdx < lcsItem.newIndex!) {
			result.push({ type: "add", line: afterLines[newIdx]!, newIndex: newIdx });
			newIdx++;
		}
		result.push(lcsItem);
		oldIdx++;
		newIdx++;
	}

	while (oldIdx < beforeLines.length) {
		result.push({ type: "remove", line: beforeLines[oldIdx]!, oldIndex: oldIdx });
		oldIdx++;
	}
	while (newIdx < afterLines.length) {
		result.push({ type: "add", line: afterLines[newIdx]!, newIndex: newIdx });
		newIdx++;
	}

	return result;
}

function computeLCS(beforeLines: string[], afterLines: string[]): DiffLine[] {
	const m = beforeLines.length;
	const n = afterLines.length;

	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (beforeLines[i - 1] === afterLines[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	const result: DiffLine[] = [];
	let i = m;
	let j = n;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
			result.unshift({ type: "same", line: beforeLines[i - 1]!, oldIndex: i - 1, newIndex: j - 1 });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i]![j]! === dp[i]![j - 1]!)) {
			result.unshift({ type: "add", line: afterLines[j - 1]!, newIndex: j - 1 });
			j--;
		} else if (i > 0) {
			result.unshift({ type: "remove", line: beforeLines[i - 1]!, oldIndex: i - 1 });
			i--;
		}
	}

	return result;
}
