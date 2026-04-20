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
import { getQuestionState, handleQuestionKeyPress } from "./question";
import { startAnimation, stopAnimation, writePrompt } from "./render";
import { sendMessage } from "./server";
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
let currentInputBuffer: string | null = null;
let isRequestActive = false;

let oldInputBuffer = "";
let oldWrappedRows = 0;
let oldCursorRow = 0;
export function renderLine(): void {
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
		writePrompt();
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
}

export async function handleKeyPress(state: State, str: string, key: Key) {
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
			if (isRequestActive) {
				if (state.sessionID) {
					state.client.session.abort({ path: { id: state.sessionID } }).catch(() => {});
				}
				stopAnimation();
				process.stdout.write(ansi.CURSOR_SHOW);
				process.stdout.write(`\r  ${ansi.BRIGHT_BLACK}Cancelled request${ansi.RESET}\n\n`);
				writePrompt();
				isRequestActive = false;
			} else {
				inputBuffer = "";
				cursorPosition = 0;
				currentInputBuffer = null;
				renderLine();
			}
			return;
		}
		case "return": {
			await acceptInput(state);
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
				inputBuffer =
					inputBuffer.slice(0, cursorPosition) + str + inputBuffer.slice(cursorPosition);
				cursorPosition += str.length;
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
	process.stdout.write("\n");

	const input = inputBuffer.trim();

	oldInputBuffer = "";
	oldWrappedRows = 0;
	oldCursorRow = 0;

	inputBuffer = "";
	cursorPosition = 0;
	completionCycling = false;
	completions = [];
	currentInputBuffer = null;

	if (input) {
		if (history[history.length - 1] !== input) {
			history.push(input);
		}
		historyIndex = history.length;
		try {
			if (input === "/help") {
				process.stdout.write("\n");
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
							process.stdout.write("\n");
							await command.run(state, extra);
							writePrompt();
							return;
						}
					}
				}
				return;
			}

			isRequestActive = true;
			process.stdout.write("\n");
			process.stdout.write(ansi.CURSOR_HIDE);
			startAnimation();
			if (isLoggingEnabled()) {
				console.log(`📝 ${ansi.BRIGHT_BLACK}Logging to ${getLogDir()}\n${ansi.RESET}`);
			}
			await sendMessage(state, input);
			isRequestActive = false;
		} catch (error: any) {
			isRequestActive = false;
			if (error.message !== "Request cancelled") {
				stopAnimation();
				console.error("Error:", error.message);
			}
		}
	}
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
}): void {
	if (state.inputBuffer !== undefined) inputBuffer = state.inputBuffer;
	if (state.cursorPosition !== undefined) cursorPosition = state.cursorPosition;
	if (state.oldInputBuffer !== undefined) oldInputBuffer = state.oldInputBuffer;
	if (state.oldWrappedRows !== undefined) oldWrappedRows = state.oldWrappedRows;
	if (state.oldCursorRow !== undefined) oldCursorRow = state.oldCursorRow;
}

export function _resetInputState(): void {
	inputBuffer = "";
	cursorPosition = 0;
	oldInputBuffer = "";
	oldWrappedRows = 0;
	oldCursorRow = 0;
}

export function setIsRequestActive(value: boolean): void {
	isRequestActive = value;
}
