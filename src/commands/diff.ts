import { config } from "../config";
import type { Command, State } from "../types";

let command: Command = {
	name: "/diff",
	description: "Show file additions and deletions",
	run,
	running: false,
};

export default command;

async function run(state: State): Promise<void> {
	const cwd = process.cwd();
	if (!config.sessionIDs[cwd]) {
		console.log("No active session.\n");
		return;
	}

	console.log("Fetching file changes...");

	const allDiffs = await state.client.session.diff({
		sessionID: config.sessionIDs[cwd]!,
	});

	if (!allDiffs || allDiffs.length === 0) {
		console.log("No file changes found.\n");
		return;
	}

	for (const file of allDiffs) {
		console.log(`\x1b[36;1m${file.file}\x1b[0m`);

		const stats = [
			file.additions > 0 ? `\x1b[32m+${file.additions}\x1b[0m` : "",
			file.deletions > 0 ? `\x1b[31m-${file.deletions}\x1b[0m` : "",
		]
			.filter(Boolean)
			.join(" ");
		if (stats) console.log(`  ${stats}`);

		for (const line of (file.patch || "").split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) {
				console.log(`\x1b[90m${line}\x1b[0m`);
			} else if (line.startsWith("+")) {
				console.log(`\x1b[32m${line}\x1b[0m`);
			} else if (line.startsWith("-")) {
				console.log(`\x1b[31m${line}\x1b[0m`);
			} else if (line.startsWith("@@")) {
				console.log(`\x1b[36m${line}\x1b[0m`);
			} else {
				console.log(`\x1b[90m${line}\x1b[0m`);
			}
		}
		console.log();
	}
}
