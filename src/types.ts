import type { OpenCodeEvent } from "@opencode/client";
import type { Key } from "node:readline";
import type { OpenCodeClient } from "./opencode";

export interface Command {
	name: string;
	description: string;
	run: (state: State, input?: string) => Promise<void> | void;
	handleKey?: (state: State, key: Key, input?: string) => Promise<void> | void;
	running: boolean;
}

export interface State {
	client: OpenCodeClient;
	sessionID: string;
	renderedLines: string[];
	accumulatedResponse: AccumulatedPart[];
	allEvents: OpenCodeEvent[];
	lastFileAfter: Map<string, string>;
	write: (text: string) => void;
	shutdown: () => void;
}

interface AccumulatedPart {
	key: string;
	title: "thinking" | "response" | "tool" | "files" | "todo" | "user" | "subtask";
	text: string;
	active?: boolean;
	durationMs?: number;
}
