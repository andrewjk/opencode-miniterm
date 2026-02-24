import type { OpencodeClient } from "@opencode-ai/sdk";
import type { State } from "../index";
import { render } from "../render";
import type { Command } from "../types";

let command: Command = {
	name: "/details",
	description: "Show all parts from the last request",
	run,
	running: false,
};

export default command;

function run(client: OpencodeClient, state: State): void {
	render(state, true);
}
