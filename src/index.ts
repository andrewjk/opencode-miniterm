import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Agent, Event, FileDiff, Message, Part, Session, ToolPart } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
import readline from "node:readline";
import agentsCommand from "./commands/agents";
import debugCommand from "./commands/debug";
import detailsCommand from "./commands/details";
import exitCommand from "./commands/exit";
import initCommand from "./commands/init";
import killCommand from "./commands/kill";
import modelsCommand from "./commands/models";
import newCommand from "./commands/new";
import quitCommand from "./commands/quit";
import runCommand from "./commands/run";
import sessionsCommand from "./commands/sessions";
import undoCommand from "./commands/undo";
import { config, loadConfig, saveConfig } from "./config";
import { getActiveDisplay, render, startAnimation, stopAnimation, writePrompt } from "./render";

const SERVER_URL = "http://127.0.0.1:4096";
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

const SLASH_COMMANDS = [
	initCommand,
	agentsCommand,
	modelsCommand,
	sessionsCommand,
	newCommand,
	undoCommand,
	detailsCommand,
	debugCommand,
	killCommand,
	exitCommand,
	quitCommand,
	runCommand,
];

let client: ReturnType<typeof createOpencodeClient>;

let processing = true;
let retryInterval: ReturnType<typeof setInterval> | null = null;
let messageAbortController: AbortController | null = null;

interface AccumulatedPart {
	key: string;
	title: string;
	text: string;
	active?: boolean;
	durationMs?: number;
}

export interface State {
	sessionId: string;
	renderedLinesCount: number;
	accumulatedResponse: AccumulatedPart[];
	allEvents: Event[];
	write: (text: string) => void;
}

let state: State = {
	sessionId: "",
	renderedLinesCount: 0,
	accumulatedResponse: [],
	allEvents: [],
	write: (text) => process.stdout.write(text),
};

let currentRequestMessageId: string | null = null;

main().catch(console.error);

async function main() {
	loadConfig();

	const serverProcess = await startOpenCodeServer();

	client = createOpencodeClient({
		baseUrl: SERVER_URL,
		headers: AUTH_PASSWORD
			? {
					Authorization: `Basic ${Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString("base64")}`,
				}
			: undefined,
	});

	try {
		let isNewSession = false;

		const initialSessionId = config.sessionID;
		if (!initialSessionId || !(await validateSession(initialSessionId))) {
			state.sessionId = await createSession();
			isNewSession = true;
			config.sessionID = state.sessionId;
			saveConfig();
		} else {
			state.sessionId = initialSessionId;
		}

		startEventListener();

		const activeDisplay = await getActiveDisplay(client);

		process.stdout.write(`\x1b[${2}A\x1b[0J`);
		process.stdout.write("\x1b[0G");
		console.log(activeDisplay);
		if (!isNewSession) {
			console.log("Resumed last session");
		}
		console.log();
		console.log("\x1b[90mAsk anything...\x1b[0m\n");

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}

		let inputBuffer = "";
		let cursorPosition = 0;
		let completions: string[] = [];
		let history: string[] = [];
		let historyIndex = -1;
		let selectedCompletion = 0;
		let showCompletions = false;
		let completionCycling = false;

		const getCompletions = (text: string): string[] => {
			if (text.startsWith("/")) {
				return SLASH_COMMANDS.map((c) => c.name).filter((cmd) => cmd.startsWith(text));
			}
			return [];
		};

		// TODO: Backspacing past the beginning of a line chews up too many lines
		let oldWrappedRows = 0;
		const renderLine = (): void => {
			const consoleWidth = process.stdout.columns || 80;
			const totalLength = 2 + inputBuffer.length + 1;
			const wrappedRows = Math.floor(totalLength / consoleWidth);
			readline.cursorTo(process.stdout, 0);
			if (oldWrappedRows > 0) {
				readline.moveCursor(process.stdout, 0, -oldWrappedRows);
			}
			readline.clearScreenDown(process.stdout);
			oldWrappedRows = wrappedRows;

			writePrompt();
			process.stdout.write(inputBuffer);

			const totalPosition = 2 + cursorPosition;
			const targetRow = Math.floor(totalPosition / consoleWidth);
			const targetCol = totalPosition % consoleWidth;

			const endCol = (2 + inputBuffer.length) % consoleWidth;
			const endRow = Math.floor((2 + inputBuffer.length) / consoleWidth);

			const deltaCol = targetCol - endCol;
			let deltaRow = targetRow - endRow;
			if (deltaCol !== 0 && endCol === 0) {
				deltaRow += 1;
			}

			readline.moveCursor(process.stdout, deltaCol, deltaRow);
		};

		const handleTab = (): void => {
			const potentialCompletions = getCompletions(inputBuffer);

			if (potentialCompletions.length === 0) {
				completionCycling = false;
				return;
			}

			if (!completionCycling) {
				completions = potentialCompletions;
				selectedCompletion = 0;
				completionCycling = true;
				inputBuffer = completions[0]!;
				cursorPosition = inputBuffer.length;
				renderLine();
			} else {
				selectedCompletion = (selectedCompletion + 1) % completions.length;
				inputBuffer = completions[selectedCompletion]!;
				cursorPosition = inputBuffer.length;
				renderLine();
			}
		};

		const acceptInput = async (): Promise<void> => {
			process.stdout.write("\n");

			const input = inputBuffer.trim();

			inputBuffer = "";
			cursorPosition = 0;
			showCompletions = false;
			completionCycling = false;
			completions = [];

			if (input) {
				if (history[history.length - 1] !== input) {
					history.push(input);
				}
				historyIndex = history.length;
				try {
					if (input === "/help") {
						const maxCommandLength = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
						for (const cmd of SLASH_COMMANDS) {
							const padding = " ".repeat(maxCommandLength - cmd.name.length + 2);
							console.log(
								`  \x1b[97m${cmd.name}\x1b[0m${padding}\x1b[90m${cmd.description}\x1b[0m`,
							);
						}
						console.log();
						return;
					} else if (input.startsWith("/")) {
						const commandName = input.substring(0, input.indexOf(" ")).toLowerCase();
						for (let command of SLASH_COMMANDS) {
							if (command.name === commandName) {
								await command.run(client, state, input.substring(commandName.length).trim());
								console.log();
								return;
							}
						}
					}

					process.stdout.write("\x1b[?25l");
					startAnimation();
					await sendMessage(state.sessionId, input);
				} catch (error: any) {
					if (error.message !== "Request cancelled") {
						stopAnimation();
						console.error("Error:", error.message);
					}
				}
			}

			if (!SLASH_COMMANDS.find((c) => c.running)) {
				writePrompt();
			}
		};

		process.stdin.on("keypress", async (str, key) => {
			for (let command of SLASH_COMMANDS) {
				if (command.running && command.handleKey) {
					await command.handleKey(client, key, str);
					return;
				}
			}

			switch (key.name) {
				case "up": {
					if (history.length > 0) {
						if (historyIndex > 0) {
							historyIndex--;
						}
						inputBuffer = history[historyIndex]!;
						cursorPosition = inputBuffer.length;
						renderLine();
					}
					return;
				}
				case "down": {
					if (history.length > 0) {
						if (historyIndex < history.length - 1) {
							historyIndex++;
							inputBuffer = history[historyIndex]!;
						} else {
							historyIndex = history.length;
							inputBuffer = "";
						}
						cursorPosition = inputBuffer.length;
						renderLine();
					}
					return;
				}
				case "tab": {
					if (!completionCycling) {
						handleTab();
					}
					if (completionCycling && completions.length > 0) {
						handleTab();
					}
					return;
				}
				case "escape": {
					if (messageAbortController) {
						messageAbortController.abort();
						stopAnimation();
						process.stdout.write("\x1b[?25h");
						process.stdout.write("\r\x1b[90mCancelled request\x1b[0m\n");
					} else {
						inputBuffer = "";
						cursorPosition = 0;
						showCompletions = false;
						completionCycling = false;
						completions = [];
						readline.cursorTo(process.stdout, 0);
						readline.clearScreenDown(process.stdout);
						writePrompt();
					}
					return;
				}
				case "return": {
					await acceptInput();
					return;
				}
				case "backspace": {
					if (cursorPosition > 0) {
						inputBuffer =
							inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition);
						cursorPosition--;
					}
					break;
				}
				case "delete": {
					if (cursorPosition < inputBuffer.length) {
						inputBuffer =
							inputBuffer.slice(0, cursorPosition) + inputBuffer.slice(cursorPosition + 1);
					}
					break;
				}
				case "left": {
					if (cursorPosition > 0) cursorPosition--;
					break;
				}
				case "right": {
					if (cursorPosition < inputBuffer.length) cursorPosition++;
					break;
				}
				default: {
					if (str) {
						inputBuffer =
							inputBuffer.slice(0, cursorPosition) + str + inputBuffer.slice(cursorPosition);
						cursorPosition += str.length;
					}
				}
			}

			showCompletions = false;
			completionCycling = false;
			completions = [];
			renderLine();
		});

		writePrompt();
	} catch (error: any) {
		console.error("Error:", error.message);
		serverProcess.kill();
		process.exit(1);
	}
}

// USER INTERFACE
// ====================

function processEvent(event: Event): void {
	// Clear any existing retry countdown when new events arrive
	if (retryInterval && event.type !== "session.status") {
		clearInterval(retryInterval);
		retryInterval = null;
	}

	// Store all events for debugging
	state.allEvents.push(event);

	switch (event.type) {
		case "message.part.updated": {
			const part = event.properties.part;
			const delta = event.properties.delta;
			if (part) {
				processPart(part);
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
				processDiff(diff);
			}
			break;
		}

		case "session.idle":
		case "session.status":
			if (event.type === "session.status" && event.properties.status.type === "idle") {
				stopAnimation();
				process.stdout.write("\x1b[?25h");
				if (retryInterval) {
					clearInterval(retryInterval);
					retryInterval = null;
				}
				writePrompt();
				readline.cursorTo(process.stdout, 2);
			}
			if (event.type === "session.status" && event.properties.status.type === "retry") {
				const message = event.properties.status.message;
				const retryTime = event.properties.status.next;
				const sessionId = event.properties.sessionID;
				console.error(`\n\x1b[31mError:\x1b[0m ${message}`);
				console.error(`\x1b[90mSession:\x1b[0m ${sessionId}`);
				if (retryTime) {
					if (retryInterval) {
						clearInterval(retryInterval);
					}
					const retryDate = new Date(retryTime);

					let lastSeconds = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
					console.error(`\x1b[90mRetrying in ${lastSeconds}s...\x1b[0m`);

					retryInterval = setInterval(() => {
						const remaining = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
						if (remaining !== lastSeconds) {
							process.stdout.write(`\r\x1b[90mRetrying in ${remaining}s...\x1b[0m`);
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

		default:
			break;
	}
}

function processPart(part: Part): void {
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

function processReasoning(part: Part) {
	processing = true;
	let thinkingPart = findLastPart(part.id);
	if (!thinkingPart) {
		thinkingPart = { key: part.id, title: "thinking", text: (part as any).text || "" };
		state.accumulatedResponse.push(thinkingPart);
	} else {
		thinkingPart.text = (part as any).text || "";
	}

	render(state);
}

function processText(part: Part) {
	let responsePart = findLastPart(part.id);
	if (!responsePart) {
		responsePart = { key: part.id, title: "response", text: (part as any).text || "" };
		state.accumulatedResponse.push(responsePart);
	} else {
		responsePart.text = (part as any).text || "";
	}

	render(state);
}

function processToolUse(part: Part) {
	const toolText = `🔧 Using \`${(part as ToolPart).tool || "unknown"}\``;

	if (state.accumulatedResponse[state.accumulatedResponse.length - 1]?.title === "tool") {
		state.accumulatedResponse[state.accumulatedResponse.length - 1]!.text = toolText;
	} else {
		state.accumulatedResponse.push({ key: part.id, title: "tool", text: toolText });
	}

	render(state);
}

function processDelta(partID: string, delta: string) {
	let responsePart = findLastPart(partID);
	if (responsePart) {
		responsePart.text += delta;
	}

	// TODO: Only if it's changed?
	render(state);
}

function processDiff(diff: FileDiff[]) {
	const parts: string[] = [];
	for (const file of diff) {
		const status = !file.before ? "added" : !file.after ? "deleted" : "modified";
		const statusIcon = status === "added" ? "A" : status === "modified" ? "M" : "D";
		const statusLabel =
			status === "added" ? "added" : status === "modified" ? "modified" : "deleted";
		const addStr = file.additions > 0 ? `\x1b[32m+${file.additions}\x1b[0m` : "";
		const delStr = file.deletions > 0 ? `\x1b[31m-${file.deletions}\x1b[0m` : "";
		const stats = [addStr, delStr].filter(Boolean).join(" ");
		const line = `  \x1b[34m${statusIcon}\x1b[0m ${file.file} (${statusLabel}) ${stats}`;
		parts.push(line);
	}

	state.accumulatedResponse.push({ key: "diff", title: "files", text: parts.join("\n") });

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

// SERVER COMMUNICATION
// ====================

async function startEventListener(): Promise<void> {
	try {
		const { stream } = await client.event.subscribe({
			onSseError: (error) => {
				console.error(
					"\n\x1b[31mConnection error:\x1b[0m",
					error instanceof Error ? error.message : String(error),
				);
			},
		});

		for await (const event of stream) {
			try {
				processEvent(event);
			} catch (error) {
				console.error(
					"\n\x1b[31mEvent processing error:\x1b[0m",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	} catch (error) {
		console.error(
			"\n\x1b[31mFailed to connect to event stream:\x1b[0m",
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function startOpenCodeServer() {
	const serverProcess = spawn("opencode", ["serve"], {
		stdio: ["ignore", "pipe", "pipe"],
		shell: true,
		cwd: process.cwd(),
	});

	let started = false;

	console.log("\n\x1b[90mStarting OpenCode server...\x1b[0m\n");

	serverProcess.stdout.on("data", (data) => {
		if (!started) {
			process.stdout.write(`\x1b[${2}A\x1b[0J`);
			process.stdout.write("\x1b[0G");
			started = true;
			console.log("\x1b[90mServer started, connecting...\x1b[0m\n");
		}
	});

	serverProcess.on("error", (error) => {
		console.error("Failed to start OpenCode server:", error.message);
		process.exit(1);
	});

	serverProcess.on("exit", (code) => {
		console.log(`OpenCode server exited with code ${code}`);
		process.exit(0);
	});

	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		saveConfig();
		serverProcess.kill("SIGINT");
	});

	await new Promise((resolve) => setTimeout(resolve, 3000));
	return serverProcess;
}

async function createSession(): Promise<string> {
	const result = await client.session.create({
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

async function validateSession(sessionId: string): Promise<boolean> {
	try {
		const result = await client.session.get({
			path: { id: sessionId },
		});
		return !result.error && result.response.status === 200;
	} catch {
		return false;
	}
}

async function sendMessage(sessionId: string, message: string) {
	processing = false;
	state.accumulatedResponse = [];
	state.allEvents = [];

	messageAbortController = new AbortController();

	try {
		const result = await client.session.prompt({
			path: { id: sessionId },
			body: {
				model: {
					providerID: config.providerID,
					modelID: config.modelID,
				},
				parts: [{ type: "text", text: message }],
			},
			signal: messageAbortController.signal,
		});

		if (result.error) {
			throw new Error(
				`Failed to send message (${result.response.status}): ${JSON.stringify(result.error)}`,
			);
		}
	} catch (error: any) {
		if (error.name === "AbortError" || messageAbortController?.signal.aborted) {
			throw new Error("Request cancelled");
		}
		throw error;
	} finally {
		messageAbortController = null;
	}
}
