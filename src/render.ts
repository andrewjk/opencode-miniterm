import type { OpencodeClient } from "@opencode-ai/sdk";
import { gfm, transform, consoleRenderers } from "allmark";
import * as ansi from "./ansi";
import { config } from "./config";
import type { State } from "./types";
import { formatDuration } from "./utils";

export function render(state: State, details = false): void {
	let output = "";

	if (details) {
		output += "📋 Detailed output from the last run:\n\n";
	}

	// Only show the last (i.e. active) thinking part
	let foundPart = false;
	for (let i = state.accumulatedResponse.length - 1; i >= 0; i--) {
		const part = state.accumulatedResponse[i];
		if (!part) continue;
		if (details) {
			part.active = true;
			continue;
		}

		if (part.title === "thinking") {
			if (part.active === false) {
				// We've already checked all the parts before here
				break;
			}
			part.active = !foundPart;
			foundPart = true;
		} else if (part.title === "response") {
			part.active = true;
			foundPart = true;
		} else {
			part.active = true;
		}
	}

	let lastPartWasTool = false;
	for (let i = 0; i < state.accumulatedResponse.length; i++) {
		const part = state.accumulatedResponse[i];
		if (!part || !part.active) continue;
		if (!part.text.trim()) continue;

		if (part.title === "thinking") {
			let partText = ansi.stripAnsiCodes(transform(part.text.trimStart(), gfm, consoleRenderers).trimEnd());

			// Show max 10 thinking lines
			partText = details ? partText : lastThinkingLines(partText);

			output += "<ocmt-thinking>\n";
			output += `💭 ${partText}\n\n`;
			output += "</ocmt-thinking>\n";
		} else if (part.title === "response") {
			// Show all response lines
			let partText = transform(part.text.trimStart(), gfm, consoleRenderers).trimEnd();
			output += `💬 ${partText}\n\n`;
		} else if (part.title === "tool") {
			// TODO: Show max 10 tool/file lines?
			if (lastPartWasTool && output.endsWith("\n\n")) {
				output = output.substring(0, output.length - 1);
			}
			output += part.text + "\n\n";
		} else if (part.title === "files") {
			// TODO: Show max 10 tool/file lines?
			output += part.text + "\n\n";
		} else if (part.title === "todo") {
			// Show the whole todo list
			output += part.text + "\n\n";
		}

		lastPartWasTool = part.title === "tool";
	}

	if (output) {
		const lines = wrapText(output, process.stdout.columns || 80);

		// Clear lines that have changed
		let firstDiff = state.renderedLines.length;
		for (let i = 0; i < Math.max(state.renderedLines.length, lines.length); i++) {
			if (state.renderedLines[i] !== lines[i]) {
				firstDiff = i;
				break;
			}
		}
		let linesToClear = state.renderedLines.length - firstDiff;
		clearRenderedLines(state, linesToClear);

		// Write new lines
		for (let i = firstDiff; i < lines.length; i++) {
			state.write(lines[i]!);
			state.write("\n");
		}

		state.renderedLines = lines;
	} else if (state.renderedLines.length > 0) {
		clearRenderedLines(state, state.renderedLines.length);
		state.renderedLines = [];
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

function clearRenderedLines(state: State, linesToClear: number): void {
	if (linesToClear > 0) {
		state.write(`${ansi.CURSOR_UP(linesToClear)}${ansi.CURSOR_HOME}${ansi.CLEAR_FROM_CURSOR}`);
	}
	state.write(`${ansi.CURSOR_HOME}`);
}

export function wrapText(text: string, width: number): string[] {
	const INDENT = "  ";
	const indentLength = INDENT.length;
	const lines: string[] = [];
	let currentLine = INDENT;
	let visibleLength = indentLength;
	let i = 0;

	let inThinking = false;

	const pushLine = () => {
		if (currentLine === "  <ocmt-thinking>") {
			inThinking = true;
		} else if (currentLine === "  </ocmt-thinking>") {
			inThinking = false;
		} else {
			let text = inThinking ? `${ansi.BRIGHT_BLACK}${currentLine}${ansi.RESET}` : currentLine;
			lines.push(text);
		}

		currentLine = INDENT;
		visibleLength = indentLength;
	};

	const addWord = (word: string, wordVisibleLength: number) => {
		if (!word || wordVisibleLength === 0) return;

		const wouldFit =
			visibleLength === 0
				? wordVisibleLength <= width
				: visibleLength + 1 + wordVisibleLength <= width;

		if (wouldFit) {
			if (visibleLength > indentLength) {
				currentLine += " ";
				visibleLength++;
			}
			currentLine += word;
			visibleLength += wordVisibleLength;
		} else if (visibleLength > indentLength) {
			pushLine();
			currentLine = INDENT + word;
			visibleLength = indentLength + wordVisibleLength;
		} else if (wordVisibleLength <= width) {
			currentLine = INDENT + word;
			visibleLength = indentLength + wordVisibleLength;
		} else {
			const wordWidth = width - indentLength;
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
					currentLine = INDENT + segment;
					visibleLength = indentLength + segmentVisible;
				}
			}
		}
	};

	let atLineStart = true;
	let lineIndent = "";
	while (i < text.length) {
		const char = text[i];

		if (char === "\n") {
			pushLine();
			atLineStart = true;
			lineIndent = "";
			i++;
		} else if (char === "\r") {
			i++;
		} else if (char === " " || char === "\t") {
			if (atLineStart) {
				lineIndent += char;
			}
			i++;
		} else {
			let word = lineIndent;
			let wordVisibleLength = lineIndent.length;
			atLineStart = false;

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
			atLineStart = false;
			lineIndent = "";
		}
	}

	if (currentLine.trim() || lines.length === 0) {
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
let requestStartTime: number | null = null;

export function startAnimation(startTime?: number): void {
	if (animationInterval) return;

	requestStartTime = startTime || Date.now();

	let index = 0;
	animationInterval = setInterval(() => {
		const elapsed = Date.now() - requestStartTime!;
		const elapsedText = formatDuration(elapsed);

		process.stdout.write(
			`\r${ansi.BOLD_MAGENTA}${ANIMATION_CHARS[index]} ${ansi.RESET}${ansi.BRIGHT_BLACK}Running for ${elapsedText}${ansi.RESET}    `,
		);
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

export async function updateSessionTitle(state: State): Promise<void> {
	try {
		const result = await state.client.session.get({
			path: { id: state.sessionID },
		});
		if (!result.error && result.data?.title) {
			setTerminalTitle(result.data.title);
		} else {
			setTerminalTitle(state.sessionID.substring(0, 8));
		}
	} catch {
		setTerminalTitle(state.sessionID.substring(0, 8));
	}
}

export function setTerminalTitle(sessionName: string): void {
	process.stdout.write(`\x1b]0;OC | ${sessionName}\x07`);
}
