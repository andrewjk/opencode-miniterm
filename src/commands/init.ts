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

	// The response to "msg_init" will contain the init text, which we will run
	const result = await state.client.session.init({
		path: { id: config.sessionIDs[cwd] },
		body: {
			modelID: config.modelID,
			providerID: config.providerID,
			messageID: "msg_init"
		}
	});

	// It always returns an error?!
	//if (result.error) {
	//	throw new Error(
	//		`Failed to run /init (${result.response.status}): ${JSON.stringify(result.error)}`,
	//	);
	//}
}
