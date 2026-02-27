import { describe, expect, it, vi } from "bun:test";
import { type State } from "../src";
import * as ansi from "../src/ansi";
import { render, wrapText } from "../src/render";

describe("render", () => {
	const createMockState = (overrides?: Partial<State>): State => ({
		sessionID: "",
		renderedLines: [],
		accumulatedResponse: [],
		allEvents: [],
		write: vi.fn(),
		lastFileAfter: new Map(),
		...overrides,
	});

	describe("clearRenderedLines", () => {
		it("should not write escape sequence when renderedLines is empty", () => {
			const write = vi.fn();
			const state = createMockState({ renderedLines: [], write });

			render(state);

			expect(write).not.toHaveBeenCalled();
		});

		it("should write escape sequence to clear lines when renderedLines has content", () => {
			const write = vi.fn();
			const state = createMockState({
				renderedLines: ["line1", "line2", "line3", "line4", "line5"],
				accumulatedResponse: [{ key: "xxx", title: "response", text: "new content" }],
				write,
			});

			render(state);

			expect(write).toHaveBeenCalledWith("\x1b[5A\x1b[J");
		});

		it("should clear previous accumulated parts", () => {
			const write = vi.fn();
			let state = createMockState({ renderedLines: [], accumulatedResponse: [], write });

			state.accumulatedResponse.push({ key: "xxx", title: "thinking", text: "gotta do the thing" });
			state.accumulatedResponse.push({
				key: "xxx",
				title: "thinking",
				text: "now i know how to do it",
			});

			render(state);

			const firstOutput = write.mock.calls.map((c) => c[0]).join("");
			expect(firstOutput).toContain("now i know how to do it");

			write.mockClear();

			state.accumulatedResponse.push({ key: "xxx", title: "response", text: "i've done it" });

			render(state);

			const calls = write.mock.calls.map((c) => c[0]);
			expect(calls.some((c) => c.includes("\u001B[2A"))).toBe(true);
			const outputCall = calls.find((c) => c.includes("i've done it"));
			expect(outputCall).toContain(`${ansi.WHITE_BACKGROUND}${ansi.BOLD_BLACK}*${ansi.RESET}`);
		});
	});

	describe("thinking parts", () => {
		it("should render thinking part with thinking indicator and gray text", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ key: "xxx", title: "thinking", text: "分析问题" }],
				write,
			});

			render(state);

			const output = write.mock.calls.map((c) => c[0]).join("");
			expect(output).toContain(
				`${ansi.BOLD_BRIGHT_BLACK}~${ansi.RESET} ${ansi.BRIGHT_BLACK}分析问题${ansi.RESET}`,
			);
		});

		it("should only show thinking indicator for last thinking part", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [
					{ key: "xxx", title: "thinking", text: "first" },
					{ key: "xxx", title: "thinking", text: "second" },
				],
				write,
			});

			render(state);

			const output = write.mock.calls.map((c) => c[0]).join("");
			expect(output).toContain(
				`${ansi.BOLD_BRIGHT_BLACK}~${ansi.RESET} ${ansi.BRIGHT_BLACK}second${ansi.RESET}`,
			);
			expect(output).not.toContain("first");
		});

		it("should skip parts with empty text", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ key: "xxx", title: "thinking", text: "" }],
				write,
			});

			render(state);

			expect(write).not.toHaveBeenCalled();
		});

		it("should skip null parts", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [null as any, { key: "xxx", title: "response", text: "test" }],
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
				accumulatedResponse: [{ key: "xxx", title: "response", text: "Hello world" }],
				write,
			});

			render(state);

			const output = write.mock.calls.map((c) => c[0]).join("");
			expect(output).toContain(
				`${ansi.WHITE_BACKGROUND}${ansi.BOLD_BLACK}*${ansi.RESET} Hello world`,
			);
		});
	});

	describe("tool parts", () => {
		it("should render tool part with indicator", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ key: "xxx", title: "tool", text: "bash: ls -la" }],
				write,
			});

			render(state);

			const output = write.mock.calls.map((c) => c[0]).join("");
			expect(output).toContain("bash: ls -la");
		});
	});

	describe("files parts", () => {
		it("should render files part without indicator", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ key: "xxx", title: "files", text: "src/index.ts" }],
				write,
			});

			render(state);

			const output = write.mock.calls.map((c) => c[0]).join("");
			expect(output).toContain("src/index.ts");
		});
	});

	describe("line counting", () => {
		it("should count lines correctly for multiline output", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ key: "xxx", title: "response", text: "line1\nline2\nline3" }],
				write,
			});

			render(state);

			expect(state.renderedLines.length).toBe(4);
		});

		it("should set renderedLines to empty when output is empty", () => {
			const state = createMockState({
				accumulatedResponse: [],
			});

			render(state);

			expect(state.renderedLines.length).toBe(0);
		});

		it("should count lines including newlines from part formatting", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [{ key: "xxx", title: "response", text: "A" }],
				write,
			});

			render(state);

			expect(state.renderedLines.length).toBe(2);
		});
	});

	describe("empty state", () => {
		it("should not write anything when accumulatedResponse is empty", () => {
			const write = vi.fn();
			const state = createMockState({ write });

			render(state);

			expect(write).not.toHaveBeenCalled();
			expect(state.renderedLines.length).toBe(0);
		});

		it("should not write anything when all parts have empty text", () => {
			const write = vi.fn();
			const state = createMockState({
				accumulatedResponse: [
					{ key: "xxx", title: "thinking", text: "" },
					{ key: "xxx", title: "response", text: "" },
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
					{ key: "xxx", title: "thinking", text: "分析中" },
					{ key: "xxx", title: "tool", text: "bash: npm test" },
					{ key: "xxx", title: "response", text: "Test results: 5 passed" },
				],
				write,
			});

			render(state);

			const output = write.mock.calls.map((c) => c[0]).join("");
			expect(output).not.toContain(`分析中`);
			expect(output).toContain(`bash: npm test`);
			expect(output).toContain(
				`${ansi.WHITE_BACKGROUND}${ansi.BOLD_BLACK}*${ansi.RESET} Test results: 5 passed`,
			);
		});
	});
});

describe("wrapText", () => {
	describe("basic wrapping", () => {
		it("should return single line for text shorter than width", () => {
			const result = wrapText("hello", 20);
			expect(result).toEqual(["  hello"]);
		});

		it("should wrap text longer than width", () => {
			const result = wrapText("hello world this is a long text", 10);
			expect(result).toEqual(["  hello", "  world", "  this is", "  a long", "  text"]);
		});

		it("should handle text exactly at width", () => {
			const result = wrapText("1234567890", 10);
			expect(result).toEqual(["  1234567890"]);
		});

		it("should break long word that exceeds width", () => {
			const result = wrapText("12345678901", 10);
			expect(result).toEqual(["  ", "  12345678", "  901"]);
		});
	});

	describe("multiple lines", () => {
		it("should preserve existing newlines", () => {
			const result = wrapText("line1\nline2\nline3", 20);
			expect(result).toEqual(["  line1", "  line2", "  line3"]);
		});

		it("should wrap lines that are too long", () => {
			const result = wrapText("very long line1\nshort\nvery long line2", 10);
			expect(result).toEqual([
				"  very",
				"  long",
				"  line1",
				"  short",
				"  very",
				"  long",
				"  line2",
			]);
		});

		it("should handle empty lines", () => {
			const result = wrapText("line1\n\nline3", 20);
			expect(result).toEqual(["  line1", "  ", "  line3"]);
		});
	});

	describe("ANSI codes", () => {
		it("should preserve ANSI codes in output", () => {
			const result = wrapText("\x1b[31mred\x1b[0m text", 20);
			expect(result).toEqual(["  \x1b[31mred\x1b[0m text"]);
		});

		it("should not count ANSI codes toward visible width", () => {
			const result = wrapText("\x1b[31mred\x1b[0m text", 8);
			expect(result).toEqual(["  \x1b[31mred\x1b[0m", "  text"]);
		});

		it("should handle multiple ANSI codes", () => {
			const result = wrapText("\x1b[31m\x1b[1mbold red\x1b[0m\x1b[32m green\x1b[0m", 10);
			expect(result).toEqual(["  \x1b[31m\x1b[1mbold red\x1b[0m\x1b[32m", "  green\x1b[0m"]);
		});

		it("should handle ANSI codes at wrap boundary", () => {
			const result = wrapText("12345\x1b[31m67890\x1b[0m", 10);
			expect(result).toEqual(["  12345\x1b[31m67890\x1b[0m"]);
		});
	});

	describe("edge cases", () => {
		it("should handle empty string", () => {
			const result = wrapText("", 20);
			expect(result).toEqual(["  "]);
		});

		it("should handle single character", () => {
			const result = wrapText("a", 20);
			expect(result).toEqual(["  a"]);
		});

		it("should handle width of 1", () => {
			const result = wrapText("a b c", 1);
			expect(result).toEqual(["  a", "  b", "  c"]);
		});

		it("should handle carriage return characters", () => {
			const result = wrapText("hello\r\nworld", 20);
			expect(result).toEqual(["  hello", "  world"]);
		});

		it("should handle trailing newline", () => {
			const result = wrapText("hello\n", 20);
			expect(result).toEqual(["  hello"]);
		});

		it("should handle multiple trailing newlines", () => {
			const result = wrapText("hello\n\n", 20);
			expect(result).toEqual(["  hello", "  "]);
		});

		it("should handle leading newline", () => {
			const result = wrapText("\nhello", 20);
			expect(result).toEqual(["  ", "  hello"]);
		});
	});

	describe("real-world scenarios", () => {
		it("should wrap thinking output with indicator", () => {
			const result = wrapText(
				"Let me analyze this problem step by step to find the best solution",
				36,
			);
			expect(result.length).toBeGreaterThan(1);
			expect(result[0]).toBe("  Let me analyze this problem step");
		});

		it("should wrap response output with indicator", () => {
			const result = wrapText(
				"Here is the solution:\nWe need to implement the fix by updating the wrapText function",
				26,
			);
			expect(result.length).toBeGreaterThan(1);
		});

		it("should wrap output with ANSI colors", () => {
			const result = wrapText(
				"\x1b[90mThis is gray text\x1b[0m and this is \x1b[31mred\x1b[0m",
				25,
			);
			expect(result[0]).toContain("\x1b[90m");
			expect(result[0]).toContain("\x1b[0m");
		});

		it("should handle tool output", () => {
			const result = wrapText("🔧 Using `bash`\nRunning command to install dependencies", 35);
			expect(result[0]).toContain("🔧 Using");
			expect(result[1]).toContain("Running command");
		});
	});
});
