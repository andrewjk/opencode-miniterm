export interface Config {
	providerID: string;
	modelID: string;
}

const ENV_VAR = "OPENCODE_MT_CONFIG_CONTENT";

export const config: Config = {
	providerID: "opencode",
	modelID: "big-pickle",
};

export function loadConfig(): void {
	const content = process.env[ENV_VAR];
	if (content) {
		try {
			const parsed = JSON.parse(content) as Partial<Config>;
			Object.assign(config, parsed);
		} catch (e) {
			console.error("Failed to parse config from env var:", e);
		}
	}
}

export function saveConfig(): void {
	process.env[ENV_VAR] = JSON.stringify(config);
}
