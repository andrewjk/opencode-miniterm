import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as ansi from "../src/ansi";
import { _resetInputState, _setInputState, renderLine } from "../src/input";
import * as render from "../src/render";

describe("renderLine", () => {
	let writeSpy: ReturnType<typeof spyOn>;
	let writePromptSpy: ReturnType<typeof spyOn>;
	const originalColumns = process.stdout.columns;

	beforeEach(() => {
		_resetInputState();
		writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		writePromptSpy = spyOn(render, "writePrompt").mockImplementation(() => {});
		// Set a reasonable console width for testing
		Object.defineProperty(process.stdout, "columns", {
			value: 80,
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
		writePromptSpy.mockRestore();
		Object.defineProperty(process.stdout, "columns", {
			value: originalColumns,
			writable: true,
			configurable: true,
		});
	});

	describe("initial render", () => {
		it("should render prompt and cursor at position 0 on first call", () => {
			_setInputState({ inputBuffer: "", cursorPosition: 0 });

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// Should start with CURSOR_HOME
			expect(calls[0]).toBe(ansi.CURSOR_HOME);
			// Should contain CURSOR_COL for positioning after prompt (col 2)
			expect(calls).toContain(ansi.CURSOR_COL(2));
			// Should contain CLEAR_FROM_CURSOR
			expect(calls).toContain(ansi.CLEAR_FROM_CURSOR);
			// Should end with cursor positioning at col 2
			expect(calls[calls.length - 1]).toBe(ansi.CURSOR_COL(2));
		});

		it("should write prompt when starting fresh", () => {
			_setInputState({ inputBuffer: "", cursorPosition: 0 });

			renderLine();

			expect(writePromptSpy).toHaveBeenCalled();
		});
	});

	describe("typing characters", () => {
		it("should write new characters when typing", () => {
			_setInputState({
				inputBuffer: "a",
				cursorPosition: 1,
				oldInputBuffer: "",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			expect(calls).toContain("a");
		});

		it("should only write changed portion of input", () => {
			_setInputState({
				inputBuffer: "hello world",
				cursorPosition: 11,
				oldInputBuffer: "hello ",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const output = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]).join("");
			// Should only write "world" not the whole string
			expect(output).toContain("world");
			expect(output).not.toContain("hellohello");
		});

		it("should clear from cursor before writing changes", () => {
			_setInputState({
				inputBuffer: "ab",
				cursorPosition: 2,
				oldInputBuffer: "a",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			const clearIndex = calls.indexOf(ansi.CLEAR_FROM_CURSOR);
			const writeIndex = calls.indexOf("b");
			expect(clearIndex).toBeLessThan(writeIndex);
		});
	});

	describe("cursor movement", () => {
		it("should position cursor at correct column after render", () => {
			_setInputState({
				inputBuffer: "hello",
				cursorPosition: 5,
				oldInputBuffer: "",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// Cursor should be at column 7 (prompt "❯ " = 2 chars + 5 chars typed)
			expect(calls).toContain(ansi.CURSOR_COL(7));
		});

		it("should move cursor up when old content was multiple rows", () => {
			_setInputState({
				inputBuffer: "x",
				cursorPosition: 1,
				oldInputBuffer: "",
				oldWrappedRows: 2,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			expect(calls).toContain(ansi.CURSOR_UP(2));
		});
	});

	describe("line wrapping", () => {
		it("should handle content that wraps to next line", () => {
			Object.defineProperty(process.stdout, "columns", {
				value: 10,
				writable: true,
				configurable: true,
			});

			_setInputState({
				inputBuffer: "helloworld",
				cursorPosition: 10,
				oldInputBuffer: "",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// Should have a newline when wrapping
			expect(calls).toContain("\n");
		});

		it("should calculate correct cursor position when wrapped", () => {
			Object.defineProperty(process.stdout, "columns", {
				value: 10,
				writable: true,
				configurable: true,
			});

			_setInputState({
				inputBuffer: "helloworld",
				cursorPosition: 10,
				oldInputBuffer: "",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// Absolute position 12 (2 prompt + 10 chars), row 1, col 2
			expect(calls).toContain(ansi.CURSOR_COL(2));
		});
	});

	describe("backspace/delete", () => {
		it("should clear and rewrite when deleting characters", () => {
			_setInputState({
				inputBuffer: "he",
				cursorPosition: 2,
				oldInputBuffer: "hel",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// Should clear from cursor
			expect(calls).toContain(ansi.CLEAR_FROM_CURSOR);
		});
	});

	describe("state tracking", () => {
		it("should update old state after render", () => {
			_setInputState({
				inputBuffer: "test",
				cursorPosition: 4,
				oldInputBuffer: "",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			// After render, calling again should recognize no changes
			writeSpy.mockClear();
			renderLine();

			const output = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]).join("");
			// Should not write "test" again since nothing changed
			expect(output).not.toContain("test");
		});
	});

	describe("control sequences", () => {
		it("should use CURSOR_HOME to move to start", () => {
			_setInputState({ inputBuffer: "hi", cursorPosition: 2 });

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			const homeCount = calls.filter((c: string) => c === ansi.CURSOR_HOME).length;
			expect(homeCount).toBeGreaterThanOrEqual(1);
		});

		it("should use CLEAR_FROM_CURSOR to clear content", () => {
			_setInputState({
				inputBuffer: "changed",
				cursorPosition: 7,
				oldInputBuffer: "old",
				oldWrappedRows: 0,
				oldCursorRow: 0,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			expect(calls).toContain(ansi.CLEAR_FROM_CURSOR);
		});

		it("should use CURSOR_COL for horizontal positioning", () => {
			_setInputState({ inputBuffer: "abc", cursorPosition: 3 });

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// Should have CURSOR_COL calls for positioning
			const hasColCodes = calls.some(
				(c: string) => typeof c === "string" && c.match(/^\x1b\[\d+G$/),
			);
			expect(hasColCodes).toBe(true);
		});

		it("should not emit CURSOR_UP(0) which would move up 1 line", () => {
			_setInputState({ inputBuffer: "x", cursorPosition: 1 });

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
			// CURSOR_UP(0) produces "\x1b[0A" which terminals interpret as "move up 1"
			// We should not emit this - only emit CURSOR_UP when rows > 0
			expect(calls).not.toContain(ansi.CURSOR_UP(0));
		});

		it("should not move cursor during comparison loop (only calculate position)", () => {
			// With 10-char width, prompt takes 2 chars, so 8 chars fit on first line
			// Typing the 10th char when 9 chars already exist should not move cursor down
			// during the comparison loop, only position at the end
			Object.defineProperty(process.stdout, "columns", {
				value: 10,
				writable: true,
				configurable: true,
			});

			_setInputState({
				inputBuffer: "abcdefghij",
				cursorPosition: 10,
				oldInputBuffer: "abcdefghi",
				oldWrappedRows: 1,
				oldCursorRow: 1,
			});

			renderLine();

			const calls = writeSpy.mock.calls.map((c: [string, ...unknown[]]) => c[0]);

			// Should have CURSOR_UP to get to top
			expect(calls).toContain(ansi.CURSOR_UP(1));

			// Should NOT have CURSOR_DOWN during comparison (would be between UP and CLEAR)
			const upIndex = calls.indexOf(ansi.CURSOR_UP(1));
			const clearIndex = calls.indexOf(ansi.CURSOR_UP(1));
			const downAfterUp = calls
				.slice(upIndex, clearIndex)
				.some((c: string) => c === ansi.CURSOR_DOWN(1));
			expect(downAfterUp).toBe(false);
		});
	});
});
