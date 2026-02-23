import type { HeadersInit } from "bun";
import { spawn } from "child_process";
import readline from "readline";
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

let seenParts = new Set();
let processing = true;
let lastEventTime = Date.now();
let renderedLinesCount = 0;
let reasoningText = "";

interface AccumulatedPart {
	title: string;
	text: string;
}

let accumulatedResponse: AccumulatedPart[] = [];

main().catch(console.error);

async function main() {
	const serverProcess = await startOpenCodeServer();

	try {
		const sessionId = await createSession();
		startEventListener();
		console.log("Session created. Type your message and press Enter (Ctrl+C to exit):");
		console.log();

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const ask = (): Promise<void> => {
			return new Promise((resolve) => {
				rl.question("> ", async (input) => {
					if (input.trim()) {
						try {
							const trimmed = input.trim();

							if (trimmed === "/init") {
								await runInit(sessionId);
							} else if (trimmed === "/model" || trimmed === "/models") {
								await runModel(sessionId);
							} else if (trimmed === "/undo") {
								await runUndo(sessionId);
							} else if (trimmed === "/help") {
								console.log("\nAvailable commands:");
								console.log("  /init   - Analyze project and create/update AGENTS.md");
								console.log("  /model  - List available models");
								console.log("  /undo   - Undo last message");
								console.log("  /help   - Show this help message");
								console.log();
							} else {
								console.log();
								console.log("👉 Sending...");
								console.log();
								renderedLinesCount = 2;

								await sendMessage(sessionId, input);
							}
						} catch (error: any) {
							console.error("Error:", error.message);
						}
					}
					ask();
				});
			});
		};

		ask();
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

	switch (event.type) {
		case "message.part.updated":
			processPart(event.properties.part!, event.properties.delta);
			break;

		case "session.diff":
			processDiff(event.properties.diff);
			break;

		default:
			break;
	}
}

function processPart(part: Part, delta: string | undefined): void {
	const partKey = `${part.messageID}-${part.id}`;

	switch (part.type) {
		case "step-start":
			processStepStart();
			break;

		case "reasoning":
			processReasoning(part, partKey, delta);
			break;

		case "text":
			if (processing) {
				processText(part, partKey, delta);
			}
			break;

		case "step-finish":
			break;

		case "tool_use":
			processToolUse(part);
			break;

		default:
			break;
	}
}

function processStepStart() {
	clearRenderedLines();

	reasoningText = "";
	accumulatedResponse.push({ title: "thinking", text: "" });

	render();
	processing = true;
}

function processReasoning(part: Part, partKey: string, delta: string | undefined) {
	if (delta) {
		reasoningText += delta;

		let thinkingPart: AccumulatedPart | null = null;
		let i = accumulatedResponse.length;
		while (i--) {
			if (accumulatedResponse[i].title === "thinking") {
				thinkingPart = accumulatedResponse[i];
				break;
			}
		}
		if (thinkingPart) {
			thinkingPart.text += delta;
		}

		render();
	} else if (part.time?.end) {
		reasoningText = "";
	}
}

function processText(part: Part, partKey: string, delta: string | undefined) {
	if (delta && !seenParts.has(partKey)) {
		seenParts.add(partKey);
		seenParts.add(partKey + "_final");

		accumulatedResponse.push({ title: "response", text: "" });
	}

	if (delta) {
		const responsePart = accumulatedResponse.find((p) => p.title === "response");
		if (responsePart) {
			responsePart.text += delta;
		}
	} else if (part.text && !seenParts.has(partKey + "_final")) {
		seenParts.add(partKey + "_final");

		const responsePart = accumulatedResponse.find((p) => p.title === "response");
		if (responsePart) {
			responsePart.text += part.text + "\n";
		}
	}

	render();
}

function processToolUse(part: Part) {
	const toolText = `🔧 Using tool: ${part.name || "unknown"}`;

	accumulatedResponse.push({ title: "tool", text: toolText });

	render();
}

function processDiff(diff: DiffInfo[] | undefined) {
	let diffText = "";
	if (diff && diff.length > 0) {
		for (const file of diff) {
			const statusIcon = file.status === "added" ? "A" : file.status === "modified" ? "M" : "D";
			const statusLabel =
				file.status === "added" ? "added" : file.status === "modified" ? "modified" : "deleted";
			const addStr = file.additions > 0 ? `+${file.additions}` : "";
			const delStr = file.deletions > 0 ? `-${file.deletions}` : "";
			const stats = [addStr, delStr].filter(Boolean).join(" ");
			const line = `  ${statusIcon} ${file.file} (${statusLabel}) ${stats}`;
			diffText += line + "\n";
		}

		accumulatedResponse.push({ title: "files", text: diffText.trim() });

		render();
	}
}

function writeLine(text?: string) {
	text ??= "";
	process.stdout.write(text + "\n");
}

function clearRenderedLines(): void {
	if (renderedLinesCount > 0) {
		process.stdout.write(`\x1b[${renderedLinesCount}A\x1b[J`);
		renderedLinesCount = 0;
	}
}

function render(): void {
	clearRenderedLines();

	let output = "";

	for (const part of accumulatedResponse) {
		if (part.title === "thinking" && part.text) {
			output += "💭 Thinking...\n";
			output += part.text + "\n";
		} else if (part.title === "response" && part.text) {
			output += "💬 Response:\n";
			output += part.text + "\n";
		} else if (part.title === "tool") {
			output += part.text + "\n";
		} else if (part.title === "files" && part.text) {
			output += part.text + "\n";
		}
	}

	if (output) {
		process.stdout.write(output);
		renderedLinesCount = output.split("\n").length - 1;
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

	serverProcess.stdout.on("data", (data) => {
		if (!started) {
			started = true;
			console.log("OpenCode server started");
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
	seenParts.clear();
	accumulatedResponse = [];

	const response = await fetchWithTimeout(
		`${SERVER_URL}/session/${sessionId}/message`,
		{
			method: "POST",
			headers: getAuthHeaders(),
			body: JSON.stringify({
				model: {
					modelID: "big-pickle",
					providerID: "opencode",
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

	console.log();
	console.log("--- Accumulated Response ---");
	console.log(JSON.stringify(accumulatedResponse, null, 2));
	console.log("----------------------------");
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
	console.log("Fetching available models...");
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

	const config = (await response.json()) as ModelResponse;
	console.log("\nAvailable models:");

	for (const provider of config.providers || []) {
		console.log(`\n${provider.name}:`);
		const models = Object.values(provider.models || {});
		for (const model of models) {
			console.log(`  - ${model.id}: ${model.name || ""}`);
		}
	}
	console.log();
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
