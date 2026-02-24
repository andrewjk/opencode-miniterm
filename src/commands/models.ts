import type { OpencodeClient } from "@opencode-ai/sdk";
import readline, { type Key } from "node:readline";
import { config, saveConfig } from "../config";
import type { State } from "../index";
import { getActiveDisplay, writePrompt } from "../render";
import type { Command } from "../types";

let command: Command = {
	name: "/models",
	description: "List and select available models",
	run,
	handleKey,
	running: false,
};

export default command;

interface ModelInfo {
	providerID: string;
	providerName: string;
	modelID: string;
	modelName: string;
}

let modelList: ModelInfo[] = [];
let selectedModelIndex = 0;
let modelListLineCount = 0;
let modelSearchString = "";
let modelFilteredIndices: number[] = [];

async function run(client: OpencodeClient): Promise<void> {
	const result = await client.config.providers();

	if (result.error) {
		throw new Error(
			`Failed to fetch models (${result.response.status}): ${JSON.stringify(result.error)}`,
		);
	}

	const providers = result.data?.providers || [];

	modelList = [];
	for (const provider of providers) {
		const models = Object.values(provider.models || {});
		for (const model of models) {
			modelList.push({
				providerID: provider.id,
				providerName: provider.name,
				modelID: model.id,
				modelName: model.name || model.id,
			});
		}
	}

	modelList.sort(
		(a, b) =>
			a.providerName.localeCompare(b.providerName) || a.modelName.localeCompare(b.modelName),
	);

	modelSearchString = "";
	updateModelFilter();

	//modelSelectionMode = true;
	command.running = true;

	renderModelList();
}

async function handleKey(client: OpencodeClient, key: Key, str?: string) {
	switch (key.name) {
		case "up": {
			if (selectedModelIndex === 0) {
				selectedModelIndex = modelFilteredIndices.length - 1;
			} else {
				selectedModelIndex--;
			}
			renderModelList();
			return;
		}
		case "down": {
			if (selectedModelIndex === modelFilteredIndices.length - 1) {
				selectedModelIndex = 0;
			} else {
				selectedModelIndex++;
			}
			renderModelList();
			return;
		}
		case "escape": {
			clearModelList();
			process.stdout.write("\x1b[?25h");
			//modelSelectionMode = false;
			command.running = false;
			modelList = [];
			selectedModelIndex = 0;
			modelListLineCount = 0;
			modelSearchString = "";
			modelFilteredIndices = [];
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			writePrompt();
			return;
		}
		case "return": {
			modelListLineCount++;
			clearModelList();
			process.stdout.write("\x1b[?25h");
			const selectedIndex = modelFilteredIndices[selectedModelIndex];
			const selected = selectedIndex !== undefined ? modelList[selectedIndex] : undefined;
			//modelSelectionMode = false;
			command.running = false;
			modelList = [];
			selectedModelIndex = 0;
			modelListLineCount = 0;
			modelSearchString = "";
			modelFilteredIndices = [];
			readline.cursorTo(process.stdout, 0);
			readline.clearScreenDown(process.stdout);
			if (selected) {
				config.providerID = selected.providerID;
				config.modelID = selected.modelID;
				saveConfig();
				const activeDisplay = await getActiveDisplay(client);
				console.log(activeDisplay);
				console.log();
			}
			writePrompt();
			return;
		}
		case "backspace": {
			modelSearchString = modelSearchString.slice(0, -1);
			updateModelFilter();
			selectedModelIndex = 0;
			renderModelList();
			return;
		}
	}

	if (str && str.length === 1) {
		modelSearchString += str;
		updateModelFilter();
		selectedModelIndex = 0;
		renderModelList();
		return;
	}
}

function clearModelList() {
	process.stdout.write("\x1b[?25l");
	if (modelListLineCount > 0) {
		process.stdout.write(`\x1b[${modelListLineCount}A`);
	}
	readline.cursorTo(process.stdout, 0);
	readline.clearScreenDown(process.stdout);
}

function renderModelList(): void {
	clearModelList();

	const grouped = new Map<string, { models: typeof modelList; startIndices: number[] }>();
	let currentIndex = 0;
	for (const model of modelList) {
		const existing = grouped.get(model.providerName);
		if (existing) {
			existing.models.push(model);
			existing.startIndices.push(currentIndex);
		} else {
			grouped.set(model.providerName, { models: [model], startIndices: [currentIndex] });
		}
		currentIndex++;
	}

	modelListLineCount = 0;
	if (modelSearchString) {
		console.log(`  \x1b[90mFilter: \x1b[0m\x1b[33m${modelSearchString}\x1b[0m`);
		modelListLineCount++;
	}

	for (const [providerName, data] of grouped) {
		const filteredModelsWithIndices = data.models
			.map((model, i) => ({ model, globalIndex: data.startIndices[i]! }))
			.filter(({ globalIndex }) => modelFilteredIndices.includes(globalIndex));

		if (filteredModelsWithIndices.length === 0) continue;

		console.log(`  \x1b[36;1m${providerName}\x1b[0m`);
		modelListLineCount++;

		for (let i = 0; i < filteredModelsWithIndices.length; i++) {
			const { model, globalIndex } = filteredModelsWithIndices[i]!;
			const filteredIndex = modelFilteredIndices.indexOf(globalIndex);
			const isSelected = filteredIndex === selectedModelIndex;
			const isActive = model.providerID === config.providerID && model.modelID === config.modelID;
			const prefix = isSelected ? "  >" : "   -";
			const name = isSelected ? `\x1b[33;1m${model.modelName}\x1b[0m` : model.modelName;
			const status = isActive ? " (active)" : "";

			console.log(`${prefix} ${name}${status}`);
			modelListLineCount++;
		}
	}
}

function updateModelFilter(): void {
	if (!modelSearchString) {
		modelFilteredIndices = modelList.map((_, i) => i);
	} else {
		const search = modelSearchString.toLowerCase();
		modelFilteredIndices = modelList
			.map((model, i) => ({ model, index: i }))
			.filter(({ model }) => model.modelName.toLowerCase().includes(search))
			.map(({ index }) => index);
	}
	if (modelFilteredIndices.length > 0) {
		selectedModelIndex = modelFilteredIndices.indexOf(
			modelList.findIndex(
				(m) => m.providerID === config.providerID && m.modelID === config.modelID,
			),
		);
		if (selectedModelIndex === -1) selectedModelIndex = 0;
	}
}
