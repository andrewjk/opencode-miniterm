#!/usr/bin/env bun

import { createOpencodeServer } from "@opencode-ai/sdk";
import readline from "node:readline";
import * as ansi from "./ansi";
import { config, loadConfig, saveConfig } from "./config";
import { handleKeyPress, loadSessionHistory } from "./input";
import { getActiveDisplay, updateSessionTitle, writePrompt } from "./render";
import { createClient, createSession, startEventListener, validateSession } from "./server";
import type { State } from "./types";

let server: Awaited<ReturnType<typeof createOpencodeServer>> | undefined;

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

	try {
		server = await createOpencodeServer();
	} catch {
		// Probably the server already exists?
		// Should figure out a better way to check this
	}

	const cwd = process.cwd();
	state.client = createClient(cwd);

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

		process.stdin.on("keypress", async (str, key) => {
			handleKeyPress(state, str, key);
		});

		writePrompt();
	} catch (error: any) {
		console.error("Error:", error.message);
		server?.close();
		process.exit(1);
	}
}

function shutdown() {
	if (process.stdin.setRawMode) {
		process.stdin.setRawMode(false);
	}
	process.stdin.destroy();
	process.stdout.write(ansi.ENABLE_LINE_WRAP);
	saveConfig();
	server?.close();
	console.log(`\n${ansi.BRIGHT_BLACK}Goodbye!${ansi.RESET}`);
	process.exit(0);
}

main().catch(console.error);
