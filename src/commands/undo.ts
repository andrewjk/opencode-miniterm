import { config } from "../config";
import type { Command, State } from "../types";

let command: Command = {
	name: "/undo",
	description: "Undo changes for the last request",
	run,
	running: false,
};

export default command;

async function run(state: State): Promise<void> {
	const cwd = process.cwd();
	if (!config.sessionIDs[cwd]) return;

	console.log("Fetching session messages...");

	const sessionID = config.sessionIDs[cwd]!;
	const messagesRes = await state.client.message.list({ sessionID, order: "desc" });

	const messages = messagesRes.data;

	if (!messages || messages.length === 0) {
		console.log("No messages to undo.\n");
		return;
	}

	const lastMessage = messages.find((m) => m.type === "assistant");

	if (!lastMessage) {
		console.log("Last message is not an AI response, nothing to undo.\n");
		return;
	}

	console.log(`Reverting last assistant message (${lastMessage.id})...`);

	await state.client.session.revert.stage({
		sessionID: config.sessionIDs[process.cwd()]!,
		messageID: lastMessage.id,
	});

	console.log("Successfully reverted last message.\n");
}
