# OpenCode Miniterm - Agent Guidelines

## Commands

```bash
bun run dev            # Run the app
bun run check          # Typecheck (uses tsgo, NOT tsc)
bun test               # Run all tests
bun test test/input.test.ts   # Run a single test file
bun run test:tmux      # Tmux readline integration test
bunx prettier --write "**/*.{ts,json,md}"  # Format (no lint tool configured)
```

**Typecheck uses `tsgo`** (from `@typescript/native-preview`), not `tsc`. The `bun run check` script runs `tsgo --noEmit`. Running `tsc --noEmit` will fail or produce different results.

No ESLint or other linter is configured. Prettier is the only formatter.

## Architecture

A Bun terminal UI app that connects to an OpenCode headless server via `@opencode-ai/sdk`.

- **Entry point**: `src/index.ts` — starts server, creates/resumes session, enters raw terminal mode
- **`src/server.ts`** — SSE event stream processing, message sending, rendering pipeline. Handles events like `message.part.updated`, `session.diff`, `todo.updated`, `permission.asked`, `question.asked`
- **`src/input.ts`** — Raw keypress handling (readline), slash commands, file `@`-completion
- **`src/render.ts`** — ANSI escape code rendering, incremental display updates, animation
- **`src/commands/`** — Each slash command is a separate module exporting a `Command` object
- **`src/types.ts`** — `State` (mutable singleton passed to all handlers), `Command`, `AccumulatedPart`
- **`src/config.ts`** — Config at `~/.config/opencode-miniterm/opencode-miniterm.json`, overridable via `OPENCODE_MT_CONFIG_CONTENT` env var

Key dependencies: `@opencode-ai/sdk` (OpenCode client + server + types), `allmark` (markdown rendering).

The app uses stdin raw mode with manual ANSI escape code output — no terminal framework (no Ink, Blessed, etc.).

## Gotchas

- **`verbatimModuleSyntax: true`** in tsconfig — always use `import type` for type-only imports
- **Part types** from the SDK are: `step-start`, `reasoning`, `text`, `step-finish`, `tool` (not `tool_use`/`tool_result`)
- **`model` field is required** on `session.prompt()` calls — omitting it causes the request to hang
- **`/models` SDK route returns HTML**, not JSON — use `/config/providers` for programmatic model info
- SSE event delta is at `event.properties.delta` (not nested under `.part`)
- `processing` flag in `server.ts` controls whether `text` parts render (toggled by `step-start`)
- Some event types aren't in the SDK types yet — handled via `(event as any).type` casts (e.g., `question.asked`, `permission.asked`)
- Config env override `OPENCODE_MT_CONFIG_CONTENT` takes priority over the config file

## Conventions

- Tabs for indentation (per `.prettierrc`)
- Import sorting via `@trivago/prettier-plugin-sort-imports`
- No comments in code unless asked
- Tests in `test/` directory, importing directly from `src/`
- Tests use `bun:test` (`describe`, `it`, `expect`, `spyOn`, `vi`, `beforeEach`, `afterEach`)
- Tests mock `process.stdout.write` and `process.stdout.columns` for terminal output
- `tmp/` directory for temporary files (gitignored)
