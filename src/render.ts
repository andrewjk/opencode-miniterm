import { type State } from ".";

export function render(state: State, details = false): void {
	clearRenderedLines(state);

	let output = "";

	if (details) {
		output += "📋 Detailed output from the last run:\n\n";
	}

	// Only show the last (i.e. active) thinking part
	// Only show the last (i.e. active) tool use
	// Only show the last files part between parts
	let foundPart = false;
	let foundPartBetweenFiles = true;
	let foundFiles = false;
	for (let i = state.accumulatedResponse.length - 1; i >= 0; i--) {
		const part = state.accumulatedResponse[i]!;
		if (details) {
			part.active = true;
			continue;
		}

		if (part.title === "thinking") {
			part.active = !foundPart;
			foundPart = true;
			foundPartBetweenFiles = part.active;
		} else if (part.title === "tool") {
			part.active = !foundPart;
			foundPartBetweenFiles = part.active;
		} else if (part.title === "files") {
			part.active = foundPartBetweenFiles && !foundFiles;
			foundPartBetweenFiles = false;
			foundFiles = part.active;
		} else {
			foundPart = true;
			foundPartBetweenFiles = true;
			part.active = true;
		}
	}

	for (let i = 0; i < state.accumulatedResponse.length; i++) {
		const part = state.accumulatedResponse[i];
		if (!part || !part.active || !part.text.trim()) continue;

		if (part.title === "thinking") {
			output += `💭 \x1b[90m${lastThinkingLines(part.text.trimStart())}\x1b[0m\n\n`;
		} else if (part.title === "response") {
			output += `💬 ${part.text.trimStart()}\n\n`;
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

function lastThinkingLines(text: string): string {
	const consoleWidth = process.stdout.columns || 80;
	const strippedText = stripAnsiCodes(text);

	let lineCount = 0;
	let col = 0;
	const lineBreaks: number[] = [0];

	for (let i = 0; i < strippedText.length; i++) {
		const char = strippedText[i];

		if (char === "\n") {
			lineCount++;
			col = 0;
			lineBreaks.push(i + 1);
		} else if (char === "\r") {
			continue;
		} else {
			col++;
			if (col >= consoleWidth) {
				lineCount++;
				col = 0;
				lineBreaks.push(i);
			}
		}
	}

	if (col > 0) {
		lineCount++;
	}

	const startIndex = lineBreaks[Math.max(0, lineBreaks.length - 10)] || 0;
	return text.slice(startIndex);
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
