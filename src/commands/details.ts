import { render } from "../render";
import type { Command, State } from "../types";

let command: Command = {
	name: "/details",
	description: "Show all parts from the last request",
	run,
	running: false,
};

export default command;

function run(state: State): void {
	render(state, true);
}
