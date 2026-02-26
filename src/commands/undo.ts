import type { OpencodeClient } from "@opencode-ai/sdk";
import { config } from "../config";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/undo",
	description: "Undo changes for the last request",
	run,
	running: false,
};

export default command;

async function run(client: OpencodeClient, _state: State): Promise<void> {
	const cwd = process.cwd();
	if (!config.sessionIDs[cwd]) return;

	console.log("Fetching session messages...");

	const messagesRes = await client.session.messages({
		path: { id: config.sessionIDs[cwd] },
	});

	if (messagesRes.error) {
		throw new Error(
			`Failed to fetch messages (${messagesRes.response.status}): ${JSON.stringify(messagesRes.error)}`,
		);
	}

	const messages = messagesRes.data;

	if (!messages || messages.length === 0) {
		console.log("No messages to undo.\n");
		return;
	}

	const lastMessage = messages[messages.length - 1];

	if (!lastMessage || !lastMessage.info) {
		console.log("No valid message to undo.\n");
		return;
	}

	if (lastMessage.info.role !== "assistant") {
		console.log("Last message is not an AI response, nothing to undo.\n");
		return;
	}

	console.log(`Reverting last assistant message (${lastMessage.info.id})...`);

	const revertRes = await client.session.revert({
		path: { id: config.sessionIDs[process.cwd()] },
		body: {
			messageID: lastMessage.info.id,
		},
	});

	if (revertRes.error) {
		throw new Error(
			`Failed to revert message (${revertRes.response.status}): ${JSON.stringify(revertRes.error)}`,
		);
	}

	console.log("Successfully reverted last message.\n");
}
