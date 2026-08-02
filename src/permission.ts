import type { Key } from "node:readline";
import * as ansi from "./ansi";
import { resetInputBufferState } from "./input";
import { resumeAnimation, stopAnimation } from "./render";
import { drainPendingPrompt } from "./server";
import type { State } from "./types";
import { wrapLines } from "./wrap";

interface PermissionEvent {
	type: "permission.asked" | "permission.updated";
	properties: {
		id: string;
		sessionID: string;
		permission: string;
		patterns?: string[];
		pattern?: string | string[];
		title?: string;
		always?: string[];
		tool?: {
			messageID: string;
			callID: string;
		};
		metadata?: {
			[key: string]: unknown;
		};
	};
}

interface PermissionState {
	active: boolean;
	permissionID: string;
	sessionID: string;
	permission: string;
	title: string;
	patterns: string[];
	selectedIndex: number;
}

let permissionState: PermissionState | null = null;
let renderLines: string[] = [];
let currentState: State | null = null;

export function getPermissionState(): PermissionState | null {
	return permissionState;
}

export function startPermission(event: PermissionEvent, state: State): PermissionState {
	stopAnimation();
	process.stdout.write(ansi.CURSOR_SHOW);

	currentState = state;

	const props = event.properties;
	const patterns =
		props.patterns ||
		(Array.isArray(props.pattern) ? props.pattern : props.pattern ? [props.pattern] : []);
	const title = props.title || formatPermissionTitle(props.permission, patterns);

	permissionState = {
		active: true,
		permissionID: props.id,
		sessionID: props.sessionID,
		permission: props.permission,
		title,
		patterns,
		selectedIndex: 0,
	};
	renderLines = [];
	renderPermission();
	return permissionState;
}

export function handlePermissionKeyPress(str: string, key: Key): boolean {
	if (!permissionState || !permissionState.active) {
		return false;
	}

	switch (key.name) {
		case "up": {
			if (permissionState.selectedIndex > 0) {
				permissionState.selectedIndex--;
				renderPermission();
			}
			return true;
		}
		case "down": {
			if (permissionState.selectedIndex < 2) {
				permissionState.selectedIndex++;
				renderPermission();
			}
			return true;
		}
		case "return": {
			submitResponse(permissionState.selectedIndex);
			return true;
		}
		case "escape": {
			submitResponse(2);
			return true;
		}
		default: {
			if (str === "y" || str === "Y") {
				submitResponse(0);
				return true;
			}
			if (str === "a" || str === "A") {
				submitResponse(1);
				return true;
			}
			if (str === "n" || str === "N") {
				submitResponse(2);
				return true;
			}
			return true;
		}
	}
}

async function submitResponse(optionIndex: number): Promise<void> {
	if (!permissionState || !currentState) return;

	const stateCopy = currentState;
	const { permissionID, sessionID, selectedIndex } = permissionState;

	const responses: ("once" | "always" | "reject")[] = ["once", "always", "reject"];
	const labels = ["Allow once", "Allow always", "Deny"];
	const response = responses[optionIndex] || "reject";
	const label = labels[optionIndex] || "Deny";

	clearPermission();
	permissionState = null;
	currentState = null;

	process.stdout.write(`  ${ansi.BRIGHT_WHITE}🔒${ansi.RESET} ${label}\n\n`);

	// The dismissed overlay leaves the live-area cursor tracking describing the
	// overlay/spinner layout rather than the echo we just wrote. Reset it so the
	// current cursor position becomes the live-area top for whatever renders
	// next, otherwise repaints stack on the stale offsets.
	resetInputBufferState();

	try {
		const result = await stateCopy.client.postSessionIdPermissionsPermissionId({
			path: { id: sessionID, permissionID },
			body: { response },
		});

		if (result.error) {
			console.error(`${ansi.RED}Failed to respond to permission:${ansi.RESET}`, result.error);
		}
	} catch (error) {
		console.error(`${ansi.RED}Failed to respond to permission:${ansi.RESET}`, error);
	}

	// Responding unblocks the turn that was waiting (parent or subagent), so
	// resume its spinner/output — unless another queued prompt takes over the
	// screen.
	if (!drainPendingPrompt(stateCopy)) resumeAnimation(stateCopy);
}

export function renderPermission(): void {
	if (!permissionState) return;

	const lines: string[] = [];

	lines.push("");
	lines.push(`${ansi.YELLOW}🔒 Permission required${ansi.RESET}`);
	lines.push("");

	if (permissionState.title) {
		lines.push(`  ${ansi.BRIGHT_WHITE}${permissionState.title}${ansi.RESET}`);
	}

	if (permissionState.patterns.length > 0) {
		lines.push(
			`  ${ansi.BRIGHT_BLACK}Patterns:${ansi.RESET} ${permissionState.patterns.join(", ")}`,
		);
	}

	lines.push("");

	const options = [
		{ label: "Allow once", key: "y", desc: "Allow this one time" },
		{ label: "Allow always", key: "a", desc: "Always allow this permission" },
		{ label: "Deny", key: "n", desc: "Reject this permission request" },
	];

	options.forEach((option, index) => {
		const isSelected = index === permissionState!.selectedIndex;
		const prefix = isSelected ? `${ansi.GREEN}►${ansi.RESET}` : " ";
		lines.push(`  ${prefix} ${option.label} ${ansi.BRIGHT_BLACK}(${option.key})${ansi.RESET}`);
	});

	lines.push("");
	lines.push(`${ansi.BRIGHT_BLACK}  ↑/↓ or y/a/n, Enter to confirm, Esc to deny${ansi.RESET}`);

	const consoleWidth = process.stdout.columns || 80;
	const wrappedLines = wrapLines(lines, consoleWidth);

	clearRenderedLines();
	renderLines = wrappedLines;

	for (const line of wrappedLines) {
		process.stdout.write(line + "\n");
	}
}

function clearRenderedLines(): void {
	if (renderLines.length > 0) {
		process.stdout.write(`${ansi.CURSOR_UP(renderLines.length)}${ansi.CLEAR_FROM_CURSOR}`);
	}
}

function clearPermission(): void {
	clearRenderedLines();
	renderLines = [];
}

function formatPermissionTitle(permission: string, patterns: string[]): string {
	switch (permission) {
		case "external_directory":
			return `Access directory outside project: ${patterns.join(", ")}`;
		case "network":
			return `Network access`;
		case "execute":
			return `Execute command`;
		default:
			return `Permission: ${permission}`;
	}
}
