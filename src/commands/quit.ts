import * as ansi from "../ansi";
import { saveConfig } from "../config";
import type { Command, State } from "../types";

let command: Command = {
	name: "/quit",
	description: "Exit the application",
	run,
	running: false,
};

export default command;

async function run(state: State): Promise<void> {
	state.shutdown();
}
