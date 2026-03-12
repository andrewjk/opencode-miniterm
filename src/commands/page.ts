import type { Key } from "node:readline";
import * as ansi from "../ansi";
import { wrapText } from "../render";
import type { Command, State } from "../types";

let currentPageIndex = 0;
let pages: string[] = [];

let command: Command = {
	name: "/page",
	description: "Show detailed output page by page",
	run,
	handleKey,
	running: false,
};

export default command;

function run(state: State): void {
	pages = [];

	for (const part of state.accumulatedResponse) {
		if (!part || !part.text.trim()) continue;

		if (part.title === "thinking") {
			pages.push(`💭 ${ansi.BRIGHT_BLACK}${part.text.trimStart()}${ansi.RESET}`);
		} else if (part.title === "response") {
			pages.push(`💭 ${part.text.trimStart()}`);
		} else {
			pages.push(part.text);
		}
	}

	if (pages.length === 0) {
		console.log(`${ansi.BRIGHT_BLACK}No parts to display yet.${ansi.RESET}\n`);
		return;
	}

	currentPageIndex = 0;
	command.running = true;

	displayPage();
}

function handleKey(state: State, key: Key, _input?: string): void {
	if (key.name === "space") {
		currentPageIndex++;
		if (currentPageIndex >= pages.length) {
			command.running = false;
			process.stdout.write("\x1b[?25h");
			process.stdout.write("\x1b[2K\r\n");
		} else {
			displayPage();
		}
	} else if (key.name === "escape") {
		command.running = false;
		process.stdout.write("\x1b[?25h");
		console.log("\n\x1b[90mCancelled\x1b[0m\n");
	}
}

function displayPage(): void {
	let page = pages[currentPageIndex]!;
	if (process.stdout.columns) {
		page = wrapText(page, process.stdout.columns).join("\n");
	}
	const footer = `\n\n\x1b[90m--- Part ${currentPageIndex + 1} of ${pages.length}; press SPACE to advance or ESC to cancel ---\x1b[0m`;

	if (currentPageIndex > 0) {
		process.stdout.write("\x1b[2K\r");
		process.stdout.write(page + footer);
	} else {
		process.stdout.write(page + footer);
	}
}
