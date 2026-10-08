import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUserTyping } from "../src/input";
import { stopAnimation } from "../src/render";
import {
	isRequestActive,
	markEventReceived,
	setRequestActive,
	startEventListener,
	startRequestTracking,
	stopEventListener,
	watchdogConfig,
	watchdogTick,
} from "../src/server";
import type { State } from "../src/types";

describe("event stream watchdog", () => {
	let writeSpy: ReturnType<typeof spyOn>;
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;
	let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
	const originalColumns = process.stdout.columns;
	let configSnapshot = { ...watchdogConfig };

	const createMockState = (client?: any): State => ({
		client,
		sessionID: "ses_1",
		renderedLines: [],
		accumulatedResponse: [],
		allEvents: [],
		write: () => {},
		lastFileAfter: new Map(),
		shutdown: () => {},
	});

	const hangingSubscribe = () => {
		let calls = 0;
		const subscribe = async (options: any) => {
			calls++;
			return {
				stream: (async function* () {
					while (!options.signal.aborted) {
						await new Promise((r) => setTimeout(r, 5));
					}
				})(),
			};
		};
		return {
			get calls() {
				return calls;
			},
			subscribe,
		};
	};

	const cleanEndingSubscribe = () => {
		let calls = 0;
		const subscribe = async () => {
			calls++;
			return { stream: (async function* () {})() };
		};
		return {
			get calls() {
				return calls;
			},
			subscribe,
		};
	};

	async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
		const start = Date.now();
		while (!condition()) {
			if (Date.now() - start > timeoutMs) {
				throw new Error("timed out waiting for condition");
			}
			await new Promise((r) => setTimeout(r, 5));
		}
	}

	function startSettledListener(state: State): Promise<{ listener: Promise<void> }> {
		const listener = startEventListener(state);
		return new Promise((resolve) => setTimeout(() => resolve({ listener }), 20));
	}

	beforeEach(() => {
		configSnapshot = { ...watchdogConfig };
		watchdogConfig.intervalMs = 60_000;
		watchdogConfig.resubscribeDelayMs = 5;
		writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response("{}", { status: 200 })) as any,
		);
		Object.defineProperty(process.stdout, "columns", {
			value: 80,
			configurable: true,
		});
		setRequestActive(false);
		setUserTyping(false);
	});

	afterEach(() => {
		stopEventListener();
		stopAnimation();
		Object.assign(watchdogConfig, configSnapshot);
		setRequestActive(false);
		writeSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
		fetchSpy.mockRestore();
		Object.defineProperty(process.stdout, "columns", {
			value: originalColumns,
			configurable: true,
		});
	});

	it("should resubscribe when the event stream ends cleanly", async () => {
		const sub = cleanEndingSubscribe();
		const state = createMockState({ event: { subscribe: sub.subscribe } });

		const listener = startEventListener(state);
		await waitFor(() => sub.calls >= 2);
		stopEventListener();
		await listener;

		expect(sub.calls).toBeGreaterThanOrEqual(2);
	});

	it("should not probe the health endpoint while events keep arriving", async () => {
		const sub = hangingSubscribe();
		const state = createMockState({ event: { subscribe: sub.subscribe } });

		await startSettledListener(state);
		markEventReceived();
		await watchdogTick(state);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("should force a reconnect when the health probe fails", async () => {
		const sub = hangingSubscribe();
		const state = createMockState({ event: { subscribe: sub.subscribe } });

		const { listener } = await startSettledListener(state);
		fetchSpy.mockImplementation((async () => {
			throw new Error("connection refused");
		}) as any);
		markEventReceived(Date.now() - watchdogConfig.idleStallTimeoutMs - 1);
		await watchdogTick(state);

		await waitFor(() => sub.calls >= 2);
		stopEventListener();
		await listener;

		expect(sub.calls).toBeGreaterThanOrEqual(2);
		const requestedUrl = String(fetchSpy.mock.calls[0]![0]);
		expect(requestedUrl).toContain("/global/health");
		const errorOutput = errorSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
		expect(errorOutput).toContain("reconnecting");
	});

	it("should tolerate one silent probe while busy and reconnect after a second", async () => {
		const sub = hangingSubscribe();
		const state = createMockState({
			event: { subscribe: sub.subscribe },
			session: {
				status: async () => ({ data: { ses_1: { type: "busy" } }, error: undefined }),
			},
		});

		const { listener } = await startSettledListener(state);
		setRequestActive(true);
		markEventReceived(Date.now() - watchdogConfig.stallTimeoutMs - 1);

		await watchdogTick(state);
		await new Promise((r) => setTimeout(r, 20));
		expect(sub.calls).toBe(1);

		await watchdogTick(state, Date.now() + watchdogConfig.stallTimeoutMs + 1);
		await waitFor(() => sub.calls >= 2);
		stopEventListener();
		await listener;

		expect(sub.calls).toBeGreaterThanOrEqual(2);
	});

	it("should finish the turn when the server reports idle during a stall", async () => {
		const sub = hangingSubscribe();
		const state = createMockState({
			event: { subscribe: sub.subscribe },
			session: {
				status: async () => ({ data: { ses_1: { type: "idle" } }, error: undefined }),
			},
		});

		const { listener } = await startSettledListener(state);
		startRequestTracking(state);
		expect(isRequestActive()).toBe(true);

		markEventReceived(Date.now() - watchdogConfig.stallTimeoutMs - 1);
		await watchdogTick(state);

		expect(isRequestActive()).toBe(false);
		const logOutput = logSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
		expect(logOutput).toContain("Completed in");

		await waitFor(() => sub.calls >= 2);
		stopEventListener();
		await listener;
	});

	it("should not finish the turn while the server is retrying a stalled stream", async () => {
		const sub = hangingSubscribe();
		const state = createMockState({
			event: { subscribe: sub.subscribe },
			session: {
				status: async () => ({
					data: { ses_1: { type: "retry", attempt: 1, message: "timed out", next: 0 } },
					error: undefined,
				}),
			},
		});

		const { listener } = await startSettledListener(state);
		startRequestTracking(state);
		expect(isRequestActive()).toBe(true);

		markEventReceived(Date.now() - watchdogConfig.stallTimeoutMs - 1);
		await watchdogTick(state);

		expect(isRequestActive()).toBe(true);

		stopEventListener();
		await listener;
	});

	it("should not finish the turn when the session status is unknown", async () => {
		const sub = hangingSubscribe();
		const state = createMockState({
			event: { subscribe: sub.subscribe },
			session: {
				status: async () => ({ data: {}, error: undefined }),
			},
		});

		const { listener } = await startSettledListener(state);
		startRequestTracking(state);
		expect(isRequestActive()).toBe(true);

		markEventReceived(Date.now() - watchdogConfig.stallTimeoutMs - 1);
		await watchdogTick(state);

		expect(isRequestActive()).toBe(true);

		stopEventListener();
		await listener;
	});
});
