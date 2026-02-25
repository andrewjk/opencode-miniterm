import type { OpencodeClient } from "@opencode-ai/sdk";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { type State, getLogDir } from "../index";
import type { Command } from "../types";

let command: Command = {
	name: "/debug",
	description: "Save raw events from the last request to a JSON file",
	run,
	running: false,
};

export default command;

function run(_client: OpencodeClient, state: State): void {
	if (state.allEvents.length === 0) {
		console.log("No parts stored yet. Send a message first.");
		return;
	}

	// Create a copy of events to modify
	const eventsCopy = JSON.parse(JSON.stringify(state.allEvents));

	for (let part of eventsCopy) {
		stripLongStrings(part);
	}

	// Create debug data with metadata
	const debugData = {
		timestamp: new Date().toISOString(),
		sessionID: state.sessionID,
		events: eventsCopy,
		metadata: {
			command: "/debug",
			version: "1.0",
			totalEvents: eventsCopy.length,
		},
	};

	// Ensure log dir exists
	const logDir = getLogDir();
	mkdirSync(logDir, { recursive: true });

	// Create filename with timestamp
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `debug-${timestamp}.json`;
	const filepath = join(logDir, filename);

	try {
		// Write to JSON file
		writeFileSync(filepath, JSON.stringify(debugData, null, 2));
		console.log(`✅ Debug data saved in ${logDir}`);
	} catch (error) {
		console.error(`❌ Failed to save debug data: ${error}`);
	}

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
