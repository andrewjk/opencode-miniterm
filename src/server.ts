import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event, FileDiff, Part, Todo, ToolPart } from "@opencode-ai/sdk";
import * as ansi from "./ansi";
import { config } from "./config";
import {
	afterOutputPaint,
	clearTodoSummary,
	isUserTyping,
	navigateToPromptRow,
	setTodoSummary,
	setUserTyping,
} from "./input";
import { closeLogFile, createLogFile, writeToLog } from "./logs";
import { getPermissionState, startPermission } from "./permission";
import { getQuestionState, startQuestion } from "./question";
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

// Latest todo set, used to drive the "X/Y tasks done" summary above the
// spinner. `todos` holds the most recent set; `frozenDone` captures the best
// (max) done count so a completed set stays at "X/X" until a new set arrives
// or the prompt completes.
let currentTodos: Todo[] | null = null;
let frozenDone = 0;

// Subagents dispatched during the active turn. Each `task` tool part marks a
// subagent invocation (agent name + description). Child-session streaming
// events (text/tool/delta) are routed into the matching subagent's buffer and
// rendered as a compact box in the output region instead of dumped into the
// parent's output. The list is cleared when the turn goes idle or a new prompt
// starts.
interface SubagentEntry {
	kind: "text" | "tool";
	key: string;
	text: string;
}
interface ActiveSubagent {
	id: string;
	agent: string;
	description: string;
	sessionID: string | null;
	status: "running" | "completed" | "error";
	elapsed: number | null;
	entries: SubagentEntry[];
}
let activeSubagents: ActiveSubagent[] = [];
const SUBAGENT_MAX_ENTRIES = 40;

// Token/cost stats from the most recent assistant message, shown in the
// completion banner after a turn finishes.
interface TokenStats {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}
let lastTokenStats: TokenStats | null = null;

// Error from the most recent turn (`session.error` event or an `error` field
// on the completed assistant message). Shown at turn end instead of the
// completion banner so the user sees why the request stopped.
let lastError: string | null = null;

// Context window (in tokens) for the active model, used to show the cached
// token percentage. Resolved lazily from the providers config and cached.
let cachedContextLimit: number | null = null;

async function resolveContextLimit(
	client: ReturnType<typeof createOpencodeClient>,
): Promise<number | null> {
	if (cachedContextLimit !== null) return cachedContextLimit;
	try {
		const result = await client.config.providers();
		if (!result.error && result.data?.providers) {
			const provider = result.data.providers.find((p) => p.id === config.providerID);
			const model = provider?.models ? provider.models[config.modelID] : undefined;
			if (model?.limit?.context) {
				cachedContextLimit = model.limit.context;
				return cachedContextLimit;
			}
		}
	} catch {
		// ignore — percentage just won't show
	}
	cachedContextLimit = 0;
	return null;
}

export function isRequestActive(): boolean {
	return requestActive;
}

export function setRequestActive(value: boolean): void {
	requestActive = value;
}

export function getRequestStartTime(): number | null {
	return requestStartTime;
}

// Pending question/permission prompts that arrived while another prompt
// overlay was already on screen. Only one overlay can own the screen at a
// time, so extras are queued (FIFO) and shown one after another as each is
// answered. Without this, a second prompt event would overwrite the active
// prompt's state and render the first prompt unanswerable.
interface PendingPrompt {
	kind: "question" | "permission";
	event: any;
}
let pendingPrompts: PendingPrompt[] = [];

// True while a question or permission prompt owns the screen. While active,
// subagent/parent output repaints are suppressed so they don't clobber the
// prompt overlay; the relevant session is blocked waiting for the answer, and
// rendering resumes once the overlay is dismissed.
function promptOverlayActive(): boolean {
	const q = getQuestionState();
	if (q?.active) return true;
	const p = getPermissionState();
	return !!p?.active;
}

// Does `event` describe the prompt that's currently being shown? Used to let a
// same-ID refresh (e.g. `permission.updated`) pass through instead of queueing
// behind itself.
function activePromptMatches(kind: "question" | "permission", event: any): boolean {
	const id = event?.properties?.id;
	if (!id) return false;
	if (kind === "question") return getQuestionState()?.questionID === id;
	return getPermissionState()?.permissionID === id;
}

// Route an incoming prompt event: start it now if the screen is free (or it's
// a refresh of the active prompt), otherwise queue it behind whatever is
// showing. Dedupes by ID so a chatty `permission.updated` stream doesn't pile
// up duplicate entries for the same pending permission.
function dispatchPrompt(state: State, kind: "question" | "permission", event: any): void {
	if (promptOverlayActive() && !activePromptMatches(kind, event)) {
		const id = event?.properties?.id;
		if (id) {
			pendingPrompts = pendingPrompts.filter(
				(p) => !(p.kind === kind && p.event?.properties?.id === id),
			);
		}
		pendingPrompts.push({ kind, event });
		return;
	}
	if (activeSubagents.length > 0) render(state);
	if (kind === "question") startQuestion(event, state);
	else startPermission(event, state);
}

// Called by question.ts/permission.ts once they've dismissed their overlay.
// Shows the next queued prompt if any, returning true when one took over the
// screen (so the caller knows not to resume the spinner / write a fresh prompt).
export function drainPendingPrompt(state: State): boolean {
	const next = pendingPrompts.shift();
	if (!next) return false;
	if (next.kind === "question") startQuestion(next.event, state);
	else startPermission(next.event, state);
	return true;
}

// Abort the running request and tear down per-request state. Used when the user
// cancels (Escape) or when a question/permission interrupts the turn.
export async function cancelRequest(state: State): Promise<void> {
	if (state.sessionID) {
		state.client.session.abort({ path: { id: state.sessionID } }).catch(() => {});
	}
	requestActive = false;
	requestStartTime = null;
	activeSubagents = [];
	pendingPrompts = [];
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

// Bring the app into "request active" state and reset per-turn output. Shared
// by sendPrompt (a request we started) and external requests we're following
// (a session already busy when we switch to it, or one that goes busy while
// we're watching). Callers set `processing` to the desired initial value first.
export function startRequestTracking(state: State): void {
	if (requestActive) return;
	requestActive = true;
	requestStartTime = Date.now();
	state.accumulatedResponse = [];
	state.allEvents = [];
	state.renderedLines = [];
	state.lastFileAfter = new Map();
	lastTokenStats = null;
	lastError = null;
	currentTodos = null;
	frozenDone = 0;
	activeSubagents = [];
	pendingPrompts = [];
	clearTodoSummary();
	startAnimation(state, requestStartTime);
}

// After switching to a session, check whether it's already running a request on
// the server (e.g. started from another client). If so, start tracking it so
// the streamed parts render and the eventual `session.idle` completes normally.
// The SSE `session.status busy` handler is a fallback for requests that start
// after the switch.
export async function startTrackingIfSessionBusy(state: State): Promise<void> {
	if (requestActive) return;
	try {
		const result = await state.client.session.status();
		if (!result.error && result.data && result.data[state.sessionID]?.type === "busy") {
			processing = true;
			startRequestTracking(state);
		}
	} catch {
		// ignore — the SSE busy event will handle it if we can't query status
	}
}

// Start a new turn (idle -> busy). Non-blocking: completion is driven by the
// `session.idle` event in processEvent().
export async function sendPrompt(state: State, message: string): Promise<void> {
	processing = false;
	startRequestTracking(state);

	await createLogFile();

	await writeToLog(`User: ${message}\n\n`);

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

// The SSE stream multiplexes events from the parent session and all child
// (subagent) sessions. This returns the session an event belongs to so callers
// can route child events into the owning subagent's buffer instead of the
// parent's output.
function eventSessionID(event: Event): string | undefined {
	const sid = (event as any).properties?.sessionID;
	return typeof sid === "string" ? sid : undefined;
}

export async function processEvent(state: State, event: Event): Promise<void> {
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
			const sid = eventSessionID(event);
			if (sid && sid !== state.sessionID) {
				const sa = activeSubagents.find((s) => s.sessionID === sid);
				if (sa) {
					if (part) processSubagentPart(state, sa, part);
					if (delta !== undefined && part) processSubagentDelta(state, sa, part.id, delta);
				}
				// Absorb child events (known or not) so they never pollute the
				// parent's output region.
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
			const sid = eventSessionID(event);
			if (sid && sid !== state.sessionID) {
				const sa = activeSubagents.find((s) => s.sessionID === sid);
				if (sa && partID !== undefined && delta !== undefined) {
					processSubagentDelta(state, sa, partID, delta);
				}
				break;
			}
			if (partID !== undefined && delta !== undefined) {
				processDelta(state, partID, delta);
			}
			break;
		}

		case "session.diff": {
			const diffSid = eventSessionID(event);
			if (diffSid && diffSid !== state.sessionID) break;
			const diff = event.properties.diff;
			if (diff && diff.length > 0) {
				await processDiff(state, diff);
			}
			break;
		}

		case "session.idle":
		case "session.status": {
			const statusSid = eventSessionID(event);
			// Child (subagent) session lifecycle events are not turn boundaries
			// for the parent — ignore them entirely.
			if (statusSid && statusSid !== state.sessionID) {
				break;
			}
			// A request we didn't start is running on the active session (e.g. it
			// went busy after we switched to it). Start tracking it so parts render
			// and the turn-end idle completes normally. When we started the request
			// ourselves (requestActive), leave `processing` alone — it suppresses
			// the user's message echo until the first step-start.
			if (
				event.type === "session.status" &&
				event.properties.status.type === "busy" &&
				!requestActive
			) {
				processing = true;
				startRequestTracking(state);
			}
			const isIdle =
				event.type === "session.idle" ||
				(event.type === "session.status" && event.properties.status.type === "idle");
			if (isIdle && requestActive) {
				// A subagent (task tool) finishing can surface a transient
				// session.idle before the parent turn is truly done. Don't tear down
				// the request — and bring back the spinner — while subagents are still
				// active; wait for the real turn-end idle instead. Skip the repaint
				// entirely if a question/permission overlay is on screen.
				if (activeSubagents.length > 0) {
					if (!promptOverlayActive()) {
						startAnimation(state, requestStartTime ?? undefined);
						render(state);
					}
					break;
				}
				const duration = requestStartTime ? Date.now() - requestStartTime : null;
				requestActive = false;
				requestStartTime = null;
				activeSubagents = [];
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
					// stopAnimation() above wiped the input row, so repaint the live
					// area (spinner gone, todo summary and typed text kept). This
					// also re-syncs the header-row tracking with what's on screen.
					navigateToPromptRow();
					afterOutputPaint();
				} else {
					const turnError = lastError;
					lastError = null;
					if (turnError) {
						process.stdout.write("\x07");
						console.log(`\n  ${ansi.RED}Error:${ansi.RESET} ${turnError}\n`);
					} else if (duration != null) {
						process.stdout.write("\x07");
						const durationText = formatDuration(duration, true);
						console.log(`  ${ansi.BRIGHT_BLACK}Completed in ${durationText}${ansi.RESET}`);

						if (lastTokenStats) {
							const cachedTotal = lastTokenStats.cacheRead + lastTokenStats.cacheWrite;
							const contextLimit = await resolveContextLimit(state.client);

							const parts: string[] = [];
							parts.push(`${lastTokenStats.input} in`);
							parts.push(`${lastTokenStats.output} out`);
							parts.push(`${cachedTotal} cached`);
							if (contextLimit && contextLimit > 0) {
								const pct = ((cachedTotal / contextLimit) * 100).toFixed(1);
								parts.push(`${pct}%`);
							}
							parts.push(`$${lastTokenStats.cost.toFixed(4)}`);
							console.log(`  ${ansi.BRIGHT_BLACK}${parts.join(" · ")}${ansi.RESET}`);
						}

						console.log(`  ${ansi.BRIGHT_BLACK}${process.cwd()}${ansi.RESET}\n`);
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

		case "message.updated": {
			const msgSid = eventSessionID(event);
			if (msgSid && msgSid !== state.sessionID) break;
			const info = event.properties?.info;
			if (info && info.role === "assistant") {
				if (info.tokens) {
					lastTokenStats = {
						input: info.tokens.input ?? 0,
						output: info.tokens.output ?? 0,
						reasoning: info.tokens.reasoning ?? 0,
						cacheRead: info.tokens.cache?.read ?? 0,
						cacheWrite: info.tokens.cache?.write ?? 0,
						cost: info.cost ?? 0,
					};
				}
				// Fallback: some providers surface the failure only on the
				// assistant message, not via a `session.error` event.
				const msgError = (info as any).error;
				if (msgError) {
					lastError = msgError?.data?.message || msgError?.message || JSON.stringify(msgError);
				}
			}
			break;
		}

		case "session.error": {
			const err = event.properties.error;
			if (err) {
				lastError = (err as any)?.data?.message || (err as any)?.message || JSON.stringify(err);
			}
			break;
		}

		case "todo.updated": {
			const todoSid = eventSessionID(event);
			if (todoSid && todoSid !== state.sessionID) break;
			const todos = event.properties.todos;
			if (todos) {
				await processTodos(state, todos);
			}

			break;
		}

		default: {
			// HACK: Dodgy types
			if ((event as any).type === "question.asked") {
				dispatchPrompt(state, "question", event);
			} else if (
				(event as any).type === "permission.asked" ||
				(event as any).type === "permission.updated"
			) {
				dispatchPrompt(state, "permission", event);
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

	if (toolName === "task") {
		await processTaskSubagent(state, part);
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

async function processTaskSubagent(state: State, part: Part) {
	const toolPart = part as ToolPart;
	const st = toolPart.state as Record<string, any>;
	const status = st["status"] as string;

	// The initial "pending" update carries an empty input; wait for "running"
	// where subagent_type / description / title become available.
	if (status === "pending") return;

	const input = (st["input"] || {}) as Record<string, any>;
	const agent: string = input["subagent_type"] || "subagent";
	const description: string = st["title"] || input["description"] || "";
	const meta = (st["metadata"] || {}) as Record<string, any>;
	const childSessionID = typeof meta["sessionId"] === "string" ? meta["sessionId"] : null;

	if (status === "running") {
		upsertActiveSubagent(part.id, agent, description, childSessionID);
		const sa = activeSubagents.find((s) => s.id === part.id);
		if (sa) syncSubagentBox(state, sa, true);
		await writeToLog(`Subagent ${agent}: ${ansi.stripAnsiCodes(description)}\n\n`);
		return;
	}

	// completed or error
	const time = st["time"] || {};
	const elapsed =
		typeof time["start"] === "number" && typeof time["end"] === "number"
			? time["end"] - time["start"]
			: null;
	const sa = activeSubagents.find((s) => s.id === part.id);
	if (sa) {
		sa.status = status === "error" ? "error" : "completed";
		sa.elapsed = elapsed;
		// Final box is written into the accumulated part so it persists in the
		// output region after the subagent leaves the active list.
		syncSubagentBox(state, sa, true);
	}
	removeActiveSubagent(part.id);

	if (status === "completed" && typeof st["output"] === "string" && st["output"]) {
		await writeToLog(`Subagent ${agent} result:\n\n${st["output"]}\n\n`);
	} else {
		await writeToLog(`Subagent ${agent}: ${ansi.stripAnsiCodes(description)}\n\n`);
	}
}

// Handle a streaming part from a subagent's child session: text and tool calls
// become activity lines in the subagent's box. Reasoning and step markers are
// ignored to keep the box compact.
function processSubagentPart(state: State, sa: ActiveSubagent, part: Part): void {
	if (part.type === "text") {
		const text = (part as any).text || "";
		const entry = findSubagentEntry(sa, part.id);
		if (entry && entry.kind === "text") entry.text = text;
		else pushSubagentEntry(sa, { kind: "text", key: part.id, text });
		syncSubagentBox(state, sa, true);
	} else if (part.type === "tool") {
		const tp = part as ToolPart;
		const tool = tp.tool || "unknown";
		if (tool === "task" || tool === "todowrite" || tool === "question") return;
		const inp = (tp.state?.input || {}) as Record<string, any>;
		const detail =
			inp["description"] ||
			inp["filePath"] ||
			inp["path"] ||
			inp["include"] ||
			inp["pattern"] ||
			"...";
		const line = `$ ${tool}: ${detail}`;
		const entry = findSubagentEntry(sa, part.id);
		if (entry) entry.text = line;
		else pushSubagentEntry(sa, { kind: "tool", key: part.id, text: line });
		syncSubagentBox(state, sa, true);
	}
}

// Streaming text delta for a subagent. Updates the buffer + accumulated part
// without forcing a redraw — the animation tick (10/s) repaints it smoothly.
function processSubagentDelta(
	state: State,
	sa: ActiveSubagent,
	partID: string,
	delta: string,
): void {
	const entry = findSubagentEntry(sa, partID);
	if (entry && entry.kind === "text") {
		entry.text += delta;
	} else {
		pushSubagentEntry(sa, { kind: "text", key: partID, text: delta });
	}
	syncSubagentBox(state, sa, false);
}

// Build the raw text stored in the subtask accumulated part (see the line
// convention documented in renderSubtaskBoxLines). Text entries keep their
// full body — including any blank lines, which markdown needs for block
// parsing — so render.ts can render them exactly like the parent's response
// parts; tool entries stay as single "$ tool: …" lines. Entries are delimited
// by a record separator (\x1E) so render.ts can tell entry boundaries apart
// from the blank lines inside a markdown response.
function buildSubagentText(sa: ActiveSubagent): string {
	const out: string[] = [sa.agent];
	let desc = sa.description;
	if (sa.status === "completed") {
		desc += sa.elapsed != null ? ` (done in ${formatDuration(sa.elapsed, true)})` : " (done)";
	} else if (sa.status === "error") {
		desc += " (errored)";
	}
	out.push(desc);

	const entryTexts: string[] = [];
	for (const e of sa.entries) {
		if (e.kind === "text") {
			const body = e.text.replace(/\r/g, "");
			if (body.trim()) entryTexts.push(`💬 ${body}`);
		} else {
			entryTexts.push(e.text);
		}
	}
	out.push(entryTexts.join("\x1E"));
	return out.join("\n");
}

// Write the subagent's current box text into its accumulated part. `paint`
// controls whether a redraw is triggered immediately (part updates do, since
// they're infrequent; deltas rely on the animation tick).
function syncSubagentBox(state: State, sa: ActiveSubagent, paint: boolean): void {
	upsertSubagentPart(state, sa.id, buildSubagentText(sa));
	if (paint && !promptOverlayActive()) render(state);
}

function pushSubagentEntry(sa: ActiveSubagent, entry: SubagentEntry): void {
	sa.entries.push(entry);
	if (sa.entries.length > SUBAGENT_MAX_ENTRIES) {
		sa.entries = sa.entries.slice(-SUBAGENT_MAX_ENTRIES);
	}
}

function findSubagentEntry(sa: ActiveSubagent, key: string): SubagentEntry | undefined {
	for (let i = sa.entries.length - 1; i >= 0; i--) {
		if (sa.entries[i]!.key === key) return sa.entries[i];
	}
	return undefined;
}

function upsertSubagentPart(state: State, key: string, text: string) {
	let existing = findLastPart(state, key);
	if (!existing) {
		existing = { key, title: "subtask", text };
		state.accumulatedResponse.push(existing);
	} else {
		existing.text = text;
	}
}

function upsertActiveSubagent(
	id: string,
	agent: string,
	description: string,
	sessionID: string | null,
) {
	const idx = activeSubagents.findIndex((s) => s.id === id);
	if (idx >= 0) {
		activeSubagents[idx]!.agent = agent;
		activeSubagents[idx]!.description = description;
		if (sessionID) activeSubagents[idx]!.sessionID = sessionID;
	} else {
		activeSubagents.push({
			id,
			agent,
			description,
			sessionID,
			status: "running",
			elapsed: null,
			entries: [],
		});
	}
}

function removeActiveSubagent(id: string) {
	activeSubagents = activeSubagents.filter((s) => s.id !== id);
}

function processDelta(state: State, partID: string, delta: string) {
	let responsePart = findLastPart(state, partID);
	if (responsePart) {
		responsePart.text += delta;
	}

	if (!promptOverlayActive()) render(state);
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

	// Update the "X/Y tasks done" summary shown above the spinner. A new set
	// (different number of todos) resets the frozen count; otherwise we keep
	// the max done so a completed set stays at "X/X" until replaced.
	const total = todos.length;
	const done = todos.filter((t) => t.status === "completed").length;
	if (!currentTodos || currentTodos.length !== total) {
		frozenDone = done;
	} else {
		frozenDone = Math.max(frozenDone, done);
	}
	currentTodos = todos;
	setTodoSummary(frozenDone, total);

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
