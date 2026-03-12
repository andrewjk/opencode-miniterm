#!/usr/bin/env bun

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";
import type { Event, FileDiff, Part, Todo, ToolPart } from "@opencode-ai/sdk";
import { mkdir } from "node:fs/promises";
import { open } from "node:fs/promises";
import readline from "node:readline";
import * as ansi from "./ansi";
import { getLogDir, isLoggingEnabled } from "./commands/log";
import { config, loadConfig, saveConfig } from "./config";
import { handleKeyPress, loadSessionHistory } from "./input";
import { getActiveDisplay, render, stopAnimation, writePrompt } from "./render";
import type { State } from "./types";

const SERVER_URL = "http://127.0.0.1:4096";
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

let server: Awaited<ReturnType<typeof createOpencodeServer>> | undefined;

let processing = true;
let retryInterval: ReturnType<typeof setInterval> | null = null;

export { updateSessionTitle, setTerminalTitle };

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

let logFile: Awaited<ReturnType<typeof open>> | null = null;
let logFilePath: string | null = null;

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
	state.client = createOpencodeClient({
		baseUrl: SERVER_URL,
		headers: AUTH_PASSWORD
			? {
					Authorization: `Basic ${Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString("base64")}`,
				}
			: undefined,
		directory: cwd,
	});

	process.on("SIGINT", () => {
		process.stdout.write("\n");
		shutdown();
	});

	try {
		let isNewSession = false;

		const initialSessionID = config.sessionIDs[cwd];
		if (!initialSessionID || !(await validateSession(initialSessionID))) {
			state.sessionID = await createSession();
			isNewSession = true;
			config.sessionIDs[cwd] = state.sessionID;
			saveConfig();
		} else {
			state.sessionID = initialSessionID;
		}

		startEventListener();

		await updateSessionTitle();

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

// ====================
// SERVER COMMUNICATION
// ====================

async function createSession(): Promise<string> {
	const result = await state.client.session.create({
		body: {},
	});

	if (result.error) {
		if (result.response.status === 401 && !AUTH_PASSWORD) {
			throw new Error(
				"Server requires authentication. Set OPENCODE_SERVER_PASSWORD environment variable.",
			);
		}
		throw new Error(
			`Failed to create session (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	return result.data.id;
}

async function validateSession(sessionID: string): Promise<boolean> {
	try {
		const result = await state.client.session.get({
			path: { id: sessionID },
		});
		return !result.error && result.response.status === 200;
	} catch {
		return false;
	}
}

async function updateSessionTitle(): Promise<void> {
	try {
		const result = await state.client.session.get({
			path: { id: state.sessionID },
		});
		if (!result.error && result.data?.title) {
			setTerminalTitle(result.data.title);
		} else {
			setTerminalTitle(state.sessionID.substring(0, 8));
		}
	} catch {
		setTerminalTitle(state.sessionID.substring(0, 8));
	}
}

async function startEventListener(): Promise<void> {
	try {
		const { stream } = await state.client.event.subscribe({
			onSseError: (error) => {
				console.error(
					`\n${ansi.RED}Connection error:${ansi.RESET}`,
					error instanceof Error ? error.message : String(error),
				);
			},
		});

		for await (const event of stream) {
			try {
				await processEvent(event);
			} catch (error) {
				console.error(
					`\n${ansi.RED}Event processing error:${ansi.RESET}`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	} catch (error) {
		console.error(
			`\n${ansi.RED}Failed to connect to event stream:${ansi.RESET}`,
			error instanceof Error ? error.message : String(error),
		);
	}
}

// TODO: Should this be in something like "server.ts"?
export async function sendMessage(sessionID: string, message: string) {
	processing = false;
	state.accumulatedResponse = [];
	state.allEvents = [];
	state.renderedLines = [];

	await createLogFile();

	await writeToLog(`User: ${message}\n\n`);

	const requestStartTime = Date.now();

	try {
		const result = await state.client.session.prompt({
			path: { id: sessionID },
			body: {
				model: {
					providerID: config.providerID,
					modelID: config.modelID,
				},
				parts: [{ type: "text", text: message }],
			},
		});

		if (result.error) {
			throw new Error(
				`Failed to send message (${result.response.status}): ${JSON.stringify(result.error)}`,
			);
		}

		// Play a chime when request is completed
		process.stdout.write("\x07");

		stopAnimation();

		const duration = Date.now() - requestStartTime;
		const durationText = formatDuration(duration);
		console.log(`  ${ansi.BRIGHT_BLACK}Completed in ${durationText}${ansi.RESET}\n`);

		writePrompt();
	} catch (error: any) {
		throw error;
	} finally {
		await closeLogFile();
	}
}

// ====================
// EVENT PROCESSING
// ====================

async function processEvent(event: Event): Promise<void> {
	if (retryInterval && event.type !== "session.status") {
		clearInterval(retryInterval);
		retryInterval = null;
	}

	state.allEvents.push(event);

	switch (event.type) {
		case "message.part.updated": {
			const part = event.properties.part;
			const delta = event.properties.delta;
			if (part) {
				await processPart(part);
			}
			if (delta !== undefined && part) {
				processDelta(part.id, delta);
			}
			break;
		}

		// @ts-ignore this definitely exists
		case "message.part.delta": {
			// @ts-ignore
			const partID = event.properties.partID;
			// @ts-ignore
			const delta = event.properties.delta;
			if (partID !== undefined && delta !== undefined) {
				processDelta(partID, delta);
			}
			break;
		}

		case "session.diff": {
			const diff = event.properties.diff;
			if (diff && diff.length > 0) {
				await processDiff(diff);
			}
			break;
		}

		case "session.idle":
		case "session.status":
			if (event.type === "session.status" && event.properties.status.type === "idle") {
				stopAnimation();
				// TODO: isRequestActive = false;
				process.stdout.write(ansi.CURSOR_SHOW);
				if (retryInterval) {
					clearInterval(retryInterval);
					retryInterval = null;
				}
				writePrompt();
			}
			if (event.type === "session.status" && event.properties.status.type === "retry") {
				const message = event.properties.status.message;
				const retryTime = event.properties.status.next;
				const sessionID = event.properties.sessionID;
				console.error(`\n\n  ${ansi.RED}Error:${ansi.RESET} ${message}`);
				console.error(`  ${ansi.BRIGHT_BLACK}Session:${ansi.RESET} ${sessionID}`);
				if (retryTime) {
					if (retryInterval) {
						clearInterval(retryInterval);
					}
					const retryDate = new Date(retryTime);

					let lastSeconds = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
					console.error(`  ${ansi.BRIGHT_BLACK}Retrying in ${lastSeconds}s...${ansi.RESET}`);

					retryInterval = setInterval(() => {
						const remaining = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
						if (remaining !== lastSeconds) {
							process.stdout.write(
								`\r  ${ansi.BRIGHT_BLACK}Retrying in ${remaining}s...${ansi.RESET}`,
							);
							lastSeconds = remaining;
						}
						if (remaining === 0) {
							if (retryInterval) {
								clearInterval(retryInterval);
								retryInterval = null;
							}
						}
					}, 100);
				}
			}
			break;

		case "session.updated": {
			const session = event.properties.info;
			if (session && session.id === state.sessionID && session.title) {
				setTerminalTitle(session.title);
			}
			break;
		}

		case "todo.updated": {
			const todos = event.properties.todos;
			if (todos) {
				await processTodos(todos);
			}

			break;
		}

		default:
			break;
	}
}

async function processPart(part: Part): Promise<void> {
	switch (part.type) {
		case "step-start":
			processStepStart();
			break;

		case "reasoning":
			processReasoning(part);
			break;

		case "text":
			if (processing) {
				processText(part);
			}
			break;

		case "step-finish":
			break;

		case "tool":
			processToolUse(part);
			break;

		default:
			break;
	}
}

function processStepStart() {
	processing = true;
}

async function processReasoning(part: Part) {
	processing = true;
	let thinkingPart = findLastPart(part.id);
	if (!thinkingPart) {
		thinkingPart = { key: part.id, title: "thinking", text: (part as any).text || "" };
		state.accumulatedResponse.push(thinkingPart);
	} else {
		thinkingPart.text = (part as any).text || "";
	}

	const text = (part as any).text || "";
	const cleanText = ansi.stripAnsiCodes(text.trimStart());
	await writeToLog(`Thinking:\n\n${cleanText}\n\n`);

	render(state);
}

async function processText(part: Part) {
	let responsePart = findLastPart(part.id);
	if (!responsePart) {
		responsePart = { key: part.id, title: "response", text: (part as any).text || "" };
		state.accumulatedResponse.push(responsePart);
	} else {
		responsePart.text = (part as any).text || "";
	}

	const text = (part as any).text || "";
	const cleanText = ansi.stripAnsiCodes(text.trimStart());
	await writeToLog(`Response:\n\n${cleanText}\n\n`);

	render(state);
}

async function processToolUse(part: Part) {
	const toolPart = part as ToolPart;
	const toolName = toolPart.tool || "unknown";
	const toolInput =
		toolPart.state.input["description"] ||
		toolPart.state.input["filePath"] ||
		toolPart.state.input["path"] ||
		toolPart.state.input["include"] ||
		toolPart.state.input["pattern"] ||
		// TODO: more state.input props?
		"...";
	const toolText = `$ ${toolName}: ${ansi.BRIGHT_BLACK}${toolInput}${ansi.RESET}`;

	if (state.accumulatedResponse[state.accumulatedResponse.length - 1]?.title === "tool") {
		state.accumulatedResponse[state.accumulatedResponse.length - 1]!.text = toolText;
	} else {
		state.accumulatedResponse.push({ key: part.id, title: "tool", text: toolText });
	}

	const cleanToolText = ansi.stripAnsiCodes(toolText);
	await writeToLog(`$ ${cleanToolText}\n\n`);

	render(state);
}

function processDelta(partID: string, delta: string) {
	let responsePart = findLastPart(partID);
	if (responsePart) {
		responsePart.text += delta;
	}

	render(state);
}

async function processDiff(diff: FileDiff[]) {
	const parts: string[] = [];
	for (const file of diff) {
		const newAfter = file.after ?? "";
		const oldAfter = state.lastFileAfter.get(file.file);
		if (newAfter !== oldAfter) {
			const statusIcon = !file.before ? "A" : !file.after ? "D" : "M";
			const addStr = file.additions > 0 ? `${ansi.GREEN}+${file.additions}${ansi.RESET}` : "";
			const delStr = file.deletions > 0 ? `${ansi.RED}-${file.deletions}${ansi.RESET}` : "";
			const stats = [addStr, delStr].filter(Boolean).join(" ");
			const line = `${ansi.BLUE}${statusIcon}${ansi.RESET} ${file.file} ${stats}`;
			parts.push(line);

			state.lastFileAfter.set(file.file, newAfter);
		}
	}

	if (parts.length > 0) {
		state.accumulatedResponse.push({ key: "diff", title: "files", text: parts.join("\n") });

		const diffText = ansi.stripAnsiCodes(parts.join("\n"));
		await writeToLog(`${diffText}\n\n`);

		render(state);
	}
}

async function processTodos(todos: Todo[]) {
	let todoListText = "Todo:\n";

	for (let todo of todos) {
		let todoText = "";
		if (todo.status === "completed") {
			todoText += "- [✓] ";
		} else {
			todoText += "- [ ] ";
		}
		todoText += todo.content;
		todoListText += todoText + "\n";
	}

	state.accumulatedResponse.push({ key: "todo", title: "files", text: todoListText });

	const cleanTodoText = ansi.stripAnsiCodes(todoListText);
	await writeToLog(`${cleanTodoText}\n`);

	render(state);
}

function findLastPart(title: string) {
	for (let i = state.accumulatedResponse.length - 1; i >= 0; i--) {
		const part = state.accumulatedResponse[i];
		if (part?.key === title) {
			return part;
		}
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

// ====================
// USER INTERFACE
// ====================

function setTerminalTitle(sessionName: string): void {
	process.stdout.write(`\x1b]0;OC | ${sessionName}\x07`);
}

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.round(seconds % 60);
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

// ====================
// LOGGING
// ====================

async function createLogFile(): Promise<void> {
	if (!isLoggingEnabled()) {
		return;
	}

	const logDir = getLogDir();
	await mkdir(logDir, { recursive: true });

	const now = new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filename = `${timestamp}.txt`;
	logFilePath = `${logDir}/${filename}`;

	try {
		logFile = await open(logFilePath, "w");
	} catch (error) {
		console.error("Failed to create log file:", error);
		logFile = null;
		logFilePath = null;
	}
}

async function closeLogFile(): Promise<void> {
	if (logFile) {
		try {
			await logFile.close();
		} catch (error) {
			console.error("Failed to close log file:", error);
		}
		logFile = null;
		logFilePath = null;
	}
}

async function writeToLog(text: string): Promise<void> {
	if (logFile && isLoggingEnabled()) {
		try {
			await logFile.write(text);
		} catch (error) {
			console.error("Failed to write to log file:", error);
		}
	}
}

main().catch(console.error);
