import type { OpencodeClient } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/run",
	description: "Run a shell command (e.g. `/run git status`)",
	run,
	running: false,
};

export default command;

async function run(_client: OpencodeClient, _state: State, input?: string) {
	if (!input) return;

	const child = spawn(input, [], { shell: true });
	child.stdout?.on("data", (data) => {
		process.stdout.write(data.toString());
	});
	child.stderr?.on("data", (data) => {
		process.stderr.write(data.toString());
	});
	await new Promise<void>((resolve) => {
		child.on("close", (code) => {
			if (code !== 0) {
				console.log(`\x1b[90mCommand exited with code ${code}\x1b[0m`);
			}
			console.log();
			resolve();
		});
	});
}
