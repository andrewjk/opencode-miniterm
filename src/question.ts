import type { Key } from "node:readline";
import * as ansi from "./ansi";
import { config } from "./config";
import { resetInputBufferState } from "./input";
import { resumeAnimation, stopAnimation } from "./render";
import { drainPendingPrompt, sendPrompt, setRequestActive } from "./server";
import type { State } from "./types";
import { wrapLines } from "./wrap";

interface QuestionEvent {
	type: "question.asked";
	properties: {
		id: string;
		sessionID: string;
		questions: Question[];
		tool: {
			messageID: string;
			callID: string;
		};
	};
}

interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
}

interface QuestionOption {
	label: string;
	description: string;
}

interface QuestionState {
	active: boolean;
	questionID: string;
	sessionID: string;
	messageID: string;
	callID: string;
	questions: Question[];
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

export function startQuestion(event: QuestionEvent, state: State): QuestionState {
	const { questions, id, tool, sessionID } = event.properties;
	const isChild = sessionID !== state.sessionID;

	stopAnimation();
	process.stdout.write(ansi.CURSOR_SHOW);

	// Only the parent's own question aborts/restarts the parent turn. A
	// subagent (child) question must keep the parent turn intact — the parent
	// is just waiting on the task tool — so we simply pause the UI and route
	// the answer to the child session.
	if (!isChild) {
		state.client.session.abort({ path: { id: state.sessionID } }).catch(() => {});
		setRequestActive(false);
	}

	currentState = state;
	questionState = {
		active: true,
		questionID: id,
		sessionID,
		messageID: tool.messageID,
		callID: tool.callID,
		questions,
		selectedIndex: 0,
		customMode: false,
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
			const currentQuestion = questionState.questions[0];
			if (currentQuestion && questionState.selectedIndex < currentQuestion.options.length - 1) {
				questionState.selectedIndex++;
				renderQuestion();
			}
			return true;
		}
		case "return": {
			const currentQuestion = questionState.questions[0];
			if (currentQuestion) {
				const selectedOption = currentQuestion.options[questionState.selectedIndex];
				if (selectedOption) {
					submitAnswer(selectedOption.label);
				}
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

async function submitAnswer(answer: string): Promise<void> {
	if (!questionState || !currentState) return;

	const questions = questionState.questions;
	const stateCopy = currentState;
	const sessionID = questionState.sessionID;
	const isChild = sessionID !== stateCopy.sessionID;
	const currentQuestion = questions[0];

	clearQuestion();
	questionState = null;
	currentState = null;

	if (currentQuestion) {
		process.stdout.write(`${ansi.CYAN}${currentQuestion.header}${ansi.RESET}\n`);
		process.stdout.write(`  ${ansi.BRIGHT_BLACK}${currentQuestion.question}${ansi.RESET}\n`);
	}
	process.stdout.write(`  ${ansi.BRIGHT_WHITE}🗣️${ansi.RESET} ${answer}\n\n`);

	// The dismissed overlay leaves the live-area cursor tracking (input row
	// offsets, header rows) describing the overlay/spinner layout rather than
	// the rows we just wrote. Reset it so the current cursor position — just
	// below the answer echo — becomes the top of the live area for whatever
	// rendering comes next, otherwise repaints stack on the stale offsets.
	resetInputBufferState();

	if (!isChild) {
		// Parent: the question aborted the parent turn, so the answer kicks off
		// a brand-new turn. Hand off to sendPrompt so requestActive, the
		// animation loop, accumulatedResponse and renderedLines are reset
		// exactly like a normal prompt — streaming repaints then line up
		// beneath the echo instead of overwriting stale overlay state.
		process.stdout.write(ansi.CURSOR_HIDE);
		await sendPrompt(stateCopy, answer);
		return;
	}

	try {
		const result = await stateCopy.client.session.prompt({
			path: { id: sessionID },
			body: {
				model: {
					providerID: config.providerID,
					modelID: config.modelID,
				},
				parts: [{ type: "text", text: answer }],
			},
		});

		if (result.error) {
			console.error(`${ansi.RED}Failed to send answer:${ansi.RESET}`, result.error);
		}
	} catch (error) {
		console.error(`${ansi.RED}Failed to send answer:${ansi.RESET}`, error);
	}

	// Subagent question answered: the parent turn is still in flight, so
	// resume its spinner/output instead of dropping to a fresh prompt —
	// unless another queued prompt takes over the screen.
	if (!drainPendingPrompt(stateCopy)) resumeAnimation(stateCopy);
}

export function renderQuestion(): void {
	if (!questionState) return;

	const currentQuestion = questionState.questions[0];
	if (!currentQuestion) return;

	const lines: string[] = [];
	const consoleWidth = process.stdout.columns || 80;

	lines.push("");
	lines.push(`${ansi.CYAN}${currentQuestion.header}${ansi.RESET}`);
	lines.push("");
	lines.push(`  ${currentQuestion.question}`);
	lines.push("");

	if (questionState.customMode) {
		lines.push(`${ansi.BRIGHT_WHITE}  Type your answer:${ansi.RESET}`);
		lines.push(`  ${ansi.GREEN}>${ansi.RESET} ${questionState.customInput}_`);
	} else {
		currentQuestion.options.forEach((option, index) => {
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
