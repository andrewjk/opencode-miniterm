import type { OpencodeClient } from "@opencode-ai/sdk";
import { config, saveConfig } from "../config";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/log",
	description: "Toggle logging of parts to file",
	run,
	running: false,
};

export default command;

export function isLoggingEnabled(): boolean {
	return config.loggingEnabled;
}

function run(_client: OpencodeClient, _state: State): void {
	config.loggingEnabled = !config.loggingEnabled;
	saveConfig();
	const status = config.loggingEnabled ? "enabled" : "disabled";
	console.log(`📝 Logging ${status}\n`);
}
