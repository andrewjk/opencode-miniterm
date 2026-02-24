import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Key } from "node:readline";
import type { State } from "./index";

export interface Command {
	name: string;
	description: string;
	run: (client: OpencodeClient, state: State, input?: string) => Promise<void> | void;
	handleKey?: (client: OpencodeClient, key: Key, input?: string) => Promise<void> | void;
	running: boolean;
}
