import type { OpencodeClient } from "@opencode-ai/sdk";
import { config, saveConfig } from "../config";
import type { State } from "../index";
import { writePrompt } from "../render";
import type { Command } from "../types";

let command: Command = {
	name: "/init",
	description: "Analyze project and create/update AGENTS.md",
	run,
	running: false,
};

export default command;

async function run(_client: OpencodeClient, _state: State): Promise<void> {
	if (!config.sessionID) return;

	console.log("Running /init command (analyzing project and creating AGENTS.md)...");
	const result = await _client.session.init({
		path: { id: config.sessionID },
	});

	if (result.error) {
		throw new Error(
			`Failed to run /init (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	console.log();
	console.log(
		result.data ? "AGENTS.md created/updated successfully." : "No changes made to AGENTS.md.",
	);
	console.log();
}
