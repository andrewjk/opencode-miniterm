import readline from "node:readline";
import { type State } from ".";

export function render(state: State): void {
	clearRenderedLines(state);

	let output = "";

	let lastIndex = state.accumulatedResponse.length;
	while (lastIndex--) {
		if (state.accumulatedResponse[lastIndex].text) {
			break;
		}
	}

	for (let i = 0; i < state.accumulatedResponse.length; i++) {
		const part = state.accumulatedResponse[i];
		if (!part || !part.text) continue;

		if (part.title === "thinking") {
			// Only if it's the last part (i.e. disappear thinking as soon as
			// there's a response etc)
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
			// Skip to the last files part
			while (state.accumulatedResponse[i + 1].title === "files") {
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
		state.write(`\x1b[${state.renderedLinesCount}A\x1b[J`);
		//readline.cursorTo(process.stdout, )
		readline.clearScreenDown(process.stdout);
		state.renderedLinesCount = 0;
	}
}

function countRenderedLines(state: State, output: string): void {
	state.renderedLinesCount = 0;

	output = stripAnsiCodes(output);
	for (let i = 0; i < output.length; i++) {
		if (output[i] === "\n") {
			state.renderedLinesCount++;
		}
	}

	//const consoleWidth = process.stdout.columns || 80;
	//let charColumn = 0;
	//for (let i = 0; i < output.length; i++) {
	//	if (output[i] === "\n" || charColumn > consoleWidth) {
	//		state.renderedLinesCount++;
	//		charColumn = 0;
	//	} else {
	//		charColumn++;
	//	}
	//}
}

function stripAnsiCodes(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
