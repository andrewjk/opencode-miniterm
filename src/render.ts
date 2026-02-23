import { type State } from ".";

export function render(state: State): void {
	clearRenderedLines(state);

	let output = "";

	let lastIndex = state.accumulatedResponse.length;
	while (lastIndex--) {
		const part = state.accumulatedResponse[lastIndex];
		if (part?.text) {
			break;
		}
	}

	for (let i = 0; i < state.accumulatedResponse.length; i++) {
		const part = state.accumulatedResponse[i];
		if (!part.text.trim()) continue;

		if (part.title === "thinking") {
			if (i === lastIndex) {
				output += "💭 Thinking...\n\n";
				output += `\x1b[90m${part.text}\x1b[0m\n\n`;
			}
		} else if (part.title === "response") {
			output += "💬 Response:\n\n";
			output += part.text + "\n\n";
		} else if (part.title === "tool") {
			output += part.text + "\n\n";
		} else if (part.title === "files") {
			while (state.accumulatedResponse[i + 1]?.title === "files") {
				i++;
			}
			output += part.text + "\n\n";
		}
	}

	if (output) {
		state.write(output);
		countRenderedLines(state, output);
	}
}

function clearRenderedLines(state: State): void {
	if (state.renderedLinesCount > 0) {
		process.stdout.write(`\x1b[${state.renderedLinesCount}A\x1b[0J`);
		process.stdout.write("\x1b[0G");
		state.renderedLinesCount = 0;
	}
}

function countRenderedLines(state: State, output: string): void {
	const consoleWidth = process.stdout.columns || 80;
	const strippedOutput = stripAnsiCodes(output);

	let lineCount = 0;
	let col = 0;

	for (let i = 0; i < strippedOutput.length; i++) {
		const char = strippedOutput[i];

		if (char === "\n") {
			lineCount++;
			col = 0;
		} else if (char === "\r") {
			continue;
		} else {
			col++;
			if (col >= consoleWidth) {
				lineCount++;
				col = 0;
			}
		}
	}

	if (col > 0) {
		lineCount++;
	}

	state.renderedLinesCount = lineCount;
}

function stripAnsiCodes(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
