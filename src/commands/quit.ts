import type { OpencodeClient } from "@opencode-ai/sdk";
import * as ansi from "../ansi";
import { saveConfig } from "../config";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/quit",
	description: "Exit the application",
	run,
	running: false,
};

export default command;

async function run(_client: OpencodeClient, _state: State): Promise<void> {
	if (process.stdin.setRawMode) {
		process.stdin.setRawMode(false);
	}
	process.stdin.destroy();
	process.stdout.write(ansi.ENABLE_LINE_WRAP);
	saveConfig();
	// TODO: server?.close();
	console.log(`${ansi.BRIGHT_BLACK}Goodbye!${ansi.RESET}`);
	process.exit(0);
}
