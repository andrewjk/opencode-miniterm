import { config, saveConfig } from "../config";
import type { Command, State } from "../types";

let command: Command = {
	name: "/log",
	description: "Toggle logging of parts to file",
	run,
	running: false,
};

export default command;

function run(_state: State): void {
	config.loggingEnabled = !config.loggingEnabled;
	saveConfig();
	const status = config.loggingEnabled ? "enabled" : "disabled";
	console.log(`📝 Logging ${status}\n`);
}
