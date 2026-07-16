import type { Part } from "@opencode-ai/sdk";
import { glob } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { type Key } from "node:readline";
import * as ansi from "./ansi";
import agentsCommand from "./commands/agents";
import debugCommand from "./commands/debug";
import detailsCommand from "./commands/details";
import diffCommand from "./commands/diff";
import exitCommand from "./commands/exit";
import initCommand from "./commands/init";
import logCommand from "./commands/log";
import modelsCommand from "./commands/models";
import newCommand from "./commands/new";
import pageCommand from "./commands/page";
import quitCommand from "./commands/quit";
import runCommand from "./commands/run";
import sessionsCommand from "./commands/sessions";
import undoCommand from "./commands/undo";
import { getLogDir, isLoggingEnabled } from "./logs";
import { getPermissionState, handlePermissionKeyPress } from "./permission";
import { getQuestionState, handleQuestionKeyPress } from "./question";
import {
	paintSpinnerLine,
	render,
	resumeAnimation,
	stopAnimation,
	writePrompt,
	writePromptMarker,
} from "./render";
import { cancelRequest, injectMessage, isRequestActive, sendPrompt } from "./server";
import type { State } from "./types";

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
	exitCommand,
	quitCommand,
	runCommand,
];

let inputBuffer = "";
let cursorPosition = 0;
let completions: string[] = [];
let history: string[] = [];
let historyIndex = history.length;
let selectedCompletion = 0;
let completionCycling = false;
let lastSpaceTime = 0;
let lastKeyPressTime = 0;
let rapidKeyPressCount = 0;
let currentInputBuffer: string | null = null;
let userTyping = false;

export function isUserTyping(): boolean {
	return userTyping;
}

export function setUserTyping(value: boolean): void {
	userTyping = value;
}

let oldInputBuffer = "";
let oldWrappedRows = 0;
let oldCursorRow = 0;
// Whether an input line is currently drawn in the live area, and whether a
// spinner header row sits above it. Together these describe the live-area
// layout so navigateToPromptRow()/painting can account for both rows.
let oldInputDrawn = false;
let oldHeaderRows = 0;

// Todo summary shown above the spinner line ("2/4 tasks done"). Tracks the
// latest todo set so it can be frozen at the final state until a new set
// arrives or the prompt completes. null = no todos to show.
interface TodoSummary {
	done: number;
	total: number;
}
let todoSummary: TodoSummary | null = null;

// Update the todo summary. Called from server.ts when a todo.updated event
// arrives. A fresh set (total change) replaces the frozen summary.
export function setTodoSummary(done: number, total: number): void {
	todoSummary = { done, total };
}

// Clear the todo summary (e.g. when a prompt completes).
export function clearTodoSummary(): void {
	todoSummary = null;
}

// Move the cursor to the top of the live area (the row directly below the
// rendered output), column 0. The cursor is assumed to be somewhere within the
// live area; we move up by its row offset within that area.
export function navigateToPromptRow(): void {
	process.stdout.write(ansi.CURSOR_HOME);
	// When input is drawn, the cursor sits `oldHeaderRows + oldCursorRow`
	// rows below the live-area top. In spinner-only mode (no input) the
	// cursor rests on the last painted header line (the spinner), which is
	// `oldHeaderRows - 1` rows below the top. Accounting for this is what
	// stops the todo summary from stacking up on every animation tick.
	const liveRow = oldInputDrawn ? oldHeaderRows + oldCursorRow : Math.max(0, oldHeaderRows - 1);
	if (liveRow > 0) {
		process.stdout.write(ansi.CURSOR_UP(liveRow));
	}
}

// Fully repaint the live area (the region below the rendered output). The
// cursor must already be at the live-area top. The live area is one of:
//   - spinner only        (request active, not typing)
//   - spinner + input     (typing during a request)
//   - input only          (idle)
function paintLiveAreaFull(): void {
	const consoleWidth = process.stdout.columns || 80;

	const wantSpinner = isRequestActive();
	const wantInput = userTyping || !isRequestActive();
	const showTodo = !!(todoSummary && todoSummary.total > 0);

	// Cursor is already at the live-area top (positioned by navigateToPromptRow).
	// Clear from there downward.
	process.stdout.write(ansi.CURSOR_HOME);
	process.stdout.write(ansi.CLEAR_FROM_CURSOR);

	let headerRows = 0;
	if (showTodo) {
		const consoleWidth = process.stdout.columns || 80;
		const done = todoSummary!.done;
		const total = todoSummary!.total;
		const complete = done >= total;
		//const color = complete ? ansi.GREEN : ansi.CYAN;
		const summary = `  ${ansi.BRIGHT_BLACK}${ansi.CYAN}${done}/${total} todo items done${ansi.RESET}`;
		// Pad to full width so the summary fully overwrites whatever was on
		// this row previously (e.g. the output's last line or a prior spinner).
		process.stdout.write(`${ansi.padToWidth(summary, consoleWidth)}\n`);
		headerRows += 1;
	}

	if (wantSpinner) {
		paintSpinnerLine();
		headerRows += 1;
	} else if (headerRows > 0) {
		// advance to the next row so the prompt doesn't overwrite the summary
		process.stdout.write("\n");
	}

	if (wantInput) {
		process.stdout.write(ansi.CURSOR_SHOW);
		if (headerRows > 0) {
			process.stdout.write("\n");
		}
		writePromptMarker();
		let col = 2;
		let wrappedRows = 0;
		for (let i = 0; i < inputBuffer.length; i++) {
			if (col >= consoleWidth) {
				process.stdout.write("\n");
				col = 0;
				wrappedRows++;
			}
			process.stdout.write(inputBuffer[i]!);
			col++;
		}

		const absolutePos = 2 + cursorPosition;
		const inputCursorRow = Math.floor(absolutePos / consoleWidth);
		const inputCursorCol = absolutePos % consoleWidth;
		const rowsUp = wrappedRows - inputCursorRow;
		if (rowsUp > 0) {
			process.stdout.write(ansi.CURSOR_UP(rowsUp));
		}
		process.stdout.write(ansi.CURSOR_COL(inputCursorCol));

		oldInputBuffer = inputBuffer;
		oldWrappedRows = wrappedRows;
		oldCursorRow = inputCursorRow;
		oldInputDrawn = true;
	} else {
		// Spinner-only: nothing to edit, keep the cursor out of sight.
		process.stdout.write(ansi.CURSOR_HIDE);
		oldInputBuffer = "";
		oldWrappedRows = 0;
		oldCursorRow = 0;
		oldInputDrawn = false;
	}
	oldHeaderRows = headerRows;
}

// Called by render() after output has been (re)drawn. Repaints the live area
// below the output, or resets input tracking so a stale prompt isn't left on
// screen while streaming.
export function afterOutputPaint(): void {
	paintLiveAreaFull();
}

// On the first keystroke during an active request, transition the live area
// from spinner-only to spinner + input. Returns true when a full repaint was
// performed so the caller can skip its incremental paint.
function beginTypingIfBusy(): boolean {
	if (isRequestActive() && !userTyping) {
		userTyping = true;
		// Cursor sits on the spinner row (live-area top). paintLiveAreaFull will
		// draw the spinner header and the input line below it.
		paintLiveAreaFull();
		return true;
	}
	return false;
}

export function renderLine(): void {
	if (beginTypingIfBusy()) {
		return;
	}
	const consoleWidth = process.stdout.columns || 80;

	// Move to the start of the line (i.e. the prompt position)
	process.stdout.write(ansi.CURSOR_HOME);
	if (oldWrappedRows > 0) {
		let rowsToMove = oldWrappedRows - oldCursorRow;
		if (cursorPosition < inputBuffer.length && rowsToMove > 0) {
			process.stdout.write(ansi.CURSOR_DOWN(rowsToMove));
		}
		process.stdout.write(ansi.CURSOR_UP(oldWrappedRows));
	}

	// Find the position where the input has changed (i.e. where the user has
	// typed something)
	let start = 0;
	let currentCol = 2;
	let currentRow = 0;
	let newWrappedRows = 0;
	for (let i = 0; i < Math.min(oldInputBuffer.length, inputBuffer.length); i++) {
		if (oldInputBuffer[i] !== inputBuffer[i]) {
			break;
		}
		if (currentCol >= consoleWidth) {
			currentCol = 0;
			currentRow++;
			newWrappedRows++;
		}
		currentCol++;
		start++;
	}

	// Position the cursor at where the difference starts, then clear
	// Check if we need to wrap after the comparison loop
	if (currentCol >= consoleWidth) {
		currentCol = 0;
		currentRow++;
		newWrappedRows++;
	}
	if (currentRow > 0) {
		process.stdout.write(ansi.CURSOR_DOWN(currentRow));
	}
	process.stdout.write(ansi.CURSOR_COL(currentCol));
	process.stdout.write(ansi.CLEAR_FROM_CURSOR);

	// Write the prompt if this is a fresh buffer
	if (start === 0) {
		process.stdout.write(ansi.CURSOR_HOME);
		writePromptMarker();
		process.stdout.write(ansi.CURSOR_COL(2));
	}

	// Write the changes from the new input buffer
	let renderExtent = Math.max(cursorPosition + 1, inputBuffer.length);
	for (let i = start; i < renderExtent; i++) {
		if (currentCol >= consoleWidth) {
			process.stdout.write("\n");
			currentCol = 0;
			newWrappedRows++;
		}
		if (i < inputBuffer.length) {
			process.stdout.write(inputBuffer[i]!);
		}
		currentCol++;
	}

	// Calculate and move to the cursor's position
	let absolutePos = 2 + cursorPosition;
	let newCursorRow = Math.floor(absolutePos / consoleWidth);
	let newCursorCol = absolutePos % consoleWidth;
	process.stdout.write(ansi.CURSOR_HOME);
	let rowsToMove = newWrappedRows - newCursorRow;
	if (rowsToMove > 0) {
		process.stdout.write(ansi.CURSOR_UP(rowsToMove));
	}
	process.stdout.write(ansi.CURSOR_COL(newCursorCol));

	oldInputBuffer = inputBuffer;
	oldWrappedRows = newWrappedRows;
	oldCursorRow = newCursorRow;
	oldInputDrawn = true;
	oldHeaderRows = isRequestActive() ? 1 : 0;
}

export async function handleKeyPress(state: State, str: string, key: Key) {
	const now = Date.now();
	const timeSinceLastKey = now - lastKeyPressTime;
	lastKeyPressTime = now;
	if (timeSinceLastKey < 10) {
		rapidKeyPressCount++;
	} else {
		rapidKeyPressCount = 0;
	}

	if (key.ctrl && key.name === "c") {
		process.stdout.write("\n");
		state.shutdown();
		return;
	}

	const questionState = getQuestionState();
	if (questionState && questionState.active) {
		if (handleQuestionKeyPress(str, key)) {
			return;
		}
	}

	const permissionState = getPermissionState();
	if (permissionState && permissionState.active) {
		if (handlePermissionKeyPress(str, key)) {
			return;
		}
	}

	for (let command of SLASH_COMMANDS) {
		if (command.running && command.handleKey) {
			await command.handleKey(state, key, str);
			return;
		}
	}

	switch (key.name) {
		case "up": {
			if (historyIndex === history.length) {
				currentInputBuffer = inputBuffer;
			}
			if (history.length > 0) {
				if (historyIndex > 0) {
					historyIndex--;
					inputBuffer = history[historyIndex]!;
				} else {
					historyIndex = Math.max(-1, historyIndex - 1);
					inputBuffer = "";
				}
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
					inputBuffer = currentInputBuffer || "";
					currentInputBuffer = null;
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
			if (isRequestActive()) {
				if (userTyping) {
					// Cancel the in-progress interjection and return to the spinner.
					navigateToPromptRow();
					resetInputBufferState();
					userTyping = false;
					render(state);
				} else {
					// Abort the running request.
					await cancelRequest(state);
					stopAnimation();
					process.stdout.write(ansi.CURSOR_SHOW);
					process.stdout.write(`\r  ${ansi.BRIGHT_BLACK}Cancelled request${ansi.RESET}\n\n`);
					writePrompt();
				}
			} else {
				inputBuffer = "";
				cursorPosition = 0;
				currentInputBuffer = null;
				renderLine();
			}
			return;
		}
		case "return": {
			// If part of a rapid key sequence (paste), insert \n literal
			if (rapidKeyPressCount > 2) {
				inputBuffer =
					inputBuffer.slice(0, cursorPosition) + "\\n" + inputBuffer.slice(cursorPosition);
				cursorPosition += 2;
				currentInputBuffer = null;
				renderLine();
			} else {
				rapidKeyPressCount = 0;
				await acceptInput(state);
			}
			return;
		}
		case "backspace": {
			if (cursorPosition > 0) {
				inputBuffer = inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition);
				cursorPosition--;
				currentInputBuffer = null;
			}
			break;
		}
		case "delete": {
			if (cursorPosition < inputBuffer.length) {
				inputBuffer = inputBuffer.slice(0, cursorPosition) + inputBuffer.slice(cursorPosition + 1);
				currentInputBuffer = null;
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
			if (str === " ") {
				const now = Date.now();
				if (
					now - lastSpaceTime < 500 &&
					cursorPosition > 0 &&
					inputBuffer[cursorPosition - 1] === " "
				) {
					inputBuffer =
						inputBuffer.slice(0, cursorPosition - 1) + ". " + inputBuffer.slice(cursorPosition);
					cursorPosition += 1;
				} else {
					inputBuffer =
						inputBuffer.slice(0, cursorPosition) + str + inputBuffer.slice(cursorPosition);
					cursorPosition += str.length;
				}
				lastSpaceTime = now;
			} else if (str) {
				// Replace newlines with literal \n to prevent accidental execution on paste
				const sanitized = str.replace(/\n/g, "\\n");
				inputBuffer =
					inputBuffer.slice(0, cursorPosition) + sanitized + inputBuffer.slice(cursorPosition);
				cursorPosition += sanitized.length;
			}
			currentInputBuffer = null;
		}
	}

	completionCycling = false;
	completions = [];
	renderLine();
}

async function handleTab(): Promise<void> {
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
}

async function getCompletions(text: string): Promise<string[]> {
	if (text.startsWith("/")) {
		return ["/help", ...SLASH_COMMANDS.map((c) => c.name)].filter((cmd) => cmd.startsWith(text));
	}

	const atMatch = text.match(/(@[^\s]*)$/);
	if (atMatch) {
		const prefix = atMatch[0]!;
		const searchPattern = prefix.slice(1);
		const pattern = searchPattern.includes("/") ? searchPattern + "*" : "**/" + searchPattern + "*";
		const files = await getFileCompletions(pattern);
		return files.map((file: string) => text.replace(/@[^\s]*$/, "@" + file));
	}

	return [];
}

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

async function acceptInput(state: State): Promise<void> {
	const input = inputBuffer.trim();

	if (isRequestActive()) {
		await interject(state, input);
		return;
	}

	// Move cursor to end of prompt text before writing newline, so output
	// appears below the prompt, not below cursor position.
	const consoleWidth = process.stdout.columns || 80;
	const endAbsolutePos = 2 + inputBuffer.length;
	const cursorAbsolutePos = 2 + cursorPosition;
	const cursorRow = Math.floor(cursorAbsolutePos / consoleWidth);
	const endRow = Math.floor(endAbsolutePos / consoleWidth);
	const rowsToEnd = endRow - cursorRow;

	if (rowsToEnd > 0) {
		process.stdout.write(ansi.CURSOR_DOWN(rowsToEnd));
	}
	const endCol = endAbsolutePos % consoleWidth;
	process.stdout.write(ansi.CURSOR_COL(endCol));

	process.stdout.write("\n\n");

	resetInputBufferState();
	userTyping = false;

	if (!input) {
		writePrompt();
		return;
	}

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
			writePrompt();
			return;
		} else if (input.startsWith("/")) {
			const parts = input.match(/(\/[^\s]+)\s*(.*)/)!;
			if (parts) {
				const commandName = parts[1];
				const extra = parts[2]?.trim();
				for (let command of SLASH_COMMANDS) {
					if (command.name === commandName) {
						await command.run(state, extra);
						writePrompt();
						return;
					}
				}
			}
			writePrompt();
			return;
		}

		process.stdout.write(ansi.CURSOR_HIDE);
		if (isLoggingEnabled()) {
			console.log(`📝 ${ansi.BRIGHT_BLACK}Logging to ${getLogDir()}\n${ansi.RESET}`);
		}
		await sendPrompt(state, input);
	} catch (error: any) {
		stopAnimation();
		process.stdout.write(ansi.CURSOR_SHOW);
		console.error("Error:", error.message);
		writePrompt();
	}
}

// Inject `input` into the currently running turn as an interjection (via
// promptAsync). Commits the typed text as a `# user` echo line, drops back to
// spinner-only, and hides the cursor while the turn keeps streaming.
async function interject(state: State, input: string): Promise<void> {
	// Echo the interjection as a user-prompt line in the managed output so it
	// survives subsequent streaming redraws (the server's own echo is dropped in
	// processText via pendingUserEcho).
	if (input) {
		state.accumulatedResponse.push({
			key: `user-${Date.now()}-${Math.random()}`,
			title: "user",
			text: input,
		});
	}

	// Cursor is within the input region; navigate to the live-area top using the
	// current (pre-reset) tracking and clear the spinner+input rows before
	// render() rewrites the region (otherwise short new output lines leave
	// fragments of the typed text behind).
	navigateToPromptRow();
	process.stdout.write(ansi.CLEAR_FROM_CURSOR);
	resetInputBufferState();
	userTyping = false;
	process.stdout.write(ansi.CURSOR_HIDE);
	render(state);

	if (!input) {
		if (isRequestActive()) resumeAnimation(state);
		return;
	}

	try {
		await injectMessage(state, input);
	} catch (error: any) {
		console.error("Error:", error.message);
	}

	// The turn may have completed while we were awaiting the inject; only
	// resume the spinner if the request is still active.
	if (isRequestActive()) {
		resumeAnimation(state);
	}
}

function resetInputBufferState(): void {
	oldInputBuffer = "";
	oldWrappedRows = 0;
	oldCursorRow = 0;
	oldInputDrawn = false;
	oldHeaderRows = 0;
	inputBuffer = "";
	cursorPosition = 0;
	completionCycling = false;
	completions = [];
	currentInputBuffer = null;
}

export async function loadSessionHistory(state: State): Promise<string[]> {
	try {
		const result = await state.client.session.messages({
			path: { id: state.sessionID },
		});
		if (result.error || !result.data) {
			return [];
		}

		const history: string[] = [];
		for (const msg of result.data) {
			if (msg.info.role === "user") {
				const textParts = msg.parts
					.filter((p: Part) => p.type === "text")
					.map((p: Part) => (p as any).text || "")
					.filter(Boolean);
				const text = textParts.join("").trim();
				if (text && !text.startsWith("/")) {
					history.push(text);
				}
			}
		}
		return history;
	} catch {
		return [];
	}
}

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

// Test helpers
export function _setInputState(state: {
	inputBuffer?: string;
	cursorPosition?: number;
	oldInputBuffer?: string;
	oldWrappedRows?: number;
	oldCursorRow?: number;
	oldInputDrawn?: boolean;
	oldHeaderRows?: number;
}): void {
	if (state.inputBuffer !== undefined) inputBuffer = state.inputBuffer;
	if (state.cursorPosition !== undefined) cursorPosition = state.cursorPosition;
	if (state.oldInputBuffer !== undefined) oldInputBuffer = state.oldInputBuffer;
	if (state.oldWrappedRows !== undefined) oldWrappedRows = state.oldWrappedRows;
	if (state.oldCursorRow !== undefined) oldCursorRow = state.oldCursorRow;
	if (state.oldInputDrawn !== undefined) oldInputDrawn = state.oldInputDrawn;
	if (state.oldHeaderRows !== undefined) oldHeaderRows = state.oldHeaderRows;
}

export function _resetInputState(): void {
	inputBuffer = "";
	cursorPosition = 0;
	oldInputBuffer = "";
	oldWrappedRows = 0;
	oldCursorRow = 0;
	oldInputDrawn = false;
	oldHeaderRows = 0;
	userTyping = false;
}
