import type { OpencodeClient } from "@opencode-ai/sdk";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/log",
	description: "Toggle logging of parts to file",
	run,
	running: false,
};

export default command;

let loggingEnabled = false;

export function isLoggingEnabled(): boolean {
	return loggingEnabled;
}

export function setLogging(enabled: boolean): void {
	loggingEnabled = enabled;
}

function run(_client: OpencodeClient, _state: State): void {
	loggingEnabled = !loggingEnabled;
	const status = loggingEnabled ? "enabled" : "disabled";
	console.log(`📝 Logging ${status}\n`);
}
