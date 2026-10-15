import type { Key } from "node:readline";
import * as ansi from "./ansi";
import { resetInputBufferState } from "./input";
import { resumeAnimation, stopAnimation } from "./render";
import { drainPendingPrompt } from "./server";
import type { State } from "./types";
import { wrapLines } from "./wrap";

interface FormOption {
	value: string;
	label: string;
	description?: string;
}

interface FormField {
	key: string;
	type: string;
	title?: string;
	description?: string;
	options?: FormOption[];
}

export interface FormInfo {
	id: string;
	sessionID: string;
	title: string;
	fields: FormField[];
}

interface QuestionState {
	active: boolean;
	formID: string;
	sessionID: string;
	fieldKey: string;
	header: string;
	question: string;
	options: FormOption[];
	selectedIndex: number;
	customMode: boolean;
	customInput: string;
}

let questionState: QuestionState | null = null;
let renderLines: string[] = [];
let currentState: State | null = null;

export function getQuestionState(): QuestionState | null {
	return questionState;
}

export function setQuestionState(state: QuestionState | null): void {
	questionState = state;
}

export function startQuestion(form: FormInfo, state: State): QuestionState {
	const field = form.fields[0];
	const options = (field?.options ?? []).map((option) => ({
		value: option.value,
		label: option.label,
		description: option.description || option.value,
	}));

	stopAnimation();
	process.stdout.write(ansi.CURSOR_SHOW);

	currentState = state;
	questionState = {
		active: true,
		formID: form.id,
		sessionID: form.sessionID,
		fieldKey: field?.key ?? "",
		header: form.title,
		question: field?.title || field?.description || form.title,
		options,
		selectedIndex: 0,
		// A field without options (free text/number) starts in typing mode.
		customMode: options.length === 0,
		customInput: "",
	};
	renderLines = [];
	renderQuestion();
	return questionState;
}

export function handleQuestionKeyPress(str: string, key: Key): boolean {
	if (!questionState || !questionState.active) {
		return false;
	}

	if (questionState.customMode) {
		return handleCustomInput(str, key);
	}

	switch (key.name) {
		case "up": {
			if (questionState.selectedIndex > 0) {
				questionState.selectedIndex--;
				renderQuestion();
			}
			return true;
		}
		case "down": {
			if (questionState.selectedIndex < questionState.options.length - 1) {
				questionState.selectedIndex++;
				renderQuestion();
			}
			return true;
		}
		case "return": {
			const selectedOption = questionState.options[questionState.selectedIndex];
			if (selectedOption) {
				submitAnswer(selectedOption.value);
			}
			return true;
		}
		case "escape": {
			questionState.customMode = true;
			questionState.customInput = "";
			renderQuestion();
			return true;
		}
		default: {
			if (str && str.match(/^[a-zA-Z0-9 ]$/)) {
				questionState.customMode = true;
				questionState.customInput = str;
				renderQuestion();
				return true;
			}
			return false;
		}
	}
}

function handleCustomInput(str: string, key: Key): boolean {
	if (!questionState) return false;

	switch (key.name) {
		case "return": {
			if (questionState.customInput.trim()) {
				submitAnswer(questionState.customInput.trim());
			}
			return true;
		}
		case "escape": {
			questionState.customMode = false;
			questionState.customInput = "";
			renderQuestion();
			return true;
		}
		case "backspace": {
			questionState.customInput = questionState.customInput.slice(0, -1);
			renderQuestion();
			return true;
		}
		default: {
			if (str && str.length === 1 && str.match(/^[ -~]$/)) {
				questionState.customInput += str;
				renderQuestion();
				return true;
			}
			return false;
		}
	}
}

async function submitAnswer(value: string): Promise<void> {
	if (!questionState || !currentState) return;

	const stateCopy = currentState;
	const { formID, sessionID, fieldKey, header, question } = questionState;

	clearQuestion();
	questionState = null;
	currentState = null;

	process.stdout.write(`${ansi.CYAN}${header}${ansi.RESET}\n`);
	process.stdout.write(`  ${ansi.BRIGHT_BLACK}${question}${ansi.RESET}\n`);
	process.stdout.write(`  ${ansi.BRIGHT_WHITE}🗣️${ansi.RESET} ${value}\n\n`);

	resetInputBufferState();

	try {
		await stateCopy.client.session.form.reply({
			sessionID,
			formID,
			answer: { [fieldKey]: value },
		});
	} catch (error) {
		console.error(`${ansi.RED}Failed to send answer:${ansi.RESET}`, error);
	}

	// The form reply unblocks the turn that was waiting, so resume its spinner
	// unless another queued prompt takes over the screen.
	if (!drainPendingPrompt(stateCopy)) resumeAnimation(stateCopy);
}

export function renderQuestion(): void {
	if (!questionState) return;

	const lines: string[] = [];
	const consoleWidth = process.stdout.columns || 80;

	lines.push("");
	lines.push(`${ansi.CYAN}${questionState.header}${ansi.RESET}`);
	lines.push("");
	lines.push(`  ${questionState.question}`);
	lines.push("");

	if (questionState.customMode) {
		lines.push(`${ansi.BRIGHT_WHITE}  Type your answer:${ansi.RESET}`);
		lines.push(`  ${ansi.GREEN}>${ansi.RESET} ${questionState.customInput}_`);
	} else {
		questionState.options.forEach((option, index) => {
			const isSelected = index === questionState!.selectedIndex;
			const prefix = isSelected ? `${ansi.GREEN}►${ansi.RESET}` : " ";
			lines.push(`  ${prefix} ${index + 1}. ${option.label}`);
			if (isSelected || option.description) {
				const desc = option.description || "";
				lines.push(`       ${ansi.BRIGHT_BLACK}${desc}${ansi.RESET}`);
			}
		});
		lines.push("");
		lines.push(
			`${ansi.BRIGHT_BLACK}  ↑/↓ to select, Enter to confirm, Esc to type custom${ansi.RESET}`,
		);
	}

	const wrappedLines = wrapLines(lines, consoleWidth);

	clearRenderedLines();
	renderLines = wrappedLines;

	for (const line of wrappedLines) {
		process.stdout.write(line + "\n");
	}
}

function clearRenderedLines(): void {
	if (renderLines.length > 0) {
		process.stdout.write(`${ansi.CURSOR_UP(renderLines.length)}${ansi.CLEAR_FROM_CURSOR}`);
	}
}

function clearQuestion(): void {
	clearRenderedLines();
	renderLines = [];
}
