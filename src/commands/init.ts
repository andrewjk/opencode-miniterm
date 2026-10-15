import * as ansi from "../ansi";
import { config } from "../config";
import type { Command, State } from "../types";

let command: Command = {
	name: "/init",
	description: "Analyze project and create/update AGENTS.md",
	run,
	running: false,
};

export default command;

async function run(state: State): Promise<void> {
	const cwd = process.cwd();
	if (!config.sessionIDs[cwd]) return;

	try {
		await state.client.session.command({
			sessionID: state.sessionID,
			name: "init",
			text: "",
		});
	} catch (error) {
		console.error(
			`${ansi.RED}Failed to run /init:${ansi.RESET}`,
			error instanceof Error ? error.message : String(error),
		);
	}
}
