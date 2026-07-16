import type { OpencodeClient } from "@opencode-ai/sdk";
import { consoleRenderers, gfm, transform } from "allmark";
import * as ansi from "./ansi";
import { config } from "./config";
import { afterOutputPaint, navigateToPromptRow } from "./input";
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
			const lineWidth = (process.stdout.columns || 80) - 2;
			let partText = ansi.stripAnsiCodes(
				transform(part.text.trimStart(), gfm, consoleRenderers, { lineWidth }).trimEnd(),
			);

			// Show max 10 thinking lines
			partText = details ? partText : lastThinkingLines(partText);

			output += "<ocmt-thinking>\n";
			output += `💭 ${partText}\n\n`;
			output += "</ocmt-thinking>\n";
		} else if (part.title === "response") {
			// Show all response lines
			const lineWidth = (process.stdout.columns || 80) - 2;
			let partText = transform(part.text.trimStart(), gfm, consoleRenderers, {
				lineWidth,
			}).trimEnd();
			output += `💬 ${partText}\n\n`;
		} else if (part.title === "user") {
			output += `${ansi.BOLD_MAGENTA}# ${ansi.RESET}${part.text}\n\n`;
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
		} else if (part.title === "subtask") {
			output += part.text + "\n\n";
		}

		lastPartWasTool = part.title === "tool";
	}

	if (output) {
		const width = process.stdout.columns || 80;
		const lines = wrapText(output, width);

		// Move cursor to the output region bottom (just below the last rendered
		// line), accounting for any input rows currently drawn below it.
		navigateToPromptRow();

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

		// Write new lines. Each line is padded to the full terminal width so
		// that stale trailing characters from a previously-longer line are
		// overwritten (the bulk clear above only runs at the diff point; once
		// written, subsequent paints that reuse these rows rely on this
		// padding to erase leftover glyphs).
		for (let i = firstDiff; i < lines.length; i++) {
			state.write(ansi.padToWidth(lines[i]!, width));
			state.write("\n");
		}

		state.renderedLines = lines;
	} else if (state.renderedLines.length > 0) {
		navigateToPromptRow();
		clearRenderedLines(state, state.renderedLines.length);
		state.renderedLines = [];
	} else {
		// Nothing to draw, but still reposition to the live-area top so the
		// spinner/input repaint (afterOutputPaint) lands on the right row
		// instead of stacking on top of previously painted lines.
		navigateToPromptRow();
	}

	// Re-establish the input line below the freshly rendered output (or reset
	// input tracking so the next keystroke renders cleanly). Skipped for the
	// one-off details view, which has its own prompt lifecycle.
	if (!details) {
		afterOutputPaint();
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

	const addWord = (word: string, wordVisibleLength: number, preSpaces: string) => {
		if (!word || wordVisibleLength === 0) return;

		// Output prespaces + word if it would fit on the line
		// Otherwise, wrap to the next line and only print the word

		const preSpacesLength = preSpaces.length;

		const wouldFit =
			visibleLength === 0
				? preSpacesLength + wordVisibleLength <= width
				: visibleLength + preSpacesLength + wordVisibleLength <= width;

		if (wouldFit) {
			currentLine += preSpaces + word;
			visibleLength += preSpacesLength + wordVisibleLength;
		} else if (visibleLength > indentLength) {
			pushLine();
			currentLine = INDENT + word;
			visibleLength = indentLength + wordVisibleLength;
		} else if (wordVisibleLength <= width) {
			currentLine = INDENT + word;
			visibleLength = indentLength + wordVisibleLength;
		} else {
			const wordWidth = width - indentLength;
			for (let w = 0; w < word.length;) {
				let segment = "";
				let segmentVisible = 0;

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
	let spaces = "";
	while (i < text.length) {
		const char = text[i];

		if (char === "\n") {
			pushLine();
			atLineStart = true;
			lineIndent = "";
			spaces = "";
			i++;
		} else if (char === "\r") {
			i++;
		} else if (char === " " || char === "\t") {
			if (atLineStart) {
				lineIndent += char;
			} else if (char === " ") {
				spaces += " ";
			} else if (char === "\t") {
				addWord("    ", 4, "");
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

			addWord(word, wordVisibleLength, spaces);
			atLineStart = false;
			lineIndent = "";
			spaces = "";
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

// Write just the prompt glyph ("# ") without touching the animation loop or
// cursor visibility. Used while repainting the input region, where the spinner
// must keep running and the caller owns cursor show/hide.
export function writePromptMarker(): void {
	process.stdout.write(`${ansi.BOLD_MAGENTA}# ${ansi.RESET}`);
}

const ANIMATION_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇"];
let animationInterval: ReturnType<typeof setInterval> | null = null;
let requestStartTime: number | null = null;
let animationIndex = 0;

export function paintSpinnerLine(): void {
	const elapsed = requestStartTime ? Date.now() - requestStartTime : 0;
	const char = ANIMATION_CHARS[animationIndex];
	const width = process.stdout.columns || 80;
	const body = `${ansi.BOLD_MAGENTA}${char} ${ansi.RESET}${ansi.BRIGHT_BLACK}Running for ${formatDuration(elapsed)}${ansi.RESET}`;
	// Pad to full width so a shorter duration (e.g. "1s" -> "10s" doesn't
	// shrink, but going from "1m 1s" back is rare) or a stale longer line
	// above/below doesn't leave trailing glyphs.
	process.stdout.write(`\r${ansi.padToWidth(body, width)}`);
}

export function startAnimation(state: State, startTime?: number): void {
	if (animationInterval) return;

	requestStartTime = startTime || Date.now();
	animationIndex = 0;

	animationInterval = setInterval(() => {
		animationIndex = (animationIndex + 1) % ANIMATION_CHARS.length;
		render(state);
	}, 100);
}

export function stopAnimation(): void {
	if (animationInterval) {
		clearInterval(animationInterval);
		animationInterval = null;
		process.stdout.write(`\r${ansi.CLEAR_LINE}`);
	}
}

// Temporarily stop the spinner (e.g. while the user types an interjection)
// without resetting the elapsed-time origin.
export function pauseAnimation(): void {
	if (animationInterval) {
		clearInterval(animationInterval);
		animationInterval = null;
	}
	process.stdout.write(`\r${ansi.CLEAR_LINE}`);
}

// Restart the spinner, preserving the original start time if one is set.
export function resumeAnimation(state: State): void {
	if (animationInterval) return;
	startAnimation(state, requestStartTime ?? undefined);
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
