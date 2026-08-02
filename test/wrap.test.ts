import { describe, expect, it } from "bun:test";
import * as ansi from "../src/ansi";
import { displayWidth, wrapLines, wrapStyledLine } from "../src/wrap";

const strip = (s: string) => ansi.stripAnsiCodes(s);

describe("displayWidth", () => {
	it("counts ASCII characters one-for-one", () => {
		expect(displayWidth("hello")).toBe(5);
	});

	it("ignores ANSI escape codes", () => {
		expect(displayWidth(`${ansi.CYAN}hi${ansi.RESET}`)).toBe(2);
	});

	it("counts CJK characters as two columns", () => {
		expect(displayWidth("中文")).toBe(4);
	});

	it("counts emoji as two columns", () => {
		expect(displayWidth("🗣️")).toBe(2);
	});

	it("ignores variation selectors and combining marks", () => {
		// 🗣️ is U+1F5E3 + U+FE0F (variation selector). Only the base emoji counts.
		expect(displayWidth("🗣️")).toBe(2);
		expect(displayWidth("e\u0301")).toBe(1);
	});

	it("differs from string.length for wide text", () => {
		const text = "这是一个测试";
		expect(text.length).toBe(6);
		expect(displayWidth(text)).toBe(12);
	});
});

describe("wrapStyledLine", () => {
	it("returns the line unchanged when it already fits", () => {
		expect(wrapStyledLine("short line", 80)).toEqual(["short line"]);
	});

	it("returns the line unchanged when exactly at the width", () => {
		const line = "1234567890";
		expect(wrapStyledLine(line, 10)).toEqual([line]);
	});

	it("wraps long ASCII lines so every row fits the width", () => {
		const line = "abcdefghijklmnopqrstuvwxyz";
		const rows = wrapStyledLine(line, 10);
		for (const row of rows) {
			expect(displayWidth(row)).toBeLessThanOrEqual(10);
		}
		expect(rows.length).toBe(3);
	});

	it("preserves a leading-space indent on continuation rows", () => {
		const line = "  abcdefghijklmnopqrstuvwxyz";
		const rows = wrapStyledLine(line, 10);
		for (const row of rows) {
			expect(strip(row).startsWith("  ")).toBe(true);
			expect(displayWidth(row)).toBeLessThanOrEqual(10);
		}
	});

	it("wraps wide (CJK) text by display columns, not code units", () => {
		// 8 CJK chars = 16 columns; at width 5 each row holds at most 2 wide
		// chars (4 cols — a third would reach 6 > 5), so we expect 4 rows.
		const line = "这是一二三四五六";
		const rows = wrapStyledLine(line, 5);
		for (const row of rows) {
			expect(displayWidth(row)).toBeLessThanOrEqual(5);
		}
		expect(rows.length).toBe(4);
	});

	it("does not split a wide character across rows", () => {
		// width 1: a single wide char can't fit alongside anything; rows must
		// still never contain a broken surrogate half.
		const line = "中";
		const rows = wrapStyledLine(line, 1);
		expect(rows.length).toBe(1);
		expect(rows[0]).toBe("中");
	});

	it("preserves ANSI colour across wrapped rows", () => {
		const line = `${ansi.GREEN}${"ab".repeat(20)}${ansi.RESET}`;
		const rows = wrapStyledLine(line, 10);
		expect(rows.length).toBeGreaterThan(1);
		// The first row keeps the opening colour; continuation rows re-apply it.
		expect(rows[0]).toContain(ansi.GREEN);
		for (const row of rows) {
			expect(row.endsWith(ansi.RESET)).toBe(true);
		}
	});

	it("handles the question overlay's selected-option line without orphan rows", () => {
		const line = `  ${ansi.GREEN}►${ansi.RESET} 1. Some very long option label text`;
		const rows = wrapStyledLine(line, 20);
		for (const row of rows) {
			expect(displayWidth(row)).toBeLessThanOrEqual(20);
		}
		// No row should be a bare indent or bare arrow (the old bug).
		for (const row of rows) {
			expect(strip(row).trim()).not.toBe("");
			expect(strip(row).trim()).not.toBe("►");
		}
	});
});

describe("wrapLines", () => {
	it("preserves empty lines in the output", () => {
		const rows = wrapLines(["a", "", "b"], 80);
		expect(rows).toEqual(["a", "", "b"]);
	});

	it("the row count equals the number of physical terminal rows produced", () => {
		// Each wrapped entry, when written with a trailing newline, must occupy
		// exactly one terminal row — i.e. never exceed the width. This is the
		// invariant the overlay cursor-up clear relies on.
		const lines = [
			"",
			`${ansi.CYAN}Header${ansi.RESET}`,
			"",
			`  A fairly long question that definitely needs to wrap around`,
			`  ${ansi.GREEN}►${ansi.RESET} 1. Option with a long description`,
			`       ${ansi.BRIGHT_BLACK}desc${ansi.RESET}`,
			"",
			`${ansi.BRIGHT_BLACK}  ↑/↓ help${ansi.RESET}`,
			`中日韓の文字が混在する長い行もここで折り返される`,
		];
		const width = 30;
		const rows = wrapLines(lines, width);
		for (const row of rows) {
			expect(displayWidth(row)).toBeLessThanOrEqual(width);
		}
	});
});
