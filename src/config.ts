import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Config {
	providerID: string;
	modelID: string;
}

const ENV_VAR = "OPENCODE_MT_CONFIG_CONTENT";

export const config: Config = {
	providerID: "opencode",
	modelID: "big-pickle",
};

const CONFIG_PATH = `${process.env.HOME}/.config/opencode-miniterm/opencode-miniterm.json`;

export function loadConfig(): void {
	const content = process.env[ENV_VAR];
	if (content) {
		try {
			const parsed = JSON.parse(content) as Partial<Config>;
			Object.assign(config, parsed);
		} catch (e) {
			console.error("Failed to parse config from env var:", e);
		}
	} else {
		if (existsSync(CONFIG_PATH)) {
			try {
				const fileContent = readFileSync(CONFIG_PATH, "utf-8");
				const parsed = JSON.parse(fileContent) as Partial<Config>;
				Object.assign(config, parsed);
			} catch (e) {
				console.error("Failed to parse config from file:", e);
			}
		}
	}
}

export function saveConfig(): void {
	process.env[ENV_VAR] = JSON.stringify(config);
	const configDir = dirname(CONFIG_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
	} catch (e) {
		console.error("Failed to save config to file:", e);
	}
}
