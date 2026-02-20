export interface ServerEvent {
	type: EventType;
	properties: EventProperties;
}

export interface Part {
	id: string;
	sessionID: string;
	messageID: string;
	type: PartType;
	text?: string;
	reasoning?: string;
	delta?: string;
	time?: {
		start: number;
		end?: number;
	};
	snapshot?: string;
	reason?: string;
	cost?: number;
	tokens?: Tokens;
	metadata?: {
		anthropic?: {
			signature: string;
		};
	};
	name?: string;
}

export interface Tokens {
	total: number;
	input: number;
	output: number;
	reasoning: number;
	cache: {
		read: number;
		write: number;
	};
}

export interface MessageInfo {
	id: string;
	sessionID: string;
	role: "user" | "assistant";
	time: {
		created: number;
		completed?: number;
	};
	agent?: string;
	model?: {
		providerID: string;
		modelID: string;
	};
	parentID?: string;
	mode?: string;
	path?: {
		cwd: string;
		root: string;
	};
	cost?: number;
	tokens?: Tokens;
	finish?: string;
	summary?: {
		title?: string;
		diffs?: any[];
	};
}

export interface SessionInfo {
	id: string;
	slug?: string;
	version: string;
	projectID: string;
	directory: string;
	title?: string;
	time: {
		created: number;
		updated: number;
	};
	summary?: {
		additions: number;
		deletions: number;
		files: number;
	};
}

export interface SessionStatus {
	type: "busy" | "idle";
}

export interface EventProperties {
	part?: Part;
	delta?: string;
	info?: MessageInfo | SessionInfo;
	sessionID?: string;
	status?: SessionStatus;
	diff?: DiffInfo[];
}

export interface DiffInfo {
	file: string;
	before: string;
	after: string;
	additions: number;
	deletions: number;
	status: string;
}

export type EventType =
	| "message.part.updated"
	| "message.updated"
	| "session.updated"
	| "session.status"
	| "session.diff"
	| "session.idle";

export type PartType =
	| "step-start"
	| "reasoning"
	| "text"
	| "step-finish"
	| "tool_use"
	| "tool_result";
