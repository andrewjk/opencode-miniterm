import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { processEvent, setRequestActive } from "../src/server";
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
