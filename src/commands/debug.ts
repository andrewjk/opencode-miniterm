import type { OpencodeClient } from "@opencode-ai/sdk";
import type { State } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/debug",
	description: "Show raw events from the last request",
	run,
	running: false,
};

export default command;

function run(_client: OpencodeClient, state: State): void {
	console.log("\n🔧 Debug: All parts from the most recent request");
	console.log("=".repeat(50));

	if (state.allEvents.length === 0) {
		console.log("No parts stored yet. Send a message first.");
	} else {
		for (let part of state.allEvents) {
			stripLongStrings(part);
		}
		console.log(JSON.stringify(state.allEvents, null, 2));
	}

	console.log("\n" + "=".repeat(50));
	console.log();
}

function stripLongStrings(target: Record<PropertyKey, unknown>): void {
	for (const prop in target) {
		if (prop !== "text" && prop !== "delta") {
			const value = target[prop];
			if (typeof value === "string") {
				if (value.length > 255) {
					target[prop] = value.substring(0, 252) + "...";
				}
			} else if (typeof value === "object" && value !== null) {
				stripLongStrings(value as Record<PropertyKey, unknown>);
			}
		}
	}
}
