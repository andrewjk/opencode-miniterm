import type { Agent, OpencodeClient } from "@opencode-ai/sdk";
import readline, { type Key } from "node:readline";
import { config, saveConfig } from "../config";
import type { State } from "../index";
import { getActiveDisplay, writePrompt } from "../render";
import type { Command } from "../types";

interface AgentInfo {
	id: string;
	name: string;
}

let agentSelectionMode = false;
let agentList: AgentInfo[] = [];
let selectedAgentIndex = 0;
let agentListLineCount = 0;
let agentSearchString = "";
let agentFilteredIndices: number[] = [];

let command: Command = {
	name: "/agents",
	description: "List and select available agents",
	run,
	handleKey,
	running: false,
};

export default command;

async function run(client: OpencodeClient): Promise<void> {
	const result = await client.app.agents();

	if (result.error) {
		throw new Error(
			`Failed to fetch agents (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	agentList = (result.data || []).map((agent: Agent) => ({
		id: agent.name,
		name: agent.name,
	}));

	agentSearchString = "";
	updateAgentFilter();

	agentSelectionMode = true;

	renderAgentList();
}

async function handleKey(client: OpencodeClient, key: Key, str?: string) {
	switch (key.name) {
		case "up": {
			if (selectedAgentIndex === 0) {
				selectedAgentIndex = agentFilteredIndices.length - 1;
			} else {
				selectedAgentIndex--;
			}
			renderAgentList();
			return;
		}
		case "down": {
			if (selectedAgentIndex === agentFilteredIndices.length - 1) {
				selectedAgentIndex = 0;
			} else {
				selectedAgentIndex++;
			}
			renderAgentList();
			return;
		}
		case "escape": {
			clearAgentList();
			process.stdout.write("\x1b[?25h");
			agentSelectionMode = false;
			agentList = [];
			selectedAgentIndex = 0;
			agentListLineCount = 0;
			agentSearchString = "";
			agentFilteredIndices = [];
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			writePrompt();
			return;
		}
		case "return": {
			agentListLineCount++;
			clearAgentList();
			process.stdout.write("\x1b[?25h");
			const selectedIndex = agentFilteredIndices[selectedAgentIndex];
			const selected = selectedIndex !== undefined ? agentList[selectedIndex] : undefined;
			agentSelectionMode = false;
			agentList = [];
			selectedAgentIndex = 0;
			agentListLineCount = 0;
			agentSearchString = "";
			agentFilteredIndices = [];
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			if (selected) {
				config.agentID = selected.id;
				saveConfig();
				const activeDisplay = await getActiveDisplay(client);
				console.log(activeDisplay);
				console.log();
			}
			writePrompt();
			return;
		}
		case "backspace": {
			agentSearchString = agentSearchString.slice(0, -1);
			updateAgentFilter();
			selectedAgentIndex = 0;
			renderAgentList();
			return;
		}
	}

	if (str && str.length === 1) {
		agentSearchString += str;
		updateAgentFilter();
		selectedAgentIndex = 0;
		renderAgentList();
		return;
	}
}

function clearAgentList() {
	process.stdout.write("\x1b[?25l");
	if (agentListLineCount > 0) {
		process.stdout.write(`\x1b[${agentListLineCount}A`);
	}
	readline.cursorTo(process.stdout, 0);
	readline.clearScreenDown(process.stdout);
}

function renderAgentList(): void {
	clearAgentList();

	agentListLineCount = 0;
	console.log("  \x1b[36;1mAvailable Agents\x1b[0m");
	agentListLineCount++;

	if (agentSearchString) {
		console.log(`  \x1b[90mFilter: \x1b[0m\x1b[33m${agentSearchString}\x1b[0m`);
		agentListLineCount++;
	}

	for (let i = 0; i < agentFilteredIndices.length; i++) {
		const globalIndex = agentFilteredIndices[i]!;
		const agent = agentList[globalIndex];
		if (!agent) continue;
		const isSelected = i === selectedAgentIndex;
		const isActive = agent.id === config.agentID;
		const prefix = isSelected ? "  >" : "   -";
		const name = isSelected ? `\x1b[33;1m${agent.name}\x1b[0m` : agent.name;
		const status = isActive ? " (active)" : "";

		console.log(`${prefix} ${name}${status}`);
		agentListLineCount++;
	}
}

function updateAgentFilter(): void {
	if (!agentSearchString) {
		agentFilteredIndices = agentList.map((_, i) => i);
	} else {
		const search = agentSearchString.toLowerCase();
		agentFilteredIndices = agentList
			.map((agent, i) => ({ agent, index: i }))
			.filter(({ agent }) => agent.name.toLowerCase().includes(search))
			.map(({ index }) => index);
	}
	if (agentFilteredIndices.length > 0) {
		selectedAgentIndex = agentFilteredIndices.indexOf(
			agentList.findIndex((a) => a.id === config.agentID),
		);
		if (selectedAgentIndex === -1) selectedAgentIndex = 0;
	}
}
