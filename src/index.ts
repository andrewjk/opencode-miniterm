import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Agent, Event, FileDiff, Message, Part, Session, ToolPart } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import readline from "node:readline";
import * as ansi from "./ansi";
import agentsCommand from "./commands/agents";
import debugCommand from "./commands/debug";
import detailsCommand from "./commands/details";
import diffCommand from "./commands/diff";
import exitCommand from "./commands/exit";
import initCommand from "./commands/init";
import killCommand from "./commands/kill";
import logCommand, { isLoggingEnabled } from "./commands/log";
import modelsCommand from "./commands/models";
import newCommand from "./commands/new";
import pageCommand from "./commands/page";
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
	diffCommand,
	debugCommand,
	logCommand,
	pageCommand,
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
	sessionID: string;
	renderedLinesCount: number;
	accumulatedResponse: AccumulatedPart[];
	allEvents: Event[];
	write: (text: string) => void;
	lastFileAfter: Map<string, string>;
}

let state: State = {
	sessionID: "",
	renderedLinesCount: 0,
	accumulatedResponse: [],
	allEvents: [],
	write: (text) => process.stdout.write(text),
	lastFileAfter: new Map(),
};

let logFile: Awaited<ReturnType<typeof open>> | null = null;
let logFilePath: string | null = null;

// ====================
// MAIN ENTRY POINT
// ====================

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

		const initialSessionID = config.sessionID;
		if (!initialSessionID || !(await validateSession(initialSessionID))) {
			state.sessionID = await createSession();
			isNewSession = true;
			config.sessionID = state.sessionID;
			saveConfig();
		} else {
			state.sessionID = initialSessionID;
		}

		startEventListener();

		const activeDisplay = await getActiveDisplay(client);

		process.stdout.write(`${ansi.CLEAR_SCREEN_UP}${ansi.CLEAR_FROM_CURSOR}`);
		process.stdout.write(ansi.CURSOR_HOME);
		console.log(activeDisplay);
		if (!isNewSession) {
			console.log("Resumed last session");
		}
		console.log();
		console.log(`${ansi.BRIGHT_BLACK}Ask anything...${ansi.RESET}\n`);

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

		const getCompletions = async (text: string): Promise<string[]> => {
			if (text.startsWith("/")) {
				return ["/help", ...SLASH_COMMANDS.map((c) => c.name)].filter((cmd) =>
					cmd.startsWith(text),
				);
			}

			const atMatch = text.match(/(@[^\s]*)$/);
			if (atMatch) {
				const prefix = atMatch[0]!;
				const searchPattern = prefix.slice(1);
				const pattern = searchPattern.includes("/")
					? searchPattern + "*"
					: "**/" + searchPattern + "*";
				const files = await getFileCompletions(pattern);
				return files.map((file: string) => text.replace(/@[^\s]*$/, "@" + file));
			}

			return [];
		};

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

		const handleTab = async (): Promise<void> => {
			const potentialCompletions = await getCompletions(inputBuffer);

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
								`  ${ansi.BRIGHT_WHITE}${cmd.name}${ansi.RESET}${padding}${ansi.BRIGHT_BLACK}${cmd.description}${ansi.RESET}`,
							);
						}
						console.log();
						return;
					} else if (input.startsWith("/")) {
						const parts = input.match(/(\/[^\s]+)\s*(.*)/)!;
						if (parts) {
							const commandName = parts[1];
							const extra = parts[2]?.trim();
							for (let command of SLASH_COMMANDS) {
								if (command.name === commandName) {
									await command.run(client, state, extra);
									return;
								}
							}
						}
						return;
					}

					process.stdout.write(ansi.CURSOR_HIDE);
					startAnimation();
					if (isLoggingEnabled()) {
						console.log(`📝 ${ansi.BRIGHT_BLACK}Logging to ${getLogDir()}\n${ansi.RESET}`);
					}
					await sendMessage(state.sessionID, input);
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
						await handleTab();
					}
					if (completionCycling && completions.length > 0) {
						await handleTab();
					}
					return;
				}
				case "escape": {
					if (messageAbortController) {
						messageAbortController.abort();
						stopAnimation();
						process.stdout.write(ansi.CURSOR_SHOW);
						process.stdout.write(`\r${ansi.BRIGHT_BLACK}Cancelled request${ansi.RESET}\n`);
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
					if (key.meta) {
						cursorPosition = findPreviousWordBoundary(inputBuffer, cursorPosition);
					} else if (cursorPosition > 0) {
						cursorPosition--;
					}
					break;
				}
				case "right": {
					if (key.meta) {
						cursorPosition = findNextWordBoundary(inputBuffer, cursorPosition);
					} else if (cursorPosition < inputBuffer.length) {
						cursorPosition++;
					}
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

// ====================
// SERVER COMMUNICATION
// ====================

async function startOpenCodeServer() {
	const serverProcess = spawn("opencode", ["serve"], {
		stdio: ["ignore", "pipe", "pipe"],
		shell: true,
		cwd: process.cwd(),
	});

	let started = false;

	console.log(`\n${ansi.BRIGHT_BLACK}Starting OpenCode server...${ansi.RESET}\n`);

	serverProcess.stdout.on("data", (data) => {
		if (!started) {
			process.stdout.write(`${ansi.CLEAR_SCREEN_UP}${ansi.CLEAR_FROM_CURSOR}`);
			process.stdout.write(ansi.CURSOR_HOME);
			started = true;
			console.log(`${ansi.BRIGHT_BLACK}Server started, connecting...${ansi.RESET}\n`);
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

async function validateSession(sessionID: string): Promise<boolean> {
	try {
		const result = await client.session.get({
			path: { id: sessionID },
		});
		return !result.error && result.response.status === 200;
	} catch {
		return false;
	}
}

async function startEventListener(): Promise<void> {
	try {
		const { stream } = await client.event.subscribe({
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

async function sendMessage(sessionID: string, message: string) {
	processing = false;
	state.accumulatedResponse = [];
	state.allEvents = [];
	state.renderedLinesCount = 0;

	await createLogFile();

	await writeToLog(`User: ${message}\n\n`);

	messageAbortController = new AbortController();

	try {
		const result = await client.session.prompt({
			path: { id: sessionID },
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
				process.stdout.write(ansi.CURSOR_SHOW);
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
				const sessionID = event.properties.sessionID;
				console.error(`\n${ansi.RED}Error:${ansi.RESET} ${message}`);
				console.error(`${ansi.BRIGHT_BLACK}Session:${ansi.RESET} ${sessionID}`);
				if (retryTime) {
					if (retryInterval) {
						clearInterval(retryInterval);
					}
					const retryDate = new Date(retryTime);

					let lastSeconds = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
					console.error(`${ansi.BRIGHT_BLACK}Retrying in ${lastSeconds}s...${ansi.RESET}`);

					retryInterval = setInterval(() => {
						const remaining = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
						if (remaining !== lastSeconds) {
							process.stdout.write(
								`\r${ansi.BRIGHT_BLACK}Retrying in ${remaining}s...${ansi.RESET}`,
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
	await writeToLog(`💭 Thinking...\n\n${cleanText}\n\n`);

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
	await writeToLog(`💬 Response:\n\n${cleanText}\n\n`);

	render(state);
}

async function processToolUse(part: Part) {
	const toolPart = part as ToolPart;
	const toolName = toolPart.tool || "unknown";
	const toolInput = toolPart.state.input["description"] || toolPart.state.input["filePath"] || {};
	const toolText = `🔧 ${toolName}: ${toolInput}`;

	if (state.accumulatedResponse[state.accumulatedResponse.length - 1]?.title === "tool") {
		state.accumulatedResponse[state.accumulatedResponse.length - 1]!.text = toolText;
	} else {
		state.accumulatedResponse.push({ key: part.id, title: "tool", text: toolText });
	}

	const cleanToolText = ansi.stripAnsiCodes(toolText);
	await writeToLog(`${cleanToolText}\n\n`);

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
	let hasChanges = false;
	const parts: string[] = [];
	for (const file of diff) {
		const status = !file.before ? "added" : !file.after ? "deleted" : "modified";
		const statusIcon = status === "added" ? "A" : status === "modified" ? "M" : "D";
		const statusLabel =
			status === "added" ? "added" : status === "modified" ? "modified" : "deleted";
		const addStr = file.additions > 0 ? `${ansi.GREEN}+${file.additions}${ansi.RESET}` : "";
		const delStr = file.deletions > 0 ? `${ansi.RED}-${file.deletions}${ansi.RESET}` : "";
		const stats = [addStr, delStr].filter(Boolean).join(" ");
		const line = `  ${ansi.BLUE}${statusIcon}${ansi.RESET} ${file.file} (${statusLabel}) ${stats}`;
		parts.push(line);

		const newAfter = file.after ?? "";
		const oldAfter = state.lastFileAfter.get(file.file);
		if (newAfter !== oldAfter) {
			hasChanges = true;
			state.lastFileAfter.set(file.file, newAfter);
		}
	}

	if (hasChanges) {
		state.accumulatedResponse.push({ key: "diff", title: "files", text: parts.join("\n") });

		const diffText = ansi.stripAnsiCodes(parts.join("\n"));
		await writeToLog(`${diffText}\n\n`);

		render(state);
	}
}

function findLastPart(title: string) {
	for (let i = state.accumulatedResponse.length - 1; i >= 0; i--) {
		const part = state.accumulatedResponse[i];
		if (part?.key === title) {
			return part;
		}
	}
}

// ====================
// USER INTERFACE
// ====================

function findPreviousWordBoundary(text: string, pos: number): number {
	if (pos <= 0) return 0;

	let newPos = pos;

	while (newPos > 0 && /\s/.test(text[newPos - 1]!)) {
		newPos--;
	}

	while (newPos > 0 && !/\s/.test(text[newPos - 1]!)) {
		newPos--;
	}

	return newPos;
}

function findNextWordBoundary(text: string, pos: number): number {
	if (pos >= text.length) return text.length;

	let newPos = pos;

	while (newPos < text.length && !/\s/.test(text[newPos]!)) {
		newPos++;
	}

	while (newPos < text.length && /\s/.test(text[newPos]!)) {
		newPos++;
	}

	return newPos;
}

// ====================
// LOGGING
// ====================

function getLogDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	return `${homeDir}/.local/share/opencode-miniterm/log`;
}

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

// ====================
// UTILITIES
// ====================

async function getFileCompletions(pattern: string): Promise<string[]> {
	try {
		const files: string[] = [];
		for await (const file of glob(pattern)) {
			if (
				!file.startsWith("node_modules/") &&
				!file.startsWith(".git/") &&
				!file.startsWith("dist/") &&
				!file.startsWith("build/")
			) {
				const isDir = await stat(file)
					.then((s) => s.isDirectory())
					.catch(() => false);
				files.push(isDir ? file + "/" : file);
			}
		}
		return files.sort();
	} catch {
		return [];
	}
}

main().catch(console.error);
