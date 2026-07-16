import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event, FileDiff, Part, Todo, ToolPart } from "@opencode-ai/sdk";
import * as ansi from "./ansi";
import { config } from "./config";
import { isUserTyping, setUserTyping } from "./input";
import { closeLogFile, createLogFile, writeToLog } from "./logs";
import { startPermission } from "./permission";
import { startQuestion } from "./question";
import { render, setTerminalTitle, startAnimation, stopAnimation, writePrompt } from "./render";
import type { State } from "./types";
import { formatDuration } from "./utils";

const SERVER_URL = "http://127.0.0.1:4096";
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

let processing = true;
let retryInterval: ReturnType<typeof setInterval> | null = null;
let requestActive = false;
let requestStartTime: number | null = null;

// Text of a user message injected mid-turn via injectMessage(). The server
// echoes it back as a `text` part, which we drop (see processText) because we
// already rendered it locally as a `# user` line. Cleared on first match.
let pendingUserEcho: string | null = null;

export function isRequestActive(): boolean {
	return requestActive;
}

export function setRequestActive(value: boolean): void {
	requestActive = value;
}

export function getRequestStartTime(): number | null {
	return requestStartTime;
}

// Abort the running request and tear down per-request state. Used when the user
// cancels (Escape) or when a question/permission interrupts the turn.
export async function cancelRequest(state: State): Promise<void> {
	if (state.sessionID) {
		state.client.session.abort({ path: { id: state.sessionID } }).catch(() => {});
	}
	requestActive = false;
	requestStartTime = null;
	await closeLogFile();
}

export function createClient(cwd: string): ReturnType<typeof createOpencodeClient> {
	return createOpencodeClient({
		baseUrl: SERVER_URL,
		headers: AUTH_PASSWORD
			? {
					Authorization: `Basic ${Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString("base64")}`,
				}
			: undefined,
		directory: cwd,
	});
}

export async function createSession(state: State): Promise<string> {
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

export async function validateSession(state: State, sessionID: string): Promise<boolean> {
	try {
		const result = await state.client.session.get({
			path: { id: sessionID },
		});
		return !result.error && result.response.status === 200;
	} catch {
		return false;
	}
}

export async function startEventListener(state: State): Promise<void> {
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
				await processEvent(state, event);
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

// Start a new turn (idle -> busy). Non-blocking: completion is driven by the
// `session.idle` event in processEvent().
export async function sendPrompt(state: State, message: string): Promise<void> {
	processing = false;
	requestActive = true;
	requestStartTime = Date.now();
	state.accumulatedResponse = [];
	state.allEvents = [];
	state.renderedLines = [];
	state.lastFileAfter = new Map();

	await createLogFile();

	await writeToLog(`User: ${message}\n\n`);

	startAnimation(state, requestStartTime);

	const result = await state.client.session.promptAsync({
		path: { id: state.sessionID },
		body: {
			model: {
				providerID: config.providerID,
				modelID: config.modelID,
			},
			parts: [{ type: "text", text: message }],
		},
	});

	if (result.error) {
		stopAnimation();
		requestActive = false;
		requestStartTime = null;
		await closeLogFile();
		throw new Error(
			`Failed to send message (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}
}

// Inject a user message into the currently running turn without starting a new
// request. The server weaves it into the active turn at the next step boundary.
export async function injectMessage(state: State, message: string): Promise<void> {
	await writeToLog(`User (interjected): ${message}\n\n`);

	// The server will echo the injected user message back as a `text` part. Since
	// we're mid-turn (`processing` is already true) processText() would render it
	// as a 💬 response. We echo it ourselves in the caller (as a `# user` line)
	// and drop the server's echo here to avoid a duplicate.
	pendingUserEcho = message;

	const result = await state.client.session.promptAsync({
		path: { id: state.sessionID },
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
			`Failed to inject message (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}
}

let initText = "";

async function processEvent(state: State, event: Event): Promise<void> {
	if (retryInterval && event.type !== "session.status") {
		clearInterval(retryInterval);
		retryInterval = null;
	}

	state.allEvents.push(event);

	switch (event.type) {
		case "message.part.updated": {
			const part = event.properties.part;
			const delta = event.properties.delta;
			if (part.messageID === "msg_init") {
				// @ts-ignore
				initText = part.text;
				break;
			}
			if (part) {
				await processPart(state, part);
			}
			if (delta !== undefined && part) {
				processDelta(state, part.id, delta);
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
				processDelta(state, partID, delta);
			}
			break;
		}

		case "session.diff": {
			const diff = event.properties.diff;
			if (diff && diff.length > 0) {
				await processDiff(state, diff);
			}
			break;
		}

		case "session.idle":
		case "session.status": {
			const isIdle =
				event.type === "session.idle" ||
				(event.type === "session.status" && event.properties.status.type === "idle");
			if (isIdle && requestActive) {
				const duration = requestStartTime ? Date.now() - requestStartTime : null;
				requestActive = false;
				requestStartTime = null;
				stopAnimation();
				process.stdout.write(ansi.CURSOR_SHOW);
				if (retryInterval) {
					clearInterval(retryInterval);
					retryInterval = null;
				}
				await closeLogFile();
				if (initText) {
					const pending = initText;
					initText = "";
					await sendPrompt(state, pending);
				} else if (isUserTyping()) {
					// User was composing an interjection when the turn finished on its
					// own; keep their text as the next prompt and skip the banner.
					setUserTyping(false);
				} else {
					if (duration != null) {
						process.stdout.write("\x07");
						const durationText = formatDuration(duration, true);
						console.log(`  ${ansi.BRIGHT_BLACK}Completed in ${durationText}${ansi.RESET}\n`);
					}
					writePrompt();
				}
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
		}

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
				await processTodos(state, todos);
			}

			break;
		}

		default: {
			// HACK: Dodgy types
			if ((event as any).type === "question.asked") {
				startQuestion(event as any, state);
			} else if (
				(event as any).type === "permission.asked" ||
				(event as any).type === "permission.updated"
			) {
				startPermission(event as any, state);
			}

			break;
		}
	}
}

async function processPart(state: State, part: Part): Promise<void> {
	switch (part.type) {
		case "step-start":
			processStepStart();
			break;

		case "reasoning":
			processReasoning(state, part);
			break;

		case "text":
			if (processing) {
				processText(state, part);
			}
			break;

		case "step-finish":
			break;

		case "tool":
			processToolUse(state, part);
			break;

		default:
			break;
	}
}

function processStepStart() {
	processing = true;
}

async function processReasoning(state: State, part: Part) {
	processing = true;
	let thinkingPart = findLastPart(state, part.id);
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

async function processText(state: State, part: Part) {
	const text = (part as any).text || "";

	// Drop the server's echo of an injected user message (already shown locally).
	if (pendingUserEcho !== null && text.trim() === pendingUserEcho.trim()) {
		pendingUserEcho = null;
		return;
	}

	let responsePart = findLastPart(state, part.id);
	if (!responsePart) {
		responsePart = { key: part.id, title: "response", text };
		state.accumulatedResponse.push(responsePart);
	} else {
		responsePart.text = text;
	}

	const cleanText = ansi.stripAnsiCodes(text.trimStart());
	await writeToLog(`Response:\n\n${cleanText}\n\n`);

	render(state);
}

async function processToolUse(state: State, part: Part) {
	const toolPart = part as ToolPart;
	const toolName = toolPart.tool || "unknown";

	// We don't care about todowrite, a todo list will be shown after anyway
	if (toolName === "todowrite" || toolName === "question") {
		return;
	}

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

function processDelta(state: State, partID: string, delta: string) {
	let responsePart = findLastPart(state, partID);
	if (responsePart) {
		responsePart.text += delta;
	}

	render(state);
}

async function processDiff(state: State, diff: FileDiff[]) {
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
		const diffText = parts.join("\n");
		state.accumulatedResponse.push({ key: "diff", title: "files", text: diffText });

		await writeToLog(`${ansi.stripAnsiCodes(diffText)}\n\n`);

		render(state);
	}
}

async function processTodos(state: State, todos: Todo[]) {
	const parts: string[] = [];

	parts.push("Todo:");
	for (let todo of todos) {
		let todoText = "";
		if (todo.status === "completed") {
			todoText += "- [✓] ";
		} else {
			todoText += "- [ ] ";
		}
		todoText += todo.content;
		parts.push(todoText);
	}

	const todoListText = parts.join("\n");
	state.accumulatedResponse.push({ key: "todo", title: "files", text: todoListText });

	await writeToLog(`${ansi.stripAnsiCodes(todoListText)}\n\n`);

	render(state);
}

function findLastPart(state: State, title: string) {
	for (let i = state.accumulatedResponse.length - 1; i >= 0; i--) {
		const part = state.accumulatedResponse[i];
		if (part?.key === title) {
			return part;
		}
	}
}
