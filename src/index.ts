#!/usr/bin/env bun

import readline from "node:readline";
import * as ansi from "./ansi";
import { config, loadConfig, saveConfig } from "./config";
import { handleKeyPress, loadSessionHistory } from "./input";
import { connect } from "./opencode";
import { getActiveDisplay, updateSessionTitle, writePrompt } from "./render";
import { createSession, startEventListener, stopEventListener, validateSession } from "./server";
import type { State } from "./types";

let state: State = {
	// @ts-ignore This will get set
	client: null,
	sessionID: "",
	renderedLines: [],
	accumulatedResponse: [],
	allEvents: [],
	lastFileAfter: new Map(),
	write: (text) => process.stdout.write(text),
	shutdown,
};

// ====================
// MAIN ENTRY POINT
// ====================

async function main() {
	loadConfig();

	console.log(`\n${ansi.BRIGHT_BLACK}Connecting to OpenCode server...${ansi.RESET}\n`);

	const cwd = process.cwd();
	try {
		const connection = await connect();
		state.client = connection.client;
	} catch (error) {
		console.error(
			`${ansi.RED}Failed to connect to the OpenCode service:${ansi.RESET}`,
			error instanceof Error ? error.message : String(error),
		);
		process.exit(1);
	}

	process.on("SIGINT", () => {
		process.stdout.write("\n");
		shutdown();
	});

	try {
		let isNewSession = false;

		const initialSessionID = config.sessionIDs[cwd];
		if (!initialSessionID || !(await validateSession(state, initialSessionID))) {
			state.sessionID = await createSession(state);
			isNewSession = true;
			config.sessionIDs[cwd] = state.sessionID;
			saveConfig();
		} else {
			state.sessionID = initialSessionID;
		}

		startEventListener(state);

		await updateSessionTitle(state);

		await loadSessionHistory(state);

		process.stdout.write(`${ansi.CLEAR_SCREEN_UP}${ansi.CLEAR_FROM_CURSOR}`);
		process.stdout.write(ansi.CURSOR_HOME);
		const activeDisplay = await getActiveDisplay(state.client);
		console.log(activeDisplay);
		if (!isNewSession) {
			console.log("Resumed last session");
		}
		console.log();
		console.log(`${ansi.BRIGHT_BLACK}Ask anything...${ansi.RESET}\n`);

		const _rl = readline.createInterface({
			input: process.stdin,
			output: undefined,
		});

		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdout.write(ansi.DISABLE_LINE_WRAP);

		// Serialize key handling so async handlers (e.g. sending a message) don't
		// race with subsequent keypresses.
		let keyQueue = Promise.resolve();
		process.stdin.on("keypress", (str, key) => {
			keyQueue = keyQueue
				.then(() => handleKeyPress(state, str as string, key))
				.catch((error) => {
					console.error(
						`\n${ansi.RED}Keypress handler error:${ansi.RESET}`,
						error instanceof Error ? error.message : String(error),
					);
				});
		});

		writePrompt();
	} catch (error: any) {
		console.error("Error:", error.message);
		process.exit(1);
	}
}

function shutdown() {
	stopEventListener();
	if (process.stdin.setRawMode) {
		process.stdin.setRawMode(false);
	}
	process.stdin.destroy();
	process.stdout.write(ansi.ENABLE_LINE_WRAP);
	saveConfig();
	console.log(`${ansi.BRIGHT_BLACK}Goodbye!${ansi.RESET}`);
	process.exit(0);
}

main().catch(console.error);
