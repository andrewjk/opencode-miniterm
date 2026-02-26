# OpenCode Miniterm

A small front-end terminal UI for [OpenCode](https://github.com/anomalyco/opencode).

> **Note:** This project is not affiliated with OpenCode.

## Features

- **Slash Commands** - Quick access to common operations
- **File Auto-Completion** - Type `@` followed by file path for intelligent completions
- **Real-Time Streaming** - See AI responses as they're being generated
- **Logging Support** - Optional conversation logging for debugging
- **Keyboard Navigation** - Readline support with history and editing

## Installation

### Prerequisites

- [OpenCode](https://github.com/anomalyco/opencode) - OpenCode server
- [Bun](https://bun.sh/) - Required runtime

### Install from npm

```bash
npm install -g opencode-miniterm
# or
pnpm add -g opencode-miniterm
```

### Install from Source

```bash
git clone https://github.com/your-repo/opencode-miniterm.git
cd opencode-miniterm
bun install
bun link
```

### Quick Start

```bash
ocmt
```

This will:

1. Start the OpenCode server (if not already running)
2. Create or resume a session for the current directory
3. Present the interactive prompt

## Configuration

Configuration is stored in `~/.config/opencode-miniterm/opencode-miniterm.json`:

```json
{
	"providerID": "opencode",
	"modelID": "big-pickle",
	"agentID": "build",
	"sessionIDs": {
		"/path/to/project1": "session-id-1",
		"/path/to/project2": "session-id-2"
	},
	"loggingEnabled": false
}
```

### Environment Variables

- `OPENCODE_SERVER_USERNAME` - Server username (default: "opencode")
- `OPENCODE_SERVER_PASSWORD` - Server password (required if server has auth)
- `OPENCODE_MT_CONFIG_CONTENT` - Override config as JSON string

## Usage

### Basic Interaction

Simply type your question or request at the prompt and press Enter:

```
> Help me fix the bug in auth.ts
```

### Slash Commands

| Command            | Description                                 |
| ------------------ | ------------------------------------------- |
| `/help`            | Show available commands                     |
| `/init`            | Analyze project and create/update AGENTS.md |
| `/new`             | Create a new session                        |
| `/sessions`        | List and switch sessions                    |
| `/diff`            | Show file additions and deletions           |
| `/undo`            | Undo last assistant request                 |
| `/details`         | Show detailed info for the previous request |
| `/page`            | Page through the detailed info              |
| `/agents`          | Show available agents                       |
| `/models`          | Show available models                       |
| `/log`             | Enable/disable logging                      |
| `/run <cmd>`       | Run a shell command from within miniterm    |
| `/exit` or `/quit` | Exit the application                        |

### File References

Reference files in your conversation using `@` followed by the path:

```
> Review @src/index.ts and suggest improvements
```

Tab completion is supported for file paths:

```
> @sr<tab>  → @src/
> @src/in<tab>  → @src/index.ts
```

### Keyboard Shortcuts

| Key                    | Action                       |
| ---------------------- | ---------------------------- |
| `↑` / `↓`              | Navigate command history     |
| `←` / `→`              | Move cursor                  |
| `Opt+←` / `Opt+→`      | Move by word boundaries      |
| `Tab`                  | Auto-complete commands/files |
| `Backspace` / `Delete` | Delete characters            |
| `Esc`                  | Cancel current request       |
| `Ctrl+C`               | Force quit application       |

## Session Management

OpenCode Miniterm automatically manages sessions per directory:

- **First Launch**: Creates a new session for the current directory
- **Subsequent Launches**: Resumes the last session for that directory
- **New Session**: Use `/new` to create a fresh session
- **Switch Sessions**: Use `/sessions` to browse and switch between all your sessions

## Development

### Running Locally

```bash
bun run dev
# or
bun src/index.ts
```

### Build

```bash
bun build src/index.ts --outdir dist
```

### Type Check

```bash
bun run check
```

### Formatting

```bash
bunx prettier --write "**/*.{ts,json,md}"
```

## License

ISC
