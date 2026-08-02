import * as ansi from "./ansi";

// Whether a code point occupies two terminal columns (East Asian Wide /
// Fullwidth / Emoji). Conservative approximation based on the Unicode East
// Asian Width property — good enough for line wrapping, not a full
// grapheme-cluster implementation.
function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2329 && code <= 0x232a) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3040 && code <= 0x33bf) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0xa4cf) ||
		(code >= 0xa960 && code <= 0xa97f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f680 && code <= 0x1f6ff) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x1fa70 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

// Whether a code point contributes zero columns (combining marks, variation
// selectors, zero-width spaces).
function isZeroWidth(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x200b && code <= 0x200f) ||
		code === 0xfeff ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		(code >= 0xe0100 && code <= 0xe01ef)
	);
}

function charWidth(code: number): number {
	if (isZeroWidth(code)) return 0;
	return isWide(code) ? 2 : 1;
}

// Number of terminal columns `str` occupies, ignoring ANSI SGR escape codes
// and counting wide characters as two columns. Using this (rather than
// `string.length`, which counts UTF-16 code units) is what stops wide
// characters from making a line overflow the terminal width and silently
// auto-wrap into an extra physical row.
export function displayWidth(str: string): number {
	const stripped = ansi.stripAnsiCodes(str);
	let width = 0;
	for (const ch of stripped) {
		width += charWidth(ch.codePointAt(0)!);
	}
	return width;
}

// Wrap a single (possibly ANSI-styled) line so every emitted row fits within
// `width` display columns. The leading-space indent and the active ANSI style
// are re-applied on continuation rows, so wrapped text stays aligned and
// coloured instead of dropping its styling mid-line. Wide characters are never
// split across rows. Always returns at least one entry.
export function wrapStyledLine(line: string, width: number): string[] {
	if (width <= 1) return [line];
	if (displayWidth(line) <= width) return [line];

	const indentMatch = line.match(/^ */);
	const indent = indentMatch ? indentMatch[0] : "";
	const indentWidth = indent.length;

	const rows: string[] = [];
	let row = "";
	let col = 0;
	let style = "";

	const breakRow = () => {
		rows.push(row + ansi.RESET);
		row = indent + style;
		col = indentWidth;
	};

	let i = 0;
	while (i < line.length) {
		const code = line.codePointAt(i)!;

		if (code === 0x1b && line[i + 1] === "[") {
			const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m) {
				const seg = m[0];
				row += seg;
				if (seg === ansi.RESET) style = "";
				else style += seg;
				i += seg.length;
				continue;
			}
		}

		const step = code > 0xffff ? 2 : 1;
		const w = charWidth(code);
		if (w > 0 && col + w > width) {
			breakRow();
		}
		row += line.slice(i, i + step);
		col += w;
		i += step;
	}
	rows.push(row + ansi.RESET);
	return rows;
}

// Wrap an array of (possibly ANSI-styled) lines to `width` display columns.
// The returned length is exactly the number of physical terminal rows the
// caller will produce by writing each entry followed by a newline — which is
// what lets the overlay's cursor-up clear erase precisely what it drew.
export function wrapLines(lines: string[], width: number): string[] {
	const out: string[] = [];
	for (const line of lines) {
		out.push(...wrapStyledLine(line, width));
	}
	return out;
}
