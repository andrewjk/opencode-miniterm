import { type State } from ".";

export function render(state: State): void {
	clearRenderedLines(state);

	let output = "";

	for (let i = 0; i < state.accumulatedResponse.length; i++) {
		const part = state.accumulatedResponse[i];
		if (!part || !part.text) continue;

		if (part.title === "thinking" && i === state.accumulatedResponse.length - 1) {
			output += "💭 Thinking...\n\n";
			output += `\x1b[90m${part.text}\x1b[0m\n\n`;
		} else if (part.title === "response") {
			output += "💬 Response:\n\n";
			output += part.text + "\n\n";
		} else if (part.title === "tool") {
			output += part.text + "\n\n";
		} else if (part.title === "files") {
			output += part.text + "\n\n";
		}
	}

	if (output) {
		state.write(output);

		state.renderedLinesCount = 0;
		for (let i = 0; i < output.length; i++) {
			if (output[i] === "\n") {
				state.renderedLinesCount++;
			}
		}
	}
}

function clearRenderedLines(state: State): void {
	if (state.renderedLinesCount > 0) {
		state.write(`\x1b[${state.renderedLinesCount}A\x1b[J`);
		state.renderedLinesCount = 0;
	}
}
