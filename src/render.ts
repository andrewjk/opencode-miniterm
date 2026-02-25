import type { OpencodeClient } from "@opencode-ai/sdk";
import * as ansi from "./ansi";
import { config } from "./config";
import type { State } from "./index";

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
		} else if (part.title === "tool") {
			part.active = !foundPart;
		} else if (part.title === "files") {
			part.active = !foundFiles;
			foundFiles = true;
		} else {
			foundPart = true;
			part.active = true;
		}
	}

	for (let i = 0; i < state.accumulatedResponse.length; i++) {
		const part = state.accumulatedResponse[i];
		if (!part || !part.active || !part.text.trim()) continue;

		if (part.title === "thinking") {
			const partText = details ? part.text.trimStart() : lastThinkingLines(part.text.trimStart());
			output += `💭 ${ansi.BRIGHT_BLACK}Thinking...\n\n${partText}${ansi.RESET}\n\n`;
		} else if (part.title === "response") {
			output += `💬 Response:\n\n${part.text.trimStart()}\n\n`;
		} else if (part.title === "tool") {
			const toolText = part.text;
			const colonIndex = toolText.indexOf(":");
			if (colonIndex !== -1) {
				const prefix = toolText.slice(0, colonIndex + 1);
				const suffix = toolText.slice(colonIndex + 1);
				output += `${prefix} ${ansi.BRIGHT_BLACK}${suffix}${ansi.RESET}\n\n`;
			} else {
				output += toolText + "\n\n";
			}
		} else if (part.title === "files") {
			output += part.text + "\n\n";
		}
	}

	if (output) {
		if (process.stdout.columns) {
			const lines = wrapText(output, process.stdout.columns);
			for (let i = 0; i < lines.length; i++) {
				state.write(lines[i]!);
				state.write("\n");
			}
			state.renderedLinesCount = lines.length;
		} else {
			state.write(output);
			countRenderedLines(state, output);
		}
	}
}

function lastThinkingLines(text: string): string {
	const consoleWidth = process.stdout.columns || 80;
	const strippedText = ansi.stripAnsiCodes(text);

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
		state.write(`${ansi.CURSOR_UP(state.renderedLinesCount)}\x1b[J`);
		state.write(ansi.CURSOR_HOME);
		state.renderedLinesCount = 0;
	}
}

function countRenderedLines(state: State, output: string): void {
	const consoleWidth = process.stdout.columns || 80;
	const strippedOutput = ansi.stripAnsiCodes(output);

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

export function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	let currentLine = "";
	let visibleLength = 0;
	let i = 0;

	const pushLine = () => {
		lines.push(currentLine);
		currentLine = "";
		visibleLength = 0;
	};

	const addWord = (word: string, wordVisibleLength: number) => {
		if (!word || wordVisibleLength === 0) return;

		const wouldFit =
			visibleLength === 0
				? wordVisibleLength <= width
				: visibleLength + 1 + wordVisibleLength <= width;

		if (wouldFit) {
			if (visibleLength > 0) {
				currentLine += " ";
				visibleLength++;
			}
			currentLine += word;
			visibleLength += wordVisibleLength;
		} else if (visibleLength > 0) {
			pushLine();
			currentLine = word;
			visibleLength = wordVisibleLength;
		} else if (wordVisibleLength <= width) {
			currentLine = word;
			visibleLength = wordVisibleLength;
		} else {
			const wordWidth = width;
			for (let w = 0; w < word.length; ) {
				let segment = "";
				let segmentVisible = 0;
				let segmentStart = w;

				while (w < word.length && segmentVisible < wordWidth) {
					const char = word[w];
					if (char === "\x1b" && word[w + 1] === "[") {
						const ansiMatch = word.slice(w).match(ansi.ANSI_CODE_PATTERN);
						if (ansiMatch) {
							segment += ansiMatch[0];
							w += ansiMatch[0].length;
						} else {
							segment += char;
							w++;
						}
					} else {
						segment += char;
						segmentVisible++;
						w++;
					}
				}

				if (segment) {
					if (currentLine) {
						pushLine();
					}
					currentLine = segment;
					visibleLength = segmentVisible;
				}
			}
		}
	};

	while (i < text.length) {
		const char = text[i];

		if (char === "\n") {
			pushLine();
			i++;
		} else if (char === "\r") {
			i++;
		} else if (char === " " || char === "\t") {
			i++;
		} else {
			let word = "";
			let wordVisibleLength = 0;

			while (i < text.length) {
				const char = text[i];
				if (char === "\n" || char === "\r" || char === " " || char === "\t") {
					break;
				} else if (char === "\x1b" && text[i + 1] === "[") {
					const ansiMatch = text.slice(i).match(ansi.ANSI_CODE_PATTERN);
					if (ansiMatch) {
						word += ansiMatch[0];
						i += ansiMatch[0].length;
					} else {
						word += char;
						i++;
					}
				} else {
					word += char;
					wordVisibleLength++;
					i++;
				}
			}

			addWord(word, wordVisibleLength);
		}
	}

	if (currentLine || lines.length === 0) {
		pushLine();
	}

	return lines;
}

export function writePrompt(): void {
	stopAnimation();
	process.stdout.write(ansi.CURSOR_SHOW);
	process.stdout.write(`${ansi.BOLD_MAGENTA}# ${ansi.RESET}`);
}

const ANIMATION_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇"];
let animationInterval: ReturnType<typeof setInterval> | null = null;

export function startAnimation(): void {
	if (animationInterval) return;

	let index = 0;
	animationInterval = setInterval(() => {
		process.stdout.write(`\r${ansi.BOLD_MAGENTA}`);
		process.stdout.write(`${ANIMATION_CHARS[index]}${ansi.RESET}`);
		index = (index + 1) % ANIMATION_CHARS.length;
	}, 100);
}

export function stopAnimation(): void {
	if (animationInterval) {
		clearInterval(animationInterval);
		animationInterval = null;
	}
	process.stdout.write(`\r${ansi.CLEAR_LINE}`);
}

export async function getActiveDisplay(client: OpencodeClient): Promise<string> {
	let agentName = "";
	let providerName = "";
	let modelName = "";
	try {
		const [agentsResult, providersResult] = await Promise.all([
			client.app.agents(),
			client.config.providers(),
		]);
		if (!agentsResult.error) {
			const agents = agentsResult.data || [];
			const agent = agents.find((a) => a.name === config.agentID);
			if (agent) {
				agentName = agent.name.substring(0, 1).toUpperCase() + agent.name.substring(1);
			}
		}
		if (!providersResult.error) {
			const providers = providersResult.data?.providers || [];
			for (const provider of providers) {
				const models = Object.values(provider.models || {});
				for (const model of models) {
					if (provider.id === config.providerID && model.id === config.modelID) {
						providerName = provider.name;
						modelName = model.name || model.id;
						break;
					}
				}
				if (providerName) break;
			}
		}
	} catch (error) {}

	const parts: string[] = [];
	if (agentName) {
		parts.push(`${ansi.CYAN}${agentName}${ansi.RESET}`);
	}
	if (modelName) {
		let modelPart = `${ansi.BRIGHT_WHITE}${modelName}${ansi.RESET}`;
		if (providerName) {
			modelPart += ` ${ansi.BRIGHT_BLACK}(${providerName})${ansi.RESET}`;
		}
		parts.push(modelPart);
	}

	return parts.join("  ");
}
