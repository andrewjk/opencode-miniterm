import type { Command, State } from "../types";

let command: Command = {
	name: "/exit",
	description: "Exit the application",
	run,
	running: false,
};

export default command;

async function run(state: State): Promise<void> {
	state.shutdown();
}
