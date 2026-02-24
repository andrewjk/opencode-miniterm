import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Agent, Event, FileDiff, Message, Part, Session, ToolPart } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { config, loadConfig, saveConfig } from "./config";
import { render } from "./render";

type MessagesResponse = Array<{ info: Message; parts: Array<Part> }>;

const SERVER_URL = "http://127.0.0.1:4096";
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

let client: ReturnType<typeof createOpencodeClient>;

const SLASH_COMMANDS = [
	{ command: "/init", description: "Analyze project and create/update AGENTS.md" },
	{ command: "/agents", description: "List and select available agents" },
	{ command: "/models", description: "List and select available models" },
	{ command: "/sessions", description: "List and select sessions" },
	{ command: "/new", description: "Create a new session" },
	{ command: "/undo", description: "Undo changes for the last request" },
	{ command: "/details", description: "Show all parts from the last request" },
	{ command: "/debug", description: "Show raw events from the last request" },
	{ command: "/kill", description: "Abort a session (e.g. /kill ses_123)" },
	{ command: "/exit", description: "Exit the application (you can also /quit)" },
	//{ command: "/quit", description: "Exit the application (alias for /exit)" },
	{ command: "/run", description: "Run a shell command (e.g. `/run git status`)" },
	{ command: "/help", description: "Show this help message" },
];

const ANIMATION_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇"];

function startAnimation(): void {
	if (animationInterval) return;

	let index = 0;
	animationInterval = setInterval(() => {
		process.stdout.write("\r\x1b[1;35m");
		process.stdout.write(`${ANIMATION_CHARS[index]}\x1b[0m`);
		index = (index + 1) % ANIMATION_CHARS.length;
	}, 100);
}

function stopAnimation(): void {
	if (animationInterval) {
		clearInterval(animationInterval);
		animationInterval = null;
	}
	process.stdout.write("\r\x1b[K");
}

let processing = true;
let allEvents: Event[] = [];
let retryInterval: ReturnType<typeof setInterval> | null = null;
let animationInterval: ReturnType<typeof setInterval> | null = null;
let messageAbortController: AbortController | null = null;

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
let modelSearchString = "";
let modelFilteredIndices: number[] = [];

interface AgentInfo {
	id: string;
	name: string;
}

let agentSelectionMode = false;
let agentList: AgentInfo[] = [];
let selectedAgentIndex = 0;
let agentListLineCount = 0;
let agentSearchString = "";
let agentFilteredIndices: number[] = [];

interface SessionInfo {
	id: string;
	title?: string;
	createdAt: number;
	updatedAt: number;
}

let sessionSelectionMode = false;
let sessionList: SessionInfo[] = [];
let selectedSessionIndex = 0;
let sessionListLineCount = 0;
let sessionListOffset = 0;
let sessionSearchString = "";
let sessionFilteredIndices: number[] = [];

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

function updateAgentFilter(): void {
	if (!agentSearchString) {
		agentFilteredIndices = agentList.map((_, i) => i);
	} else {
		const search = agentSearchString.toLowerCase();
		agentFilteredIndices = agentList
			.map((agent, i) => ({ agent, index: i }))
			.filter(({ agent }) => agent.name.toLowerCase().includes(search))
			.map(({ index }) => index);
	}
	if (agentFilteredIndices.length > 0) {
		selectedAgentIndex = agentFilteredIndices.indexOf(
			agentList.findIndex((a) => a.id === config.agentID),
		);
		if (selectedAgentIndex === -1) selectedAgentIndex = 0;
	}
}

function updateModelFilter(): void {
	if (!modelSearchString) {
		modelFilteredIndices = modelList.map((_, i) => i);
	} else {
		const search = modelSearchString.toLowerCase();
		modelFilteredIndices = modelList
			.map((model, i) => ({ model, index: i }))
			.filter(({ model }) => model.modelName.toLowerCase().includes(search))
			.map(({ index }) => index);
	}
	if (modelFilteredIndices.length > 0) {
		selectedModelIndex = modelFilteredIndices.indexOf(
			modelList.findIndex(
				(m) => m.providerID === config.providerID && m.modelID === config.modelID,
			),
		);
		if (selectedModelIndex === -1) selectedModelIndex = 0;
	}
}

function updateSessionFilter(): void {
	if (!sessionSearchString) {
		sessionFilteredIndices = sessionList.map((_, i) => i);
	} else {
		const search = sessionSearchString.toLowerCase();
		sessionFilteredIndices = sessionList
			.map((session, i) => ({ session, index: i }))
			.filter(
				({ session }) =>
					session.title?.toLowerCase().includes(search) ||
					session.id.toLowerCase().includes(search),
			)
			.map(({ index }) => index);
	}
	if (sessionFilteredIndices.length > 0) {
		selectedSessionIndex = sessionFilteredIndices.indexOf(
			sessionList.findIndex((s) => s.id === config.sessionID),
		);
		if (selectedSessionIndex === -1) selectedSessionIndex = 0;
	}
}

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
		let sessionId: string;
		let isNewSession = false;

		const initialSessionId = config.sessionID;
		if (!initialSessionId || !(await validateSession(initialSessionId))) {
			sessionId = await createSession();
			isNewSession = true;
			config.sessionID = sessionId;
			saveConfig();
		} else {
			sessionId = initialSessionId;
		}

		startEventListener();

		const activeDisplay = await getActiveDisplay();

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
				return SLASH_COMMANDS.map((c) => c.command).filter((cmd) => cmd.startsWith(text));
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
					if (input === "/init") {
						await runInit(sessionId);
					} else if (input === "/agents") {
						await runAgents();
					} else if (input === "/models") {
						await runModel();
					} else if (input === "/sessions") {
						await runSessions();
					} else if (input === "/new") {
						sessionId = await runNew();
					} else if (input === "/undo") {
						await runUndo(sessionId);
					} else if (input === "/details") {
						runDetails();
					} else if (input === "/debug") {
						runDebug();
					} else if (input.startsWith("/kill ")) {
						const sessionIdToKill = input.slice(6).trim();
						await runKill(sessionIdToKill);
					} else if (input.startsWith("/run ")) {
						const cmd = input.slice(5);
						const child = spawn(cmd, [], { shell: true });
						child.stdout?.on("data", (data) => {
							process.stdout.write(data.toString());
						});
						child.stderr?.on("data", (data) => {
							process.stderr.write(data.toString());
						});
						await new Promise<void>((resolve) => {
							child.on("close", (code) => {
								if (code !== 0) {
									console.log(`\x1b[90mCommand exited with code ${code}\x1b[0m`);
								}
								console.log();
								resolve();
							});
						});
					} else if (input === "/exit" || input === "/quit") {
						console.log(`\x1b[90mGoodbye!\x1b[0m`);
						process.exit(0);
					} else if (input === "/help") {
						for (const cmd of SLASH_COMMANDS) {
							console.log(`  ${cmd.command} - ${cmd.description}`);
						}
						console.log();
					} else {
						process.stdout.write("\x1b[?25l");

						startAnimation();

						await sendMessage(sessionId, input);
					}
				} catch (error: any) {
					if (error.message !== "Request cancelled") {
						stopAnimation();
						console.error("Error:", error.message);
					}
				}
			}

			if (!modelSelectionMode && !agentSelectionMode) {
				writePrompt();
			}
		};

		process.stdin.on("keypress", async (str, key) => {
			if (sessionSelectionMode) {
				if (key.name === "up") {
					if (selectedSessionIndex === 0) {
						selectedSessionIndex = sessionFilteredIndices.length - 1;
					} else {
						selectedSessionIndex--;
					}
					const currentIndex = sessionFilteredIndices[selectedSessionIndex];
					if (
						currentIndex !== undefined &&
						currentIndex < sessionListOffset &&
						sessionListOffset > 0
					) {
						sessionListOffset -= 10;
						if (sessionListOffset < 0) sessionListOffset = 0;
					}
					renderSessionList();
					return;
				}
				if (key.name === "down") {
					if (selectedSessionIndex === sessionFilteredIndices.length - 1) {
						selectedSessionIndex = 0;
					} else {
						selectedSessionIndex++;
					}
					const currentIndex = sessionFilteredIndices[selectedSessionIndex];
					if (
						currentIndex !== undefined &&
						currentIndex >= sessionListOffset + 10 &&
						sessionListOffset + 10 < sessionList.length
					) {
						sessionListOffset += 10;
					}
					renderSessionList();
					return;
				}
				if (key.name === "escape") {
					clearSessionList();
					process.stdout.write("\x1b[?25h");
					sessionSelectionMode = false;
					sessionList = [];
					selectedSessionIndex = 0;
					sessionListOffset = 0;
					sessionListLineCount = 0;
					sessionSearchString = "";
					sessionFilteredIndices = [];
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					writePrompt();
					return;
				}
				if (key.name === "return") {
					sessionListLineCount++;
					clearSessionList();
					process.stdout.write("\x1b[?25h");
					const selectedIndex = sessionFilteredIndices[selectedSessionIndex];
					const selected = selectedIndex !== undefined ? sessionList[selectedIndex] : undefined;
					sessionSelectionMode = false;
					sessionList = [];
					selectedSessionIndex = 0;
					sessionListOffset = 0;
					sessionListLineCount = 0;
					sessionSearchString = "";
					sessionFilteredIndices = [];
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					if (selected) {
						config.sessionID = selected.id;
						saveConfig();
						console.log(`Switched to session: ${selected.id.substring(0, 8)}...`);
						if (selected.title) {
							console.log(`  Title: ${selected.title}`);
						}
						console.log();
					}
					writePrompt();
					return;
				}
				if (key.name === "backspace") {
					sessionSearchString = sessionSearchString.slice(0, -1);
					updateSessionFilter();
					selectedSessionIndex = 0;
					renderSessionList();
					return;
				}
				if (str && str.length === 1) {
					sessionSearchString += str;
					updateSessionFilter();
					selectedSessionIndex = 0;
					renderSessionList();
					return;
				}
				return;
			}

			if (agentSelectionMode) {
				if (key.name === "up") {
					if (selectedAgentIndex === 0) {
						selectedAgentIndex = agentFilteredIndices.length - 1;
					} else {
						selectedAgentIndex--;
					}
					renderAgentList();
					return;
				}
				if (key.name === "down") {
					if (selectedAgentIndex === agentFilteredIndices.length - 1) {
						selectedAgentIndex = 0;
					} else {
						selectedAgentIndex++;
					}
					renderAgentList();
					return;
				}
				if (key.name === "escape") {
					clearAgentList();
					process.stdout.write("\x1b[?25h");
					agentSelectionMode = false;
					agentList = [];
					selectedAgentIndex = 0;
					agentListLineCount = 0;
					agentSearchString = "";
					agentFilteredIndices = [];
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					writePrompt();
					return;
				}
				if (key.name === "return") {
					agentListLineCount++;
					clearAgentList();
					process.stdout.write("\x1b[?25h");
					const selectedIndex = agentFilteredIndices[selectedAgentIndex];
					const selected = selectedIndex !== undefined ? agentList[selectedIndex] : undefined;
					agentSelectionMode = false;
					agentList = [];
					selectedAgentIndex = 0;
					agentListLineCount = 0;
					agentSearchString = "";
					agentFilteredIndices = [];
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					if (selected) {
						config.agentID = selected.id;
						saveConfig();
						const activeDisplay = await getActiveDisplay();
						console.log(activeDisplay);
						console.log();
					}
					writePrompt();
					return;
				}
				if (key.name === "backspace") {
					agentSearchString = agentSearchString.slice(0, -1);
					updateAgentFilter();
					selectedAgentIndex = 0;
					renderAgentList();
					return;
				}
				if (str && str.length === 1) {
					agentSearchString += str;
					updateAgentFilter();
					selectedAgentIndex = 0;
					renderAgentList();
					return;
				}
				return;
			}

			if (modelSelectionMode) {
				if (key.name === "up") {
					if (selectedModelIndex === 0) {
						selectedModelIndex = modelFilteredIndices.length - 1;
					} else {
						selectedModelIndex--;
					}
					renderModelList();
					return;
				}
				if (key.name === "down") {
					if (selectedModelIndex === modelFilteredIndices.length - 1) {
						selectedModelIndex = 0;
					} else {
						selectedModelIndex++;
					}
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
					modelSearchString = "";
					modelFilteredIndices = [];
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					writePrompt();
					return;
				}
				if (key.name === "return") {
					modelListLineCount++;
					clearModelList();
					process.stdout.write("\x1b[?25h");
					const selectedIndex = modelFilteredIndices[selectedModelIndex];
					const selected = selectedIndex !== undefined ? modelList[selectedIndex] : undefined;
					modelSelectionMode = false;
					modelList = [];
					selectedModelIndex = 0;
					modelListLineCount = 0;
					modelSearchString = "";
					modelFilteredIndices = [];
					readline.cursorTo(process.stdout, 0);
					readline.clearScreenDown(process.stdout);
					if (selected) {
						config.providerID = selected.providerID;
						config.modelID = selected.modelID;
						saveConfig();
						const activeDisplay = await getActiveDisplay();
						console.log(activeDisplay);
						console.log();
					}
					writePrompt();
					return;
				}
				if (key.name === "backspace") {
					modelSearchString = modelSearchString.slice(0, -1);
					updateModelFilter();
					selectedModelIndex = 0;
					renderModelList();
					return;
				}
				if (str && str.length === 1) {
					modelSearchString += str;
					updateModelFilter();
					selectedModelIndex = 0;
					renderModelList();
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
	allEvents.push(event);

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
				console.error(`\n\x1b[31mError:\x1b[0m ${message}`);
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

function writePrompt() {
	stopAnimation();
	process.stdout.write("\x1b[?25h");
	process.stdout.write("\x1b[1;35m# \x1b[0m");
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

	const session = result.data as Session;
	return session.id;
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
	allEvents = [];

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

async function getActiveDisplay(): Promise<string> {
	let agentName = "";
	let providerName = "";
	let modelName = "";
	try {
		const [agentsResult, providersResult] = await Promise.all([
			client.app.agents(),
			client.config.providers(),
		]);
		if (!agentsResult.error) {
			const agents = agentsResult.data || [];
			const agent = agents.find((a: Agent) => a.name === config.agentID);
			if (agent) {
				agentName = agent.name.substring(0, 1).toUpperCase() + agent.name.substring(1);
			}
		}
		if (!providersResult.error) {
			const providers = providersResult.data?.providers || [];
			for (const provider of providers) {
				const models = Object.values(provider.models || {});
				for (const model of models) {
					if (provider.id === config.providerID && model.id === config.modelID) {
						providerName = provider.name;
						modelName = model.name || model.id;
						break;
					}
				}
				if (providerName) break;
			}
		}
	} catch (error) {}

	const parts: string[] = [];
	if (agentName) {
		parts.push(`\x1b[36m${agentName}\x1b[0m`);
	}
	if (modelName) {
		let modelPart = `\x1b[97m${modelName}\x1b[0m`;
		if (providerName) {
			modelPart += ` \x1b[90m(${providerName})\x1b[0m`;
		}
		parts.push(modelPart);
	}

	return parts.join("  ");
}

// COMMANDS
// ====================

async function runAgents(): Promise<void> {
	const result = await client.app.agents();

	if (result.error) {
		throw new Error(
			`Failed to fetch agents (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	agentList = (result.data || []).map((agent: Agent) => ({
		id: agent.name,
		name: agent.name,
	}));

	agentSearchString = "";
	updateAgentFilter();

	agentSelectionMode = true;

	renderAgentList();
}

function clearAgentList() {
	process.stdout.write("\x1b[?25l");
	if (agentListLineCount > 0) {
		process.stdout.write(`\x1b[${agentListLineCount}A`);
	}
	readline.cursorTo(process.stdout, 0);
	readline.clearScreenDown(process.stdout);
}

function renderAgentList(): void {
	clearAgentList();

	agentListLineCount = 0;
	console.log("  \x1b[36;1mAvailable Agents\x1b[0m");
	agentListLineCount++;

	if (agentSearchString) {
		console.log(`  \x1b[90mFilter: \x1b[0m\x1b[33m${agentSearchString}\x1b[0m`);
		agentListLineCount++;
	}

	for (let i = 0; i < agentFilteredIndices.length; i++) {
		const globalIndex = agentFilteredIndices[i]!;
		const agent = agentList[globalIndex];
		if (!agent) continue;
		const isSelected = i === selectedAgentIndex;
		const isActive = agent.id === config.agentID;
		const prefix = isSelected ? "  >" : "   -";
		const name = isSelected ? `\x1b[33;1m${agent.name}\x1b[0m` : agent.name;
		const status = isActive ? " (active)" : "";

		console.log(`${prefix} ${name}${status}`);
		agentListLineCount++;
	}
}

async function runInit(sessionId: string): Promise<void> {
	console.log("Running /init command (analyzing project and creating AGENTS.md)...");
	const result = await client.session.init({
		path: { id: sessionId },
	});

	if (result.error) {
		throw new Error(
			`Failed to run /init (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	console.log();
	console.log(
		result.data ? "AGENTS.md created/updated successfully." : "No changes made to AGENTS.md.",
	);
	console.log();
	console.log();
	console.log(
		result.data ? "AGENTS.md created/updated successfully." : "No changes made to AGENTS.md.",
	);
	console.log();
}

async function runModel(): Promise<void> {
	const result = await client.config.providers();

	if (result.error) {
		throw new Error(
			`Failed to fetch models (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	const providers = result.data?.providers || [];

	modelList = [];
	for (const provider of providers) {
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

	modelSearchString = "";
	updateModelFilter();

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

	const grouped = new Map<string, { models: typeof modelList; startIndices: number[] }>();
	let currentIndex = 0;
	for (const model of modelList) {
		const existing = grouped.get(model.providerName);
		if (existing) {
			existing.models.push(model);
			existing.startIndices.push(currentIndex);
		} else {
			grouped.set(model.providerName, { models: [model], startIndices: [currentIndex] });
		}
		currentIndex++;
	}

	modelListLineCount = 0;
	if (modelSearchString) {
		console.log(`  \x1b[90mFilter: \x1b[0m\x1b[33m${modelSearchString}\x1b[0m`);
		modelListLineCount++;
	}

	for (const [providerName, data] of grouped) {
		const filteredModelsWithIndices = data.models
			.map((model, i) => ({ model, globalIndex: data.startIndices[i]! }))
			.filter(({ globalIndex }) => modelFilteredIndices.includes(globalIndex));

		if (filteredModelsWithIndices.length === 0) continue;

		console.log(`  \x1b[36;1m${providerName}\x1b[0m`);
		modelListLineCount++;

		for (let i = 0; i < filteredModelsWithIndices.length; i++) {
			const { model, globalIndex } = filteredModelsWithIndices[i]!;
			const filteredIndex = modelFilteredIndices.indexOf(globalIndex);
			const isSelected = filteredIndex === selectedModelIndex;
			const isActive = model.providerID === config.providerID && model.modelID === config.modelID;
			const prefix = isSelected ? "  >" : "   -";
			const name = isSelected ? `\x1b[33;1m${model.modelName}\x1b[0m` : model.modelName;
			const status = isActive ? " (active)" : "";

			console.log(`${prefix} ${name}${status}`);
			modelListLineCount++;
		}
	}
}

async function runUndo(sessionId: string): Promise<void> {
	console.log("Fetching session messages...");

	const messagesRes = await client.session.messages({
		path: { id: sessionId },
	});

	if (messagesRes.error) {
		throw new Error(
			`Failed to fetch messages (${messagesRes.response.status}): ${JSON.stringify(messagesRes.error)}`,
		);
	}

	const messages = messagesRes.data as MessagesResponse;

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

	const revertRes = await client.session.revert({
		path: { id: sessionId },
		body: {
			messageID: lastMessage.info.id,
		},
	});

	if (revertRes.error) {
		throw new Error(
			`Failed to revert message (${revertRes.response.status}): ${JSON.stringify(revertRes.error)}`,
		);
	}

	console.log("Successfully reverted last message.\n");
}

async function runNew(): Promise<string> {
	const newSessionId = await createSession();
	config.sessionID = newSessionId;
	saveConfig();

	const activeDisplay = await getActiveDisplay();
	console.log(activeDisplay);
	console.log(`Created new session`);
	console.log();

	return newSessionId;
}

function runDetails(): void {
	render(state, true);
}

async function runSessions(): Promise<void> {
	const result = await client.session.list();

	if (result.error) {
		throw new Error(
			`Failed to fetch sessions (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	const sessions = (result.data as Session[]) || [];

	if (sessions.length === 0) {
		console.log("No sessions found. Creating a new session...");
		const newSessionId = await createSession();
		config.sessionID = newSessionId;
		saveConfig();
		console.log(`Created new session: ${newSessionId.substring(0, 8)}...\n`);
		return;
	}

	sessionList = sessions.map((session) => ({
		id: session.id,
		title: session.title,
		createdAt: session.time?.created || Date.now(),
		updatedAt: session.time?.updated || Date.now(),
	}));

	sessionList.sort((a, b) => b.updatedAt - a.updatedAt);

	sessionSearchString = "";
	updateSessionFilter();

	sessionListOffset = Math.floor(selectedSessionIndex / 10) * 10;
	if (sessionListOffset < 0) sessionListOffset = 0;

	sessionSelectionMode = true;

	renderSessionList();
}

function clearSessionList() {
	process.stdout.write("\x1b[?25l");
	if (sessionListLineCount > 0) {
		process.stdout.write(`\x1b[${sessionListLineCount}A`);
	}
	readline.cursorTo(process.stdout, 0);
	readline.clearScreenDown(process.stdout);
}

function renderSessionList(): void {
	clearSessionList();

	sessionListLineCount = 0;
	console.log("  \x1b[36;1mAvailable Sessions\x1b[0m");
	sessionListLineCount++;

	if (sessionSearchString) {
		console.log(`  \x1b[90mFilter: \x1b[0m\x1b[33m${sessionSearchString}\x1b[0m`);
		sessionListLineCount++;
	}

	const filteredSessions = sessionList.filter((_, i) => sessionFilteredIndices.includes(i));
	const recentSessions = filteredSessions.slice(sessionListOffset, sessionListOffset + 10);
	const groupedByDate = recentSessions.reduce(
		(acc, session) => {
			const date = new Date(session.updatedAt).toLocaleDateString();
			if (!acc[date]) {
				acc[date] = [];
			}
			acc[date].push(session);
			return acc;
		},
		{} as Record<string, typeof recentSessions>,
	);

	for (const [date, sessions] of Object.entries(groupedByDate)) {
		console.log(`  \x1b[90m${date}\x1b[0m`);
		sessionListLineCount++;

		for (const session of sessions) {
			const globalIndex = sessionList.indexOf(session);
			const filteredIndex = sessionFilteredIndices.indexOf(globalIndex);
			const isSelected = filteredIndex === selectedSessionIndex;
			const isActive = session.id === config.sessionID;
			const prefix = isSelected ? "  >" : "   -";
			const title = session.title || "(no title)";
			const name = isSelected ? `\x1b[33;1m${title}\x1b[0m` : title;
			const status = isActive ? " (active)" : "";

			console.log(`${prefix} ${name}${status}`);
			sessionListLineCount++;
		}
	}
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

async function runKill(sessionIdToKill: string): Promise<void> {
	if (!sessionIdToKill) {
		console.log("Usage: /kill <session_id>");
		return;
	}

	const result = await client.session.abort({
		path: { id: sessionIdToKill },
	});

	if (result.error) {
		throw new Error(
			`Failed to abort session (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	console.log(`Session aborted successfully.`);
	console.log();
}

function stripLongStrings(target: Record<PropertyKey, any>) {
	for (const prop in target) {
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
