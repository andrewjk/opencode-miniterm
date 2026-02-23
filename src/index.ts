import type { HeadersInit } from "bun";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { config, loadConfig, saveConfig } from "./config";
import { render } from "./render";
import type {
	DiffInfo,
	EventProperties,
	EventType,
	MessageInfo,
	MessagesResponse,
	ModelResponse,
	Part,
	PartType,
	ServerEvent,
	SessionInfo,
	SessionResponse,
	SessionStatus,
	Tokens,
} from "./types";

const SERVER_URL = "http://127.0.0.1:4096";
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

const SLASH_COMMANDS = [
	{ command: "/init", description: "Analyze project and create/update AGENTS.md" },
	{ command: "/model", description: "List available models" },
	{ command: "/undo", description: "Undo last message" },
	{ command: "/debug", description: "Show all parts from the most recent request" },
	{ command: "/help", description: "Show this help message" },
];

let processing = true;
let lastEventTime = Date.now();
let allEvents: ServerEvent[] = [];

interface ModelInfo {
	providerID: string;
	providerName: string;
	modelID: string;
	modelName: string;
}

let modelSelectionMode = false;
let modelList: ModelInfo[] = [];
let selectedModelIndex = 0;
let modelListLineCount = 0;

interface AccumulatedPart {
	key: string;
	title: string;
	text: string;
	active?: boolean;
	durationMs?: number;
}

export interface State {
	renderedLinesCount: number;
	accumulatedResponse: AccumulatedPart[];
	write: (text: string) => void;
}

let state: State = {
	renderedLinesCount: 0,
	accumulatedResponse: [],
	write: (text) => process.stdout.write(text),
};

main().catch(console.error);

async function main() {
	loadConfig();

	const serverProcess = await startOpenCodeServer();

	try {
		const sessionId = await createSession();
		startEventListener();

		process.stdout.write(`\x1b[${2}A\x1b[0J`);
		process.stdout.write("\x1b[0G");
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
				return SLASH_COMMANDS.map((c) => c.command).filter((cmd) => cmd.startsWith(text));
			}
			return [];
		};

		const renderLine = (): void => {
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			process.stdout.write("> " + inputBuffer);
			readline.cursorTo(process.stdout, 2 + cursorPosition);
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
					if (input === "/init") {
						await runInit(sessionId);
					} else if (input === "/model" || input === "/models") {
						await runModel(sessionId);
					} else if (input === "/undo") {
						await runUndo(sessionId);
					} else if (input === "/debug") {
						runDebug();
					} else if (input === "/help") {
						console.log("\nAvailable commands:");
						for (const cmd of SLASH_COMMANDS) {
							console.log(`  ${cmd.command} - ${cmd.description}`);
						}
						console.log();
					} else {
						process.stdout.write("\x1b[?25l");
						console.log("👉 Sending...");
						console.log();
						state.renderedLinesCount = 2;

						await sendMessage(sessionId, input);
					}
				} catch (error: any) {
					console.error("Error:", error.message);
				}
			}

			if (!modelSelectionMode) {
				process.stdout.write("> ");
			}
		};

		process.stdin.on("keypress", async (str, key) => {
			if (modelSelectionMode) {
				if (key.name === "up") {
					selectedModelIndex =
						selectedModelIndex > 0 ? selectedModelIndex - 1 : modelList.length - 1;
					renderModelList();
					return;
				}
				if (key.name === "down") {
					selectedModelIndex = (selectedModelIndex + 1) % modelList.length;
					renderModelList();
					return;
				}
				if (key.name === "escape") {
					clearModelList();
					process.stdout.write("\x1b[?25h");
					modelSelectionMode = false;
					modelList = [];
					selectedModelIndex = 0;
					modelListLineCount = 0;
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					process.stdout.write("> ");
					return;
				}
				if (key.name === "return") {
					modelListLineCount++;
					clearModelList();
					process.stdout.write("\x1b[?25h");
					const selected = modelList[selectedModelIndex];
					modelSelectionMode = false;
					modelList = [];
					selectedModelIndex = 0;
					modelListLineCount = 0;
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					if (selected) {
						config.providerID = selected.providerID;
						config.modelID = selected.modelID;
						saveConfig();
						console.log(`  ✓ Selected: ${selected.modelName}`);
						console.log();
					}
					process.stdout.write("> ");
					return;
				}
				return;
			}

			if (key.name === "up") {
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

			if (key.name === "down") {
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

			if (key.name === "tab" && !completionCycling) {
				handleTab();
				return;
			}

			if (key.name === "tab" && completionCycling && completions.length > 0) {
				handleTab();
				return;
			}

			if (key.name === "escape") {
				completionCycling = false;
				readline.cursorTo(process.stdout, 0);
				readline.clearScreenDown(process.stdout);
				process.stdout.write("> " + inputBuffer);
				return;
			}

			if (key.name === "return") {
				await acceptInput();
				return;
			}

			if (key.name === "backspace") {
				if (cursorPosition > 0) {
					inputBuffer =
						inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition);
					cursorPosition--;
				}
			} else if (key.name === "delete") {
				if (cursorPosition < inputBuffer.length) {
					inputBuffer =
						inputBuffer.slice(0, cursorPosition) + inputBuffer.slice(cursorPosition + 1);
				}
			} else if (key.name === "left") {
				if (cursorPosition > 0) cursorPosition--;
			} else if (key.name === "right") {
				if (cursorPosition < inputBuffer.length) cursorPosition++;
			} else if (str) {
				inputBuffer =
					inputBuffer.slice(0, cursorPosition) + str + inputBuffer.slice(cursorPosition);
				cursorPosition += str.length;
			}

			showCompletions = false;
			completionCycling = false;
			completions = [];
			renderLine();
		});

		process.stdout.write("> ");
	} catch (error: any) {
		console.error("Error:", error.message);
		serverProcess.kill();
		process.exit(1);
	}
}

// USER INTERFACE
// ====================

function processEvent(event: ServerEvent): void {
	lastEventTime = Date.now();

	// Store all events for debugging
	allEvents.push(event);

	switch (event.type) {
		case "message.part.updated":
			const part = event.properties.part;
			if (part) {
				processPart(event.properties.part);
			}
			break;

		case "message.part.delta":
			processDelta(event.properties.partID, event.properties.delta);
			break;

		case "session.diff":
			const diff = event.properties.diff;
			if (diff && diff.length > 0) {
				processDiff(diff);
			}
			break;

		case "session.idle":
		case "session.status":
			if (event.properties.status?.type === "idle") {
				process.stdout.write("\x1b[?25h");
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
		thinkingPart = { key: part.id, title: "thinking", text: part.text };
		state.accumulatedResponse.push(thinkingPart);
	} else {
		thinkingPart.text = part.text;
	}

	// TODO: Only if it's changed?
	render(state);
}

function processText(part: Part) {
	let responsePart = findLastPart(part.id);
	if (!responsePart) {
		responsePart = { key: part.id, title: "response", text: part.text };
		state.accumulatedResponse.push(responsePart);
	} else {
		responsePart.text = part.text;
	}

	// TODO: Only if it's changed?
	render(state);
}

function processToolUse(part: Part) {
	const toolText = `🔧 Using tool: ${part.tool || "unknown"}`;

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

function processDiff(diff: DiffInfo[]) {
	const parts: string[] = [];
	for (const file of diff) {
		const statusIcon = file.status === "added" ? "A" : file.status === "modified" ? "M" : "D";
		const statusLabel =
			file.status === "added" ? "added" : file.status === "modified" ? "modified" : "deleted";
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
		const response = await fetch(`${SERVER_URL}/event`, {
			headers: getAuthHeaders(false),
		});

		if (!response.ok) {
			console.warn("Failed to connect to event stream");
			return;
		}

		const reader = response.body?.getReader();
		if (!reader) return;

		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			try {
				const { done, value } = await reader.read();

				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.substring(6);
						if (data === "[DONE]") continue;

						try {
							const event: ServerEvent = JSON.parse(data);
							processEvent(event);
						} catch (error) {}
					}
				}
			} catch (error) {
				break;
			}
		}
	} catch (error) {}
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

async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs: number = 120000,
	resetOnActivity: boolean = false,
): Promise<Response> {
	const controller = new AbortController();
	let timeout = setTimeout(() => controller.abort(), timeoutMs);
	const startTime = lastEventTime;

	const resetTimeout = (): void => {
		clearTimeout(timeout);
		timeout = setTimeout(() => controller.abort(), timeoutMs);
	};

	if (resetOnActivity) {
		const interval = setInterval(() => {
			if (lastEventTime > startTime) {
				resetTimeout();
			}
		}, 5000);

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal,
			});
			clearTimeout(timeout);
			clearInterval(interval);
			return response;
		} catch (error: any) {
			clearTimeout(timeout);
			clearInterval(interval);
			if (error.name === "AbortError") {
				throw new Error(`Request timed out after ${timeoutMs}ms`);
			}
			throw error;
		}
	}

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
		});
		clearTimeout(timeout);
		return response;
	} catch (error: any) {
		clearTimeout(timeout);
		if (error.name === "AbortError") {
			throw new Error(`Request timed out after ${timeoutMs}ms`);
		}
		throw error;
	}
}

async function createSession(): Promise<string> {
	const response = await fetchWithTimeout(
		`${SERVER_URL}/session`,
		{
			method: "POST",
			headers: getAuthHeaders(),
			body: JSON.stringify({}),
		},
		10000,
	);

	if (!response.ok) {
		const error = await response.text();
		if (response.status === 401 && !AUTH_PASSWORD) {
			throw new Error(
				"Server requires authentication. Set OPENCODE_SERVER_PASSWORD environment variable.",
			);
		}
		throw new Error(`Failed to create session (${response.status}): ${error}`);
	}

	const session = (await response.json()) as SessionResponse;
	return session.id;
}

async function sendMessage(sessionId: string, message: string) {
	processing = false;
	state.accumulatedResponse = [];
	allEvents = [];

	const response = await fetchWithTimeout(
		`${SERVER_URL}/session/${sessionId}/message`,
		{
			method: "POST",
			headers: getAuthHeaders(),
			body: JSON.stringify({
				model: {
					providerID: config.providerID,
					modelID: config.modelID,
				},
				parts: [{ type: "text", text: message }],
			}),
		},
		180000,
		true,
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to send message (${response.status}): ${error}`);
	}
}

function getAuthHeaders(includeContentType: boolean = true): HeadersInit {
	const headers: HeadersInit = {};
	if (AUTH_PASSWORD) {
		const credentials = Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString("base64");
		headers["Authorization"] = `Basic ${credentials}`;
	}
	if (includeContentType) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
}

// COMMANDS
// ====================

async function runInit(sessionId: string): Promise<void> {
	console.log("Running /init command (analyzing project and creating AGENTS.md)...");
	const response = await fetchWithTimeout(
		`${SERVER_URL}/session/${sessionId}/init`,
		{
			method: "POST",
			headers: getAuthHeaders(),
			body: JSON.stringify({}),
		},
		180000,
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to run /init (${response.status}): ${error}`);
	}

	const result = await response.json();

	console.log();
	console.log(result ? "AGENTS.md created/updated successfully." : "No changes made to AGENTS.md.");
	console.log();
}

async function runModel(sessionId: string): Promise<void> {
	const response = await fetchWithTimeout(
		`${SERVER_URL}/config/providers`,
		{
			method: "GET",
			headers: getAuthHeaders(),
		},
		10000,
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to fetch models (${response.status}): ${error}`);
	}

	const modelResponse = (await response.json()) as ModelResponse;

	modelList = [];
	for (const provider of modelResponse.providers || []) {
		const models = Object.values(provider.models || {});
		for (const model of models) {
			modelList.push({
				providerID: provider.id,
				providerName: provider.name,
				modelID: model.id,
				modelName: model.name || model.id,
			});
		}
	}

	modelList.sort(
		(a, b) =>
			a.providerName.localeCompare(b.providerName) || a.modelName.localeCompare(b.modelName),
	);

	selectedModelIndex = modelList.findIndex(
		(m) => m.providerID === config.providerID && m.modelID === config.modelID,
	);
	if (selectedModelIndex === -1) selectedModelIndex = 0;

	modelSelectionMode = true;

	renderModelList();
}

function clearModelList() {
	process.stdout.write("\x1b[?25l");
	if (modelListLineCount > 0) {
		process.stdout.write(`\x1b[${modelListLineCount}A`);
	}
	readline.cursorTo(process.stdout, 0);
	readline.clearScreenDown(process.stdout);
}

function renderModelList(): void {
	clearModelList();

	const grouped = new Map<string, typeof modelList>();
	for (const model of modelList) {
		const list = grouped.get(model.providerName) || [];
		list.push(model);
		grouped.set(model.providerName, list);
	}

	let globalIndex = 0;
	modelListLineCount = 0;
	console.log("  Select a model (↑/↓ to navigate, Enter to select, Esc to cancel):\n");
	modelListLineCount += 2;
	for (const [providerName, models] of grouped) {
		console.log(`  \x1b[36;1m${providerName}\x1b[0m`);
		modelListLineCount++;
		for (const model of models) {
			const isSelected = globalIndex === selectedModelIndex;
			const isActive = model.providerID === config.providerID && model.modelID === config.modelID;
			const prefix = isSelected ? "  >" : "   -";
			const name = isSelected ? `\x1b[33;1m${model.modelName}\x1b[0m` : model.modelName;
			const status = isActive ? " (active)" : "";

			console.log(`${prefix} ${name}${status}`);
			modelListLineCount++;
			globalIndex++;
		}
	}
	//console.log();
	//modelListLineCount++;
}

async function runUndo(sessionId: string): Promise<void> {
	console.log("Fetching session messages...");

	const messagesRes = await fetchWithTimeout(
		`${SERVER_URL}/session/${sessionId}/message`,
		{
			method: "GET",
			headers: getAuthHeaders(),
		},
		10000,
	);

	if (!messagesRes.ok) {
		const error = await messagesRes.text();
		throw new Error(`Failed to fetch messages (${messagesRes.status}): ${error}`);
	}

	const messages = (await messagesRes.json()) as MessagesResponse[];

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

	const revertRes = await fetchWithTimeout(
		`${SERVER_URL}/session/${sessionId}/revert`,
		{
			method: "POST",
			headers: getAuthHeaders(),
			body: JSON.stringify({
				messageID: lastMessage.info.id,
			}),
		},
		30000,
	);

	if (!revertRes.ok) {
		const error = await revertRes.text();
		throw new Error(`Failed to revert message (${revertRes.status}): ${error}`);
	}

	console.log("Successfully reverted last message.\n");
}

function runDebug(): void {
	console.log("\n🔧 Debug: All parts from the most recent request");
	console.log("=".repeat(50));

	if (allEvents.length === 0) {
		console.log("No parts stored yet. Send a message first.");
	} else {
		for (let part of allEvents) {
			stripLongStrings(part);
		}
		console.log(JSON.stringify(allEvents, null, 2));
	}

	console.log("\n" + "=".repeat(50));
	console.log();
}

function stripLongStrings(target: Record<PropertyKey, any>) {
	for (let prop in target) {
		if (prop !== "text" && prop !== "delta") {
			let value = target[prop];
			if (typeof value === "string") {
				if (value.length > 255) {
					target[prop] = value.substring(0, 252) + "...";
				}
			} else if (typeof value === "object") {
				stripLongStrings(value);
			}
		}
	}
}
