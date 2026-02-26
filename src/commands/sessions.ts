import type { OpencodeClient, Session } from "@opencode-ai/sdk";
import readline, { type Key } from "node:readline";
import { config, saveConfig } from "../config";
import type { State } from "../index";
import { updateSessionTitle } from "../index";
import { writePrompt } from "../render";
import type { Command } from "../types";

let command: Command = {
	name: "/sessions",
	description: "List and select sessions",
	run,
	handleKey,
	running: false,
};

export default command;

interface SessionInfo {
	id: string;
	title?: string;
	createdAt: number;
	updatedAt: number;
}

let sessionList: SessionInfo[] = [];
let selectedSessionIndex = 0;
let sessionListLineCount = 0;
let sessionListOffset = 0;
let sessionSearchString = "";
let sessionFilteredIndices: number[] = [];

async function run(client: OpencodeClient, state: State): Promise<void> {
	const result = await client.session.list();

	if (result.error) {
		throw new Error(
			`Failed to fetch sessions (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	const sessions = (result.data as Session[]) || [];

	if (sessions.length === 0) {
		console.log("No sessions found. Creating a new session...");
		state.sessionID = await createSession(client);
		config.sessionIDs[process.cwd()] = state.sessionID;
		saveConfig();
		console.log(`Created new session: ${state.sessionID}...\n`);
		await updateSessionTitle();
		return;
	}

	sessionList = sessions.map((session) => ({
		id: session.id,
		title: session.title,
		createdAt: session.time?.created || Date.now(),
		updatedAt: session.time?.updated || Date.now(),
	}));

	sessionList.sort((a, b) => b.updatedAt - a.updatedAt);

	sessionSearchString = "";
	updateSessionFilter();

	sessionListOffset = Math.floor(selectedSessionIndex / 10) * 10;
	if (sessionListOffset < 0) sessionListOffset = 0;

	command.running = true;

	renderSessionList();
}

async function handleKey(_client: OpencodeClient, key: Key, str?: string) {
	switch (key.name) {
		case "up": {
			if (selectedSessionIndex === 0) {
				selectedSessionIndex = sessionFilteredIndices.length - 1;
			} else {
				selectedSessionIndex--;
			}
			const currentIndex = sessionFilteredIndices[selectedSessionIndex];
			if (currentIndex !== undefined && currentIndex < sessionListOffset && sessionListOffset > 0) {
				sessionListOffset -= 10;
				if (sessionListOffset < 0) sessionListOffset = 0;
			}
			renderSessionList();
			return;
		}
		case "down": {
			if (selectedSessionIndex === sessionFilteredIndices.length - 1) {
				selectedSessionIndex = 0;
			} else {
				selectedSessionIndex++;
			}
			const currentIndex = sessionFilteredIndices[selectedSessionIndex];
			if (
				currentIndex !== undefined &&
				currentIndex >= sessionListOffset + 10 &&
				sessionListOffset + 10 < sessionList.length
			) {
				sessionListOffset += 10;
			}
			renderSessionList();
			return;
		}
		case "escape": {
			clearSessionList();
			process.stdout.write("\x1b[?25h");
			command.running = false;
			sessionList = [];
			selectedSessionIndex = 0;
			sessionListOffset = 0;
			sessionListLineCount = 0;
			sessionSearchString = "";
			sessionFilteredIndices = [];
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			writePrompt();
			return;
		}
		case "return": {
			sessionListLineCount++;
			clearSessionList();
			process.stdout.write("\x1b[?25h");
			const selectedIndex = sessionFilteredIndices[selectedSessionIndex];
			const selected = selectedIndex !== undefined ? sessionList[selectedIndex] : undefined;
			command.running = false;
			sessionList = [];
			selectedSessionIndex = 0;
			sessionListOffset = 0;
			sessionListLineCount = 0;
			sessionSearchString = "";
			sessionFilteredIndices = [];
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			if (selected) {
				config.sessionIDs[process.cwd()] = selected.id;
				saveConfig();
				console.log(`Switched to session: ${selected.id.substring(0, 8)}...`);
				if (selected.title) {
					console.log(`  Title: ${selected.title}`);
				}
				console.log();
				await updateSessionTitle();
			}
			writePrompt();
			return;
		}
		case "backspace": {
			sessionSearchString = sessionSearchString.slice(0, -1);
			updateSessionFilter();
			selectedSessionIndex = 0;
			renderSessionList();
			return;
		}
	}

	if (str && str.length === 1) {
		sessionSearchString += str;
		updateSessionFilter();
		selectedSessionIndex = 0;
		renderSessionList();
		return;
	}
}

async function createSession(client: OpencodeClient): Promise<string> {
	const result = await client.session.create({
		body: {},
	});

	if (result.error) {
		throw new Error(
			`Failed to create session (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	return result.data.id;
}

function clearSessionList() {
	process.stdout.write("\x1b[?25l");
	if (sessionListLineCount > 0) {
		process.stdout.write(`\x1b[${sessionListLineCount}A`);
	}
	readline.cursorTo(process.stdout, 0);
	readline.clearScreenDown(process.stdout);
}

function renderSessionList(): void {
	clearSessionList();

	sessionListLineCount = 0;
	console.log("  \x1b[36;1mAvailable Sessions\x1b[0m");
	sessionListLineCount++;

	if (sessionSearchString) {
		console.log(`  \x1b[90mFilter: \x1b[0m\x1b[33m${sessionSearchString}\x1b[0m`);
		sessionListLineCount++;
	}

	const filteredSessions = sessionList.filter((_, i) => sessionFilteredIndices.includes(i));
	const recentSessions = filteredSessions.slice(sessionListOffset, sessionListOffset + 10);
	const groupedByDate = recentSessions.reduce(
		(acc, session) => {
			const date = new Date(session.updatedAt).toLocaleDateString();
			if (!acc[date]) {
				acc[date] = [];
			}
			acc[date].push(session);
			return acc;
		},
		{} as Record<string, typeof recentSessions>,
	);

	for (const [date, sessions] of Object.entries(groupedByDate)) {
		console.log(`  \x1b[90m${date}\x1b[0m`);
		sessionListLineCount++;

		for (const session of sessions) {
			const globalIndex = sessionList.indexOf(session);
			const filteredIndex = sessionFilteredIndices.indexOf(globalIndex);
			const isSelected = filteredIndex === selectedSessionIndex;
			const isActive = session.id === config.sessionIDs[process.cwd()];
			const prefix = isSelected ? "  >" : "   -";
			const title = session.title || "(no title)";
			const name = isSelected ? `\x1b[33;1m${title}\x1b[0m` : title;
			const status = isActive ? " (active)" : "";

			console.log(`${prefix} ${name}${status}`);
			sessionListLineCount++;
		}
	}
}

function updateSessionFilter(): void {
	if (!sessionSearchString) {
		sessionFilteredIndices = sessionList.map((_, i) => i);
	} else {
		const search = sessionSearchString.toLowerCase();
		sessionFilteredIndices = sessionList
			.map((session, i) => ({ session, index: i }))
			.filter(
				({ session }) =>
					session.title?.toLowerCase().includes(search) ||
					session.id.toLowerCase().includes(search),
			)
			.map(({ index }) => index);
	}
	if (sessionFilteredIndices.length > 0) {
		selectedSessionIndex = sessionFilteredIndices.indexOf(
			sessionList.findIndex((s) => s.id === config.sessionIDs[process.cwd()]),
		);
		if (selectedSessionIndex === -1) selectedSessionIndex = 0;
	}
}
