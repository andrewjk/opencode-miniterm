import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { stopAnimation } from "../src/render";
import {
	isRequestActive,
	processEvent,
	setRequestActive,
	startTrackingIfSessionBusy,
} from "../src/server";
import type { State } from "../src/types";

describe("processEvent error handling", () => {
	let writeSpy: ReturnType<typeof spyOn>;
	let logSpy: ReturnType<typeof spyOn>;
	const originalColumns = process.stdout.columns;

	const createMockState = (): State => ({
		// @ts-ignore this doesn't get used in the error path
		client: null,
		sessionID: "ses_1",
		renderedLines: [],
		accumulatedResponse: [],
		allEvents: [],
		write: () => {},
		lastFileAfter: new Map(),
		shutdown: () => {},
	});

	beforeEach(() => {
		writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		Object.defineProperty(process.stdout, "columns", {
			value: 80,
			configurable: true,
		});
		setRequestActive(true);
	});

	afterEach(() => {
		setRequestActive(false);
		writeSpy.mockRestore();
		logSpy.mockRestore();
		Object.defineProperty(process.stdout, "columns", {
			value: originalColumns,
			configurable: true,
		});
	});

	it("should show the session.error message at the end of the turn", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: {
					name: "APIError",
					data: { message: "boom", statusCode: 403, isRetryable: false },
				},
			},
		} as any);

		await processEvent(state, {
			type: "session.idle",
			properties: { sessionID: "ses_1" },
		} as any);

		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).toContain("Error:");
		expect(logOutput).toContain("boom");
		expect(logOutput).not.toContain("Completed in");
	});

	it("should show the error field on the assistant message", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "message.updated",
			properties: {
				sessionID: "ses_1",
				info: {
					id: "msg_1",
					role: "assistant",
					sessionID: "ses_1",
					parentID: "msg_0",
					modelID: "deepseek-v4-flash",
					providerID: "opencode-go",
					mode: "build",
					path: { cwd: "/tmp", root: "/tmp" },
					cost: 0,
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
					time: { created: 0 },
					error: {
						name: "APIError",
						data: { message: "model not available", isRetryable: false },
					},
				},
			},
		} as any);

		await processEvent(state, {
			type: "session.idle",
			properties: { sessionID: "ses_1" },
		} as any);

		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).toContain("Error:");
		expect(logOutput).toContain("model not available");
		expect(logOutput).not.toContain("Completed in");
	});

	it("should not show an error banner when the turn ended cleanly", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.idle",
			properties: { sessionID: "ses_1" },
		} as any);

		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).not.toContain("Error:");
	});
});

describe("following an externally-started request", () => {
	let writeSpy: ReturnType<typeof spyOn>;
	let logSpy: ReturnType<typeof spyOn>;
	const originalColumns = process.stdout.columns;

	const createMockState = (client?: any): State => ({
		// @ts-ignore this doesn't get used in the request path
		client,
		sessionID: "ses_1",
		renderedLines: [],
		accumulatedResponse: [],
		allEvents: [],
		write: () => {},
		lastFileAfter: new Map(),
		shutdown: () => {},
	});

	beforeEach(() => {
		writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		Object.defineProperty(process.stdout, "columns", {
			value: 80,
			configurable: true,
		});
		setRequestActive(false);
	});

	afterEach(() => {
		stopAnimation();
		setRequestActive(false);
		writeSpy.mockRestore();
		logSpy.mockRestore();
		Object.defineProperty(process.stdout, "columns", {
			value: originalColumns,
			configurable: true,
		});
	});

	it("should start tracking when a busy status arrives for the active session", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.status",
			properties: { sessionID: "ses_1", status: { type: "busy" } },
		} as any);

		expect(isRequestActive()).toBe(true);
	});

	it("should not start tracking on a busy status for a different session", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.status",
			properties: { sessionID: "ses_other", status: { type: "busy" } },
		} as any);

		expect(isRequestActive()).toBe(false);
	});

	it("should stream parts and complete with the banner for an external request", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.status",
			properties: { sessionID: "ses_1", status: { type: "busy" } },
		} as any);

		await processEvent(state, {
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "prt_1",
					type: "text",
					text: "hello from another client",
					messageID: "msg_1",
					sessionID: "ses_1",
				},
			},
		} as any);

		expect(state.accumulatedResponse.some((p) => p.key === "prt_1")).toBe(true);

		await processEvent(state, {
			type: "session.idle",
			properties: { sessionID: "ses_1" },
		} as any);

		expect(isRequestActive()).toBe(false);
		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).toContain("Completed in");
	});

	it("should show the bash command in the tool part", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "prt_1",
					messageID: "msg_1",
					sessionID: "ses_1",
					type: "tool",
					tool: "bash",
					callID: "call_1",
					state: {
						status: "running",
						input: { command: "git status && git log --oneline -10" },
						time: { start: 0 },
					},
				},
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "prt_1");
		expect(part?.title).toBe("tool");
		expect(part?.text).toContain("$ bash:");
		expect(part?.text).toContain("git status && git log --oneline -10");
	});

	it("should cut a multi-line bash command to its first line with an ellipsis", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "prt_1",
					messageID: "msg_1",
					sessionID: "ses_1",
					type: "tool",
					tool: "bash",
					callID: "call_1",
					state: {
						status: "running",
						input: { command: "ls\ncd foo\necho hi" },
						time: { start: 0 },
					},
				},
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "prt_1");
		expect(part?.text).toContain("$ bash:");
		expect(part?.text).toContain("ls…");
		expect(part?.text).not.toContain("cd foo");
	});

	it("should truncate a long single-line bash command to terminal width - 3 - indent - prefix", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "prt_1",
					messageID: "msg_1",
					sessionID: "ses_1",
					type: "tool",
					tool: "bash",
					callID: "call_1",
					state: {
						status: "running",
						input: { command: "a".repeat(100) },
						time: { start: 0 },
					},
				},
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "prt_1");
		expect(part?.text).toContain(`${"a".repeat(67)}…`);
	});

	it("should not truncate non-bash tool inputs", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "prt_1",
					messageID: "msg_1",
					sessionID: "ses_1",
					type: "tool",
					tool: "read",
					callID: "call_1",
					state: {
						status: "running",
						input: { filePath: "line one\nline two\nline three" },
						time: { start: 0 },
					},
				},
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "prt_1");
		expect(part?.text).toContain("line one\nline two\nline three");
		expect(part?.text).not.toContain("…");
	});

	it("should start tracking when switching to a session that is already busy", async () => {
		const state = createMockState({
			session: {
				status: async () => ({ data: { ses_1: { type: "busy" } } }),
			},
		});

		await startTrackingIfSessionBusy(state);

		expect(isRequestActive()).toBe(true);
	});

	it("should not start tracking when switching to an idle session", async () => {
		const state = createMockState({
			session: {
				status: async () => ({ data: { ses_1: { type: "idle" } } }),
			},
		});

		await startTrackingIfSessionBusy(state);

		expect(isRequestActive()).toBe(false);
	});
});
