import type { OpencodeClient } from "@opencode-ai/sdk";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/kill",
	description: "Abort a session (e.g. `/kill ses_123`)",
	run,
	running: false,
};

export default command;

async function run(client: OpencodeClient, _state: State, input?: string): Promise<void> {
	if (!input) {
		console.log("Usage: /kill <session_id>");
		return;
	}

	const result = await client.session.abort({
		path: { id: input },
	});

	if (result.error) {
		throw new Error(
			`Failed to abort session (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	console.log(`Session aborted successfully.`);
	console.log();
}
