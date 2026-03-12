import { config, saveConfig } from "../config";
import type { Command, State } from "../types";

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

export function getLogDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	return `${homeDir}/.local/share/opencode-miniterm/log`;
}

function run(_state: State): void {
	config.loggingEnabled = !config.loggingEnabled;
	saveConfig();
	const status = config.loggingEnabled ? "enabled" : "disabled";
	console.log(`📝 Logging ${status}\n`);
}
