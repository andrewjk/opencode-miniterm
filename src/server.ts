import type { OpenCodeEvent } from "@opencode/client";
import * as ansi from "./ansi";
import { config } from "./config";
import {
	afterOutputPaint,
	clearTodoSummary,
	isUserTyping,
	navigateToPromptRow,
	setUserTyping,
} from "./input";
import { closeLogFile, createLogFile, writeToLog } from "./logs";
import type { OpenCodeClient } from "./opencode";
import { type PermissionRequest, getPermissionState, startPermission } from "./permission";
import { getQuestionState, startQuestion } from "./question";
import {
	getActiveModel,
	markOutputDirty,
	render,
	setTerminalTitle,
	startAnimation,
	stopAnimation,
	writePrompt,
} from "./render";
import type { State } from "./types";
import { formatDuration } from "./utils";

let processing = true;
let retryInterval: ReturnType<typeof setInterval> | null = null;
let requestActive = false;
let requestStartTime: number | null = null;

// Tool call names, keyed by `<sessionID>:<callID>`. The V2 event stream reports
// the name on `session.tool.input.started` but not on the later
// `session.tool.called`, so we remember it here.
const toolNames = new Map<string, string>();

// Subagents (child sessions) dispatched during the active turn. V2 creates a
// child session per subagent; `session.created` with `parentID` set to the
// active session marks one. Child-session streaming events are routed into the
// matching subagent's buffer and rendered as a compact box instead of dumped
// into the parent's output. Cleared when the turn goes idle or a new turn
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
	startedAt: number;
	entries: SubagentEntry[];
}
let activeSubagents: ActiveSubagent[] = [];
const SUBAGENT_MAX_ENTRIES = 40;

// Token/cost stats from the most recent step, shown in the completion banner.
interface TokenStats {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}
let lastTokenStats: TokenStats | null = null;

// Error from the most recent turn. Shown at turn end instead of the completion
// banner so the user sees why the request stopped.
let lastError: string | null = null;

// Context window (in tokens) for the active model, used to show the cached
// token percentage. Resolved lazily from the models list and cached.
let cachedContextLimit: number | null = null;

async function resolveContextLimit(client: OpenCodeClient): Promise<number | null> {
	if (cachedContextLimit !== null) return cachedContextLimit;
	try {
		const result = await client.model.list({ location: { directory: process.cwd() } });
		const model = result.data.find(
			(m) => m.providerID === config.providerID && m.modelID === config.modelID,
		);
		if (model?.limit?.context) {
			cachedContextLimit = model.limit.context;
			return cachedContextLimit;
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

// Pending question/permission prompts that arrived while another prompt overlay
// was already on screen. Only one overlay can own the screen at a time, so
// extras are queued (FIFO) and shown one after another as each is answered.
interface PendingPrompt {
	kind: "question" | "permission";
	payload: any;
}
let pendingPrompts: PendingPrompt[] = [];

function promptOverlayActive(): boolean {
	const q = getQuestionState();
	if (q?.active) return true;
	const p = getPermissionState();
	return !!p?.active;
}

function activePromptMatches(kind: "question" | "permission", payload: any): boolean {
	const id = payload?.id;
	if (!id) return false;
	if (kind === "question") return getQuestionState()?.formID === id;
	return getPermissionState()?.permissionID === id;
}

function dispatchPrompt(state: State, kind: "question" | "permission", payload: any): void {
	if (promptOverlayActive() && !activePromptMatches(kind, payload)) {
		const id = payload?.id;
		if (id) {
			pendingPrompts = pendingPrompts.filter((p) => !(p.kind === kind && p.payload?.id === id));
		}
		pendingPrompts.push({ kind, payload });
		return;
	}
	if (activeSubagents.length > 0) render(state);
	if (kind === "question") startQuestion(payload, state);
	else startPermission(payload as PermissionRequest, state);
}

// Called by question.ts/permission.ts once they've dismissed their overlay.
export function drainPendingPrompt(state: State): boolean {
	const next = pendingPrompts.shift();
	if (!next) return false;
	if (next.kind === "question") startQuestion(next.payload, state);
	else startPermission(next.payload as PermissionRequest, state);
	return true;
}

// Abort the running request and tear down per-request state. Used when the user
// cancels (Escape) or when a question/permission interrupts the turn.
export async function cancelRequest(state: State): Promise<void> {
	if (state.sessionID) {
		state.client.session.interrupt({ sessionID: state.sessionID }).catch(() => {});
	}
	requestActive = false;
	requestStartTime = null;
	activeSubagents = [];
	pendingPrompts = [];
	await closeLogFile();
}

export async function createSession(state: State): Promise<string> {
	try {
		const info = await state.client.session.create({
			agent: config.agentID,
			model: { id: config.modelID, providerID: config.providerID },
			location: { directory: process.cwd() },
		});
		return info.id;
	} catch (error) {
		throw new Error(
			`Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function validateSession(state: State, sessionID: string): Promise<boolean> {
	try {
		await state.client.session.get({ sessionID });
		return true;
	} catch {
		return false;
	}
}

// Align the session's agent/model with the config before a prompt. V2 keeps
// these on the session rather than on each prompt, so switching here makes
// `/models` and `/agents` take effect on the next turn.
async function ensureSessionModel(state: State): Promise<void> {
	try {
		await state.client.session.switchModel({
			sessionID: state.sessionID,
			model: { id: config.modelID, providerID: config.providerID },
		});
	} catch {
		// ignore — the session keeps its previous model
	}
	try {
		await state.client.session.switchAgent({
			sessionID: state.sessionID,
			agent: config.agentID,
		});
	} catch {
		// ignore
	}
}

// ====================
// EVENT STREAM SUPERVISION
// ====================

// The SSE stream has no idle timeout: if the server goes quiet on an open
// connection (half-open TCP, dropped NAT, hung server), the stream blocks
// forever with no error. The watchdog treats "no SSE events for a while" as
// suspicious, probes the server, and recovers: unhealthy or repeatedly-silent
// streams are aborted and resubscribed, and a missed turn-end idle is
// synthesized from session status.
export const watchdogConfig = {
	intervalMs: 5_000,
	stallTimeoutMs: 60_000,
	idleStallTimeoutMs: 120_000,
	healthTimeoutMs: 5_000,
	maxSilentProbes: 2,
	resubscribeDelayMs: 1_000,
};

let listenerRunning = false;
let listenerGeneration = 0;
let eventAbort: AbortController | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastEventAt = 0;
let silentProbes = 0;
let probeInFlight = false;

export function markEventReceived(timestamp: number = Date.now()): void {
	lastEventAt = timestamp;
	silentProbes = 0;
}

async function healthProbe(state: State): Promise<boolean> {
	try {
		await state.client.server.info({ signal: AbortSignal.timeout(watchdogConfig.healthTimeoutMs) });
		return true;
	} catch {
		return false;
	}
}

// Returns "busy" when the server reports the active session as running, "idle"
// when it isn't listed, or null when the status can't be determined (request
// error). A missing status must NOT be treated as idle.
async function getSessionStatus(state: State): Promise<string | null> {
	try {
		const active = await state.client.session.active();
		return active[state.sessionID] ? "busy" : "idle";
	} catch {
		return null;
	}
}

export async function watchdogTick(state: State, now: number = Date.now()): Promise<void> {
	if (!listenerRunning || probeInFlight || lastEventAt === 0) return;
	const stallTimeout = requestActive
		? watchdogConfig.stallTimeoutMs
		: watchdogConfig.idleStallTimeoutMs;
	if (now - lastEventAt < stallTimeout) {
		silentProbes = 0;
		return;
	}

	probeInFlight = true;
	try {
		const healthy = await healthProbe(state);
		let reconnectReason: string | null = healthy ? null : "health check failed";

		if (healthy && requestActive && state.sessionID) {
			if ((await getSessionStatus(state)) === "idle") {
				console.error(
					`\n${ansi.BRIGHT_BLACK}Event stream stalled but the session is idle on the server; finishing the turn${ansi.RESET}`,
				);
				markEventReceived(now);
				await processEvent(state, {
					type: "session.idle",
					data: { sessionID: state.sessionID },
				} as OpenCodeEvent);
				reconnectReason = "session went idle during a stalled stream";
			}
		}

		if (reconnectReason === null && silentProbes + 1 >= watchdogConfig.maxSilentProbes) {
			reconnectReason = "stream silent across consecutive health probes";
		}

		if (reconnectReason !== null) {
			console.error(
				`\n${ansi.RED}Event stream unresponsive (${reconnectReason}); reconnecting${ansi.RESET}`,
			);
			markEventReceived(now);
			eventAbort?.abort();
		} else {
			lastEventAt = now;
			silentProbes++;
		}
	} finally {
		probeInFlight = false;
	}
}

async function runEventStream(state: State, generation: number): Promise<void> {
	const controller = eventAbort!;
	const stream = state.client.event.subscribe({
		signal: controller.signal,
		onActivity: () => markEventReceived(),
	});

	markEventReceived();
	for await (const event of stream) {
		if (generation !== listenerGeneration || controller.signal.aborted) break;
		try {
			await processEvent(state, event);
		} catch (error) {
			console.error(
				`\n${ansi.RED}Event processing error:${ansi.RESET}`,
				error instanceof Error ? error.message : String(error),
			);
		}
		markEventReceived();
	}
}

export async function startEventListener(state: State): Promise<void> {
	listenerRunning = true;
	listenerGeneration++;
	const generation = listenerGeneration;
	markEventReceived();
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
	}
	watchdogTimer = setInterval(() => {
		void watchdogTick(state).catch(() => {});
	}, watchdogConfig.intervalMs);

	while (listenerRunning && generation === listenerGeneration) {
		eventAbort = new AbortController();
		try {
			await runEventStream(state, generation);
		} catch (error) {
			if (listenerRunning && generation === listenerGeneration) {
				console.error(
					`\n${ansi.RED}Event stream error:${ansi.RESET}`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		if (!listenerRunning || generation !== listenerGeneration) break;
		await new Promise((resolve) => setTimeout(resolve, watchdogConfig.resubscribeDelayMs));
	}
}

export function stopEventListener(): void {
	listenerRunning = false;
	listenerGeneration++;
	eventAbort?.abort();
	eventAbort = null;
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}
}

// Bring the app into "request active" state and reset per-turn output. Shared
// by sendPrompt (a request we started) and external requests we're following.
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
	activeSubagents = [];
	pendingPrompts = [];
	clearTodoSummary();
	startAnimation(state, requestStartTime);
}

// After switching to a session, check whether it's already running a request on
// the server (e.g. started from another client). If so, start tracking it.
export async function startTrackingIfSessionBusy(state: State): Promise<void> {
	if (requestActive) return;
	try {
		const active = await state.client.session.active();
		if (active[state.sessionID]) {
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

	try {
		await ensureSessionModel(state);
		await state.client.session.prompt({
			sessionID: state.sessionID,
			text: message,
		});
	} catch (error) {
		stopAnimation();
		requestActive = false;
		requestStartTime = null;
		await closeLogFile();
		throw error;
	}
}

// Inject a user message into the currently running turn without starting a new
// request. `delivery: "steer"` makes the server weave it into the active turn.
export async function injectMessage(state: State, message: string): Promise<void> {
	await writeToLog(`User (interjected): ${message}\n\n`);

	await state.client.session.prompt({
		sessionID: state.sessionID,
		text: message,
		delivery: "steer",
	});
}

// Rolling window of raw events kept for /debug.
const MAX_STORED_EVENTS = 500;

// Hot streaming paths call this instead of render(): mark the output dirty and
// let the 10Hz animation tick paint it.
function streamRender(state: State): void {
	markOutputDirty();
	if (requestActive || promptOverlayActive()) return;
	render(state);
}

function findLastPart(state: State, key: string) {
	for (let i = state.accumulatedResponse.length - 1; i >= 0; i--) {
		const part = state.accumulatedResponse[i];
		if (part?.key === key) return part;
	}
	return undefined;
}

function setPart(
	state: State,
	key: string,
	title: "thinking" | "response" | "tool" | "files" | "user" | "subtask",
	text: string,
): void {
	const existing = findLastPart(state, key);
	if (existing) existing.text = text;
	else state.accumulatedResponse.push({ key, title, text });
}

function appendPart(
	state: State,
	key: string,
	title: "thinking" | "response",
	delta: string,
): void {
	const existing = findLastPart(state, key);
	if (existing) existing.text += delta;
	else state.accumulatedResponse.push({ key, title, text: delta });
}

// ====================
// EVENT PROCESSING
// ====================

export async function processEvent(state: State, event: OpenCodeEvent): Promise<void> {
	if (retryInterval && (event as any).type !== "session.status") {
		clearInterval(retryInterval);
		retryInterval = null;
	}

	state.allEvents.push(event);
	if (state.allEvents.length > MAX_STORED_EVENTS) {
		state.allEvents.splice(0, state.allEvents.length - MAX_STORED_EVENTS);
	}

	const e = event as any;
	const d = (e.data ?? {}) as any;
	const sid: string | undefined = typeof d.sessionID === "string" ? d.sessionID : undefined;
	const isChild = !!sid && sid !== state.sessionID;

	switch (e.type as string) {
		case "session.text.started": {
			if (isChild) break;
			const key = `text:${d.assistantMessageID}:${d.ordinal}`;
			if (!findLastPart(state, key)) {
				state.accumulatedResponse.push({ key, title: "response", text: "" });
			}
			break;
		}

		case "session.text.delta": {
			const key = `text:${d.assistantMessageID}:${d.ordinal}`;
			if (isChild) {
				if (sid) routeChildTextDelta(state, sid, key, d.delta);
				break;
			}
			appendPart(state, key, "response", d.delta);
			streamRender(state);
			break;
		}

		case "session.text.ended": {
			const key = `text:${d.assistantMessageID}:${d.ordinal}`;
			if (isChild) {
				if (sid) routeChildTextEnded(state, sid, key, d.text);
				break;
			}
			setPart(state, key, "response", d.text);
			await writeToLog(`Response:\n\n${ansi.stripAnsiCodes(String(d.text).trimStart())}\n\n`);
			streamRender(state);
			break;
		}

		case "session.reasoning.started": {
			if (isChild) break;
			const key = `reason:${d.assistantMessageID}:${d.ordinal}`;
			if (!findLastPart(state, key)) {
				state.accumulatedResponse.push({ key, title: "thinking", text: "" });
			}
			break;
		}

		case "session.reasoning.delta": {
			if (isChild) break;
			appendPart(state, `reason:${d.assistantMessageID}:${d.ordinal}`, "thinking", d.delta);
			streamRender(state);
			break;
		}

		case "session.reasoning.ended": {
			if (isChild) break;
			setPart(state, `reason:${d.assistantMessageID}:${d.ordinal}`, "thinking", d.text);
			await writeToLog(`Thinking:\n\n${ansi.stripAnsiCodes(String(d.text).trimStart())}\n\n`);
			streamRender(state);
			break;
		}

		case "session.tool.input.started": {
			toolNames.set(`${d.sessionID}:${d.id}`, d.name);
			break;
		}

		case "session.tool.called": {
			const name = toolNames.get(`${d.sessionID}:${d.id}`) || "unknown";
			if (isChild) {
				if (sid) routeChildTool(state, sid, d.id, name, d.input);
				break;
			}
			if (name === "subagent" || name === "task" || name === "todowrite" || name === "question") {
				break;
			}
			const text = `$ ${name}: ${ansi.BRIGHT_BLACK}${toolDisplay(name, d.input)}${ansi.RESET}`;
			setPart(state, `tool:${d.id}`, "tool", text);
			await writeToLog(`$ ${ansi.stripAnsiCodes(text)}\n\n`);
			render(state);
			break;
		}

		case "session.step.started": {
			processing = true;
			break;
		}

		case "session.step.ended": {
			if (d.tokens) {
				lastTokenStats = {
					input: d.tokens.input ?? 0,
					output: d.tokens.output ?? 0,
					reasoning: d.tokens.reasoning ?? 0,
					cacheRead: d.tokens.cache?.read ?? 0,
					cacheWrite: d.tokens.cache?.write ?? 0,
					cost: d.cost ?? 0,
				};
			}
			if (Array.isArray(d.files) && d.files.length > 0) {
				await processChangedFiles(state, d.files);
			}
			break;
		}

		case "session.step.failed": {
			if (d.error) lastError = d.error.message || JSON.stringify(d.error);
			break;
		}

		case "session.execution.started": {
			if (!isChild && !requestActive) {
				processing = true;
				startRequestTracking(state);
			}
			break;
		}

		case "session.execution.succeeded": {
			if (isChild && sid) {
				completeSubagent(state, sid, "completed");
				break;
			}
			await finishTurn(state);
			break;
		}

		case "session.execution.failed": {
			if (isChild && sid) {
				completeSubagent(state, sid, "error");
				break;
			}
			if (d.error) lastError = d.error.message || JSON.stringify(d.error);
			await finishTurn(state);
			break;
		}

		case "session.execution.interrupted": {
			if (isChild && sid) {
				completeSubagent(state, sid, "completed");
				break;
			}
			await finishTurn(state);
			break;
		}

		case "session.idle": {
			if (isChild) {
				if (sid) completeSubagent(state, sid, "completed");
				break;
			}
			await finishTurn(state);
			break;
		}

		case "session.status": {
			if (isChild) break;
			const status = d.status;
			if (status?.type === "busy") {
				if (!requestActive) {
					processing = true;
					startRequestTracking(state);
				}
			} else if (status?.type === "idle") {
				await finishTurn(state);
			} else if (status?.type === "retry") {
				showRetry(status.message, status.next);
			}
			break;
		}

		case "session.retry.scheduled": {
			showRetry(d.error?.message, d.at);
			break;
		}

		case "session.created": {
			if (d.parentID && d.parentID === state.sessionID) {
				upsertActiveSubagent(
					d.sessionID,
					d.agent || "subagent",
					d.title || d.slug || "subagent",
					d.sessionID,
				);
				const sa = activeSubagents.find((s) => s.id === d.sessionID);
				if (sa) syncSubagentBox(state, sa, true);
			}
			break;
		}

		case "session.renamed": {
			if (d.sessionID === state.sessionID && d.title) {
				setTerminalTitle(d.title);
			}
			break;
		}

		case "permission.asked": {
			dispatchPrompt(state, "permission", {
				id: d.id,
				sessionID: d.sessionID,
				action: d.action,
				resources: d.resources ?? [],
				message: d.message,
			});
			break;
		}

		case "form.created": {
			if (d.form) dispatchPrompt(state, "question", d.form);
			break;
		}

		default:
			break;
	}
}

// Finalize the active turn: stop the spinner and print the completion banner
// (or the error). While subagents are still running, keep the turn alive.
async function finishTurn(state: State): Promise<void> {
	if (!requestActive) return;

	if (activeSubagents.length > 0) {
		if (!promptOverlayActive()) {
			startAnimation(state, requestStartTime ?? undefined);
			render(state);
		}
		return;
	}

	// Flush any output streamed in the same batch as the turn-end event. While
	// the request is still active this paints the spinner-only live area, so the
	// banner below (and the fresh prompt) land cleanly underneath.
	render(state);

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

	if (isUserTyping()) {
		setUserTyping(false);
		navigateToPromptRow();
		afterOutputPaint();
		return;
	}

	const turnError = lastError;
	lastError = null;
	if (turnError) {
		process.stdout.write("\x07");
		console.log(`\n  ${ansi.RED}Error:${ansi.RESET} ${turnError}\n`);
	} else if (duration != null) {
		process.stdout.write("\x07");
		const durationText = formatDuration(duration, true);
		console.log(`  ${ansi.BRIGHT_BLACK}Completed in ${durationText}${ansi.RESET}`);

		const modelName = await getActiveModel(state.client);
		const parts = [modelName];
		if (lastTokenStats) {
			const cachedTotal = lastTokenStats.cacheRead + lastTokenStats.cacheWrite;
			const contextLimit = await resolveContextLimit(state.client);
			if (contextLimit && contextLimit > 0) {
				const pct = ((cachedTotal / contextLimit) * 100).toFixed(1);
				parts.push(`${pct}%`);
			} else {
				parts.push(`${lastTokenStats.input} i`);
				parts.push(`${lastTokenStats.output} o`);
				parts.push(`${cachedTotal} cached`);
			}
			parts.push(`$${lastTokenStats.cost.toFixed(4)}`);
		}
		console.log(`  ${ansi.BRIGHT_BLACK}${parts.join(" · ")}${ansi.RESET}`);
		console.log(`  ${ansi.BRIGHT_BLACK}${process.cwd()}${ansi.RESET}\n`);
	}
	writePrompt();
}

function showRetry(message: string | undefined, at: number | undefined): void {
	console.error(`\n\n  ${ansi.RED}Error:${ansi.RESET} ${message ?? "request failed"}`);
	if (!at) return;
	if (retryInterval) clearInterval(retryInterval);
	const retryDate = new Date(at);
	let lastSeconds = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
	console.error(`  ${ansi.BRIGHT_BLACK}Retrying in ${lastSeconds}s...${ansi.RESET}`);
	retryInterval = setInterval(() => {
		const remaining = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
		if (remaining !== lastSeconds) {
			process.stdout.write(`\r  ${ansi.BRIGHT_BLACK}Retrying in ${remaining}s...${ansi.RESET}`);
			lastSeconds = remaining;
		}
		if (remaining === 0 && retryInterval) {
			clearInterval(retryInterval);
			retryInterval = null;
		}
	}, 100);
}

async function processChangedFiles(state: State, files: string[]): Promise<void> {
	const fresh = files.filter((file) => !state.lastFileAfter.has(file));
	if (fresh.length === 0) return;
	for (const file of fresh) state.lastFileAfter.set(file, "");
	const text = fresh.map((file) => `${ansi.BLUE}M${ansi.RESET} ${file}`).join("\n");
	state.accumulatedResponse.push({ key: `files:${Date.now()}`, title: "files", text });
	await writeToLog(`${ansi.stripAnsiCodes(text)}\n\n`);
	render(state);
}

// Bash commands can be multi-line shell scripts; render them as a single line.
function formatToolCommand(tool: string, command: string): string {
	const width = process.stdout.columns || 80;
	const maxLen = Math.max(0, width - 3 - 2 - `$ ${tool}: `.length);
	const newlineIdx = command.indexOf("\n");
	const limit = newlineIdx === -1 ? maxLen : Math.min(newlineIdx, maxLen);
	const head = command.slice(0, limit);
	return command.length > limit ? `${head}…` : head;
}

function toolDisplay(name: string, input: any): string {
	const value =
		input?.command ??
		input?.description ??
		input?.filePath ??
		input?.path ??
		input?.include ??
		input?.pattern ??
		input?.prompt ??
		"...";
	return name === "bash" || name === "shell"
		? formatToolCommand(name, String(value))
		: String(value);
}

// ====================
// SUBAGENT BOXES
// ====================

function routeChildTextDelta(state: State, sid: string, key: string, delta: string): void {
	const sa = activeSubagents.find((s) => s.sessionID === sid);
	if (!sa) return;
	const entry = findSubagentEntry(sa, key);
	if (entry && entry.kind === "text") entry.text += delta;
	else pushSubagentEntry(sa, { kind: "text", key, text: delta });
	syncSubagentBox(state, sa, false);
}

function routeChildTextEnded(state: State, sid: string, key: string, text: string): void {
	const sa = activeSubagents.find((s) => s.sessionID === sid);
	if (!sa) return;
	const entry = findSubagentEntry(sa, key);
	if (entry && entry.kind === "text") entry.text = text;
	else pushSubagentEntry(sa, { kind: "text", key, text });
	syncSubagentBox(state, sa, true);
}

function routeChildTool(state: State, sid: string, id: string, name: string, input: any): void {
	const sa = activeSubagents.find((s) => s.sessionID === sid);
	if (!sa) return;
	if (name === "subagent" || name === "task" || name === "todowrite" || name === "question") return;
	const line = `$ ${name}: ${toolDisplay(name, input)}`;
	const entry = findSubagentEntry(sa, id);
	if (entry) entry.text = line;
	else pushSubagentEntry(sa, { kind: "tool", key: id, text: line });
	syncSubagentBox(state, sa, true);
}

function completeSubagent(state: State, sid: string, status: "completed" | "error"): void {
	const sa = activeSubagents.find((s) => s.sessionID === sid);
	if (!sa) return;
	if (sa.status !== "running") return;
	sa.status = status;
	sa.elapsed = Date.now() - sa.startedAt;
	syncSubagentBox(state, sa, true);
	removeActiveSubagent(sa.id);
}

// Build the raw text stored in the subtask accumulated part (see the line
// convention documented in renderSubtaskBoxLines).
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

function syncSubagentBox(state: State, sa: ActiveSubagent, paint: boolean): void {
	upsertSubagentPart(state, sa.id, buildSubagentText(sa));
	markOutputDirty();
	if (paint) streamRender(state);
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
			startedAt: Date.now(),
			entries: [],
		});
	}
}

function removeActiveSubagent(id: string) {
	activeSubagents = activeSubagents.filter((s) => s.id !== id);
}
