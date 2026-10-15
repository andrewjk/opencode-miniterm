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
	const originalColumns = process.stdout.columns;
	let configSnapshot = { ...watchdogConfig };

	interface MockClientOptions {
		subscribe: (options: any) => AsyncIterable<any>;
		active?: () => Promise<any>;
		info?: () => Promise<any>;
	}

	const makeClient = (options: MockClientOptions) => ({
		event: { subscribe: options.subscribe },
		session: { active: options.active ?? (async () => ({})) },
		server: { info: options.info ?? (async () => ({})) },
	});

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
		const subscribe = (options: any) => {
			calls++;
			return (async function* () {
				while (!options.signal.aborted) {
					await new Promise((r) => setTimeout(r, 5));
				}
			})();
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
		const subscribe = () => {
			calls++;
			return (async function* () {})();
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
		Object.defineProperty(process.stdout, "columns", {
			value: originalColumns,
			configurable: true,
		});
	});

	it("should resubscribe when the event stream ends cleanly", async () => {
		const sub = cleanEndingSubscribe();
		const state = createMockState(makeClient({ subscribe: sub.subscribe }));

		const listener = startEventListener(state);
		await waitFor(() => sub.calls >= 2);
		stopEventListener();
		await listener;

		expect(sub.calls).toBeGreaterThanOrEqual(2);
	});

	it("should not probe the health endpoint while events keep arriving", async () => {
		const sub = hangingSubscribe();
		let infoCalls = 0;
		const state = createMockState(
			makeClient({
				subscribe: sub.subscribe,
				info: async () => {
					infoCalls++;
					return {};
				},
			}),
		);

		await startSettledListener(state);
		markEventReceived();
		await watchdogTick(state);

		expect(infoCalls).toBe(0);
	});

	it("should force a reconnect when the health probe fails", async () => {
		const sub = hangingSubscribe();
		let infoCalls = 0;
		const state = createMockState(
			makeClient({
				subscribe: sub.subscribe,
				info: async () => {
					infoCalls++;
					throw new Error("connection refused");
				},
			}),
		);

		const { listener } = await startSettledListener(state);
		markEventReceived(Date.now() - watchdogConfig.idleStallTimeoutMs - 1);
		await watchdogTick(state);

		await waitFor(() => sub.calls >= 2);
		stopEventListener();
		await listener;

		expect(sub.calls).toBeGreaterThanOrEqual(2);
		expect(infoCalls).toBeGreaterThanOrEqual(1);
		const errorOutput = errorSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
		expect(errorOutput).toContain("reconnecting");
	});

	it("should tolerate one silent probe while busy and reconnect after a second", async () => {
		const sub = hangingSubscribe();
		const state = createMockState(
			makeClient({
				subscribe: sub.subscribe,
				active: async () => ({ ses_1: { type: "running" } }),
			}),
		);

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
		const state = createMockState(
			makeClient({
				subscribe: sub.subscribe,
				active: async () => ({}),
			}),
		);

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

	it("should not finish the turn while the server reports the session running", async () => {
		const sub = hangingSubscribe();
		const state = createMockState(
			makeClient({
				subscribe: sub.subscribe,
				active: async () => ({ ses_1: { type: "running" } }),
			}),
		);

		const { listener } = await startSettledListener(state);
		startRequestTracking(state);
		expect(isRequestActive()).toBe(true);

		markEventReceived(Date.now() - watchdogConfig.stallTimeoutMs - 1);
		await watchdogTick(state);

		expect(isRequestActive()).toBe(true);

		stopEventListener();
		await listener;
	});

	it("should not finish the turn when the session status query fails", async () => {
		const sub = hangingSubscribe();
		const state = createMockState(
			makeClient({
				subscribe: sub.subscribe,
				active: async () => {
					throw new Error("boom");
				},
			}),
		);

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
