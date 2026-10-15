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

	it("should show the execution error message at the end of the turn", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.execution.failed",
			data: {
				sessionID: "ses_1",
				error: { type: "APIError", message: "boom", status: 403 },
			},
		} as any);

		await processEvent(state, {
			type: "session.idle",
			data: { sessionID: "ses_1" },
		} as any);

		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).toContain("Error:");
		expect(logOutput).toContain("boom");
		expect(logOutput).not.toContain("Completed in");
	});

	it("should show the error from a failed step", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.step.failed",
			data: {
				sessionID: "ses_1",
				error: { type: "APIError", message: "model not available" },
			},
		} as any);

		await processEvent(state, {
			type: "session.idle",
			data: { sessionID: "ses_1" },
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
			data: { sessionID: "ses_1" },
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
			data: { sessionID: "ses_1", status: { type: "busy" } },
		} as any);

		expect(isRequestActive()).toBe(true);
	});

	it("should not start tracking on a busy status for a different session", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.status",
			data: { sessionID: "ses_other", status: { type: "busy" } },
		} as any);

		expect(isRequestActive()).toBe(false);
	});

	it("should stream parts and complete with the banner for an external request", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.status",
			data: { sessionID: "ses_1", status: { type: "busy" } },
		} as any);

		await processEvent(state, {
			type: "session.text.started",
			data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
		} as any);

		await processEvent(state, {
			type: "session.text.delta",
			data: {
				sessionID: "ses_1",
				assistantMessageID: "msg_1",
				ordinal: 0,
				delta: "hello from another client",
			},
		} as any);

		expect(state.accumulatedResponse.some((p) => p.key === "text:msg_1:0")).toBe(true);

		await processEvent(state, {
			type: "session.idle",
			data: { sessionID: "ses_1" },
		} as any);

		expect(isRequestActive()).toBe(false);
		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).toContain("Completed in");
	});

	it("should show the bash command in the tool part", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.tool.input.started",
			data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
		} as any);

		await processEvent(state, {
			type: "session.tool.called",
			data: {
				sessionID: "ses_1",
				assistantMessageID: "msg_1",
				id: "call_1",
				input: { command: "git status && git log --oneline -10" },
				executed: true,
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "tool:call_1");
		expect(part?.title).toBe("tool");
		expect(part?.text).toContain("$ bash:");
		expect(part?.text).toContain("git status && git log --oneline -10");
	});

	it("should cut a multi-line bash command to its first line with an ellipsis", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.tool.input.started",
			data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
		} as any);

		await processEvent(state, {
			type: "session.tool.called",
			data: {
				sessionID: "ses_1",
				assistantMessageID: "msg_1",
				id: "call_1",
				input: { command: "ls\ncd foo\necho hi" },
				executed: true,
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "tool:call_1");
		expect(part?.text).toContain("$ bash:");
		expect(part?.text).toContain("ls…");
		expect(part?.text).not.toContain("cd foo");
	});

	it("should truncate a long single-line bash command to terminal width - 3 - indent - prefix", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.tool.input.started",
			data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
		} as any);

		await processEvent(state, {
			type: "session.tool.called",
			data: {
				sessionID: "ses_1",
				assistantMessageID: "msg_1",
				id: "call_1",
				input: { command: "a".repeat(100) },
				executed: true,
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "tool:call_1");
		expect(part?.text).toContain(`${"a".repeat(67)}…`);
	});

	it("should not truncate non-bash tool inputs", async () => {
		const state = createMockState();

		await processEvent(state, {
			type: "session.tool.input.started",
			data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "read" },
		} as any);

		await processEvent(state, {
			type: "session.tool.called",
			data: {
				sessionID: "ses_1",
				assistantMessageID: "msg_1",
				id: "call_1",
				input: { filePath: "line one\nline two\nline three" },
				executed: true,
			},
		} as any);

		const part = state.accumulatedResponse.find((p) => p.key === "tool:call_1");
		expect(part?.text).toContain("line one\nline two\nline three");
		expect(part?.text).not.toContain("…");
	});

	it("should start tracking when switching to a session that is already busy", async () => {
		const state = createMockState({
			session: {
				active: async () => ({ ses_1: { type: "running" } }),
			},
		});

		await startTrackingIfSessionBusy(state);

		expect(isRequestActive()).toBe(true);
	});

	it("should not start tracking when switching to an idle session", async () => {
		const state = createMockState({
			session: {
				active: async () => ({}),
			},
		});

		await startTrackingIfSessionBusy(state);

		expect(isRequestActive()).toBe(false);
	});

	it("should keep only a rolling window of raw events", async () => {
		const state = createMockState();

		for (let i = 0; i < 600; i++) {
			await processEvent(state, {
				type: "server.heartbeat",
				data: { n: i },
			} as any);
		}

		expect(state.allEvents.length).toBe(500);
		expect((state.allEvents[0] as any).data.n).toBe(100);
		expect((state.allEvents[state.allEvents.length - 1] as any).data.n).toBe(599);
	});
});
