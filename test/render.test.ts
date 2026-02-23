import { describe, expect, it, vi } from "bun:test";
import { type State } from "../src";
import { render } from "../src/render";

describe("render", () => {
	const createMockState = (overrides?: Partial<State>): State => ({
		renderedLinesCount: 0,
		accumulatedResponse: [],
		write: vi.fn(),
		...overrides,
	});

	describe("clearRenderedLines", () => {
		it("should not write escape sequence when renderedLinesCount is 0", () => {
			const write = vi.fn();
			const state = createMockState({ renderedLinesCount: 0, write });

			render(state);

			expect(write).not.toHaveBeenCalled();
		});

		it("should write escape sequence to clear lines when renderedLinesCount > 0", () => {
			const write = vi.fn();
			const state = createMockState({ renderedLinesCount: 5, write });

			render(state);

			expect(write).toHaveBeenCalledWith("\x1b[5A\x1b[J");
		});

		it("should clear previous accumulated parts", () => {
			const write = vi.fn();
			let state = createMockState({ renderedLinesCount: 0, accumulatedResponse: [], write });

			state.accumulatedResponse.push({ title: "thinking", text: "gotta do the thing" });
			state.accumulatedResponse.push({ title: "thinking", text: "now i know how to do it" });

			render(state);

			expect(write).toHaveBeenCalledWith(
				"💭 Thinking...\n\n\x1b[90mnow i know how to do it\x1b[0m\n\n",
			);

			write.mockClear();

			state.accumulatedResponse.push({ title: "response", text: "i've done it" });

			render(state);

			expect(write).toHaveBeenCalledWith("\u001B[4A\u001B[J");
			expect(write).toHaveBeenCalledWith("💬 Response:\n\ni've done it\n\n");
		});
	});

	describe("thinking parts", () => {
		it("should render thinking part with thinking indicator and gray text", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "thinking", text: "分析问题" }],
				write,
			});

			render(state);

			expect(write).toHaveBeenCalledWith("💭 Thinking...\n\n\x1b[90m分析问题\x1b[0m\n\n");
		});

		it("should only show thinking indicator for last thinking part", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [
					{ title: "thinking", text: "first" },
					{ title: "thinking", text: "second" },
				],
				write,
			});

			render(state);

			const output = write.mock.calls[0]![0];
			expect(output).toContain("💭 Thinking...");
			expect(output).not.toMatch(/first.*Thinking/);
		});

		it("should skip parts with empty text", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "thinking", text: "" }],
				write,
			});

			render(state);

			expect(write).not.toHaveBeenCalled();
		});

		it("should skip null parts", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [null as any, { title: "response", text: "test" }],
				write,
			});

			render(state);

			expect(write).toHaveBeenCalled();
		});
	});

	describe("response parts", () => {
		it("should render response part with response indicator", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "response", text: "Hello world" }],
				write,
			});

			render(state);

			expect(write).toHaveBeenCalledWith("💬 Response:\n\nHello world\n\n");
		});
	});

	describe("tool parts", () => {
		it("should render tool part without indicator", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "tool", text: "Running: ls -la" }],
				write,
			});

			render(state);

			expect(write).toHaveBeenCalledWith("Running: ls -la\n\n");
		});
	});

	describe("files parts", () => {
		it("should render files part without indicator", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "files", text: "src/index.ts" }],
				write,
			});

			render(state);

			expect(write).toHaveBeenCalledWith("src/index.ts\n\n");
		});
	});

	describe("line counting", () => {
		it("should count lines correctly for multiline output", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "response", text: "line1\nline2\nline3" }],
				write,
			});

			render(state);

			expect(state.renderedLinesCount).toBe(6);
		});

		it("should set renderedLinesCount to 0 when output is empty", () => {
			const state = createMockState({
				accumulatedResponse: [],
			});

			render(state);

			expect(state.renderedLinesCount).toBe(0);
		});

		it("should count lines including newlines from part formatting", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ title: "response", text: "A" }],
				write,
			});

			render(state);

			expect(state.renderedLinesCount).toBe(4);
		});
	});

	describe("empty state", () => {
		it("should not write anything when accumulatedResponse is empty", () => {
			const write = vi.fn();
			const state = createMockState({ write });

			render(state);

			expect(write).not.toHaveBeenCalled();
			expect(state.renderedLinesCount).toBe(0);
		});

		it("should not write anything when all parts have empty text", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [
					{ title: "thinking", text: "" },
					{ title: "response", text: "" },
				],
				write,
			});

			render(state);

			expect(write).not.toHaveBeenCalled();
		});
	});

	describe("multiple parts", () => {
		it("should render multiple parts in order", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [
					{ title: "thinking", text: "分析中" },
					{ title: "tool", text: "Running: npm test" },
					{ title: "response", text: "Test results: 5 passed" },
				],
				write,
			});

			render(state);

			const output = write.mock.calls[0]![0];
			expect(output).not.toContain("💭 Thinking...");
			expect(output).toContain("Running: npm test");
			expect(output).toContain("💬 Response:");
		});
	});
});
