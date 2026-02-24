import type { OpencodeClient } from "@opencode-ai/sdk";
import { config, saveConfig } from "../config";
import type { State } from "../index";
import { getActiveDisplay } from "../render";
import type { Command } from "../types";

let command: Command = {
	name: "/new",
	description: "Create a new session",
	run,
	running: false,
};

export default command;

async function run(client: OpencodeClient, state: State) {
	state.sessionId = await createSession(client);
	config.sessionID = state.sessionId;
	saveConfig();

	const activeDisplay = await getActiveDisplay(client);
	console.log(activeDisplay);
	console.log(`Created new session`);
	console.log();
}

async function createSession(client: OpencodeClient): Promise<string> {
	const result = await client.session.create({
		body: {},
	});

	if (result.error) {
		throw new Error(
			`Failed to create session (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	return result.data.id;
}
