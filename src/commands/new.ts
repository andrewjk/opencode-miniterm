import { config, saveConfig } from "../config";
import { getActiveDisplay, updateSessionTitle } from "../render";
import type { Command, State } from "../types";

let command: Command = {
	name: "/new",
	description: "Create a new session",
	run,
	running: false,
};

export default command;

async function run(state: State): Promise<void> {
	state.sessionID = await createSession(state);
	config.sessionIDs[process.cwd()] = state.sessionID;
	saveConfig();

	await updateSessionTitle(state);

	const activeDisplay = await getActiveDisplay(state.client);
	console.log(activeDisplay);
	console.log(`Created new session`);
	console.log();
}

async function createSession(state: State): Promise<string> {
	const result = await state.client.session.create({
		body: {},
	});

	if (result.error) {
		throw new Error(
			`Failed to create session (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	return result.data.id;
}
