import type { OpencodeClient } from "@opencode-ai/sdk";
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
	console.log(`\x1b[90mGoodbye!\x1b[0m`);
	process.exit(0);
}
