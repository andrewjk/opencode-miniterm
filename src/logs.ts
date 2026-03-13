import { mkdir } from "node:fs/promises";
import { open } from "node:fs/promises";
import { config } from "./config";

let logFile: Awaited<ReturnType<typeof open>> | null = null;
let logFilePath: string | null = null;

export function isLoggingEnabled(): boolean {
	return config.loggingEnabled;
}

export function getLogDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	return `${homeDir}/.local/share/opencode-miniterm/log`;
}

export async function createLogFile(): Promise<void> {
	if (!isLoggingEnabled()) {
		return;
	}

	const logDir = getLogDir();
	await mkdir(logDir, { recursive: true });

	const now = new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filename = `${timestamp}.txt`;
	logFilePath = `${logDir}/${filename}`;

	try {
		logFile = await open(logFilePath, "w");
	} catch (error) {
		console.error("Failed to create log file:", error);
		logFile = null;
		logFilePath = null;
	}
}

export async function closeLogFile(): Promise<void> {
	if (logFile) {
		try {
			await logFile.close();
		} catch (error) {
			console.error("Failed to close log file:", error);
		}
		logFile = null;
		logFilePath = null;
	}
}

export async function writeToLog(text: string): Promise<void> {
	if (logFile && isLoggingEnabled()) {
		try {
			await logFile.write(text);
		} catch (error) {
			console.error("Failed to write to log file:", error);
		}
	}
}
