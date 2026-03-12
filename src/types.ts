import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import type { Key } from "node:readline";

export interface Command {
	name: string;
	description: string;
	run: (state: State, input?: string) => Promise<void> | void;
	handleKey?: (state: State, key: Key, input?: string) => Promise<void> | void;
	running: boolean;
}

export interface State {
	client: ReturnType<typeof createOpencodeClient>;
	sessionID: string;
	renderedLines: string[];
	accumulatedResponse: AccumulatedPart[];
	allEvents: Event[];
	lastFileAfter: Map<string, string>;
	write: (text: string) => void;
	shutdown: () => void;
}

interface AccumulatedPart {
	key: string;
	title: "thinking" | "response" | "tool" | "files" | "todo";
	text: string;
	active?: boolean;
	durationMs?: number;
}
