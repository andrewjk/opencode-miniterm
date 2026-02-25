export const CLEAR_SCREEN = "\x1b[2J";
export const CLEAR_FROM_CURSOR = "\x1b[0J";
export const CLEAR_LINE = "\x1b[K";
export const CLEAR_SCREEN_UP = "\x1b[2A";
export const CURSOR_HOME = "\x1b[0G";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
export const CURSOR_UP = (lines: number) => `\x1b[${lines}A`;
export const RESET = "\x1b[0m";
export const BRIGHT_WHITE = "\x1b[97m";
export const BRIGHT_BLACK = "\x1b[90m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const BLUE = "\x1b[34m";
export const CYAN = "\x1b[36m";
export const BOLD_MAGENTA = "\x1b[1;35m";
export const STRIKETHROUGH = "\x1b[9m";
export const ANSI_CODE_PATTERN = /^\x1b\[[0-9;]*m/;

export function stripAnsiCodes(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
