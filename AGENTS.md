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

A Bun terminal UI app that connects to an OpenCode (V2) background service via `@opencode/client`.

- **Entry point**: `src/index.ts` — connects to the OpenCode service, creates/resumes session, enters raw terminal mode
- **`src/opencode.ts`** — discovers/starts the shared OpenCode background service (`Service.ensure()`) and builds the V2 client
- **`src/server.ts`** — V2 event stream processing, message sending, rendering pipeline. Consumes granular events like `session.text.delta`, `session.tool.called`, `session.execution.succeeded`, `permission.asked`, `form.created`
- **`src/input.ts`** — Raw keypress handling (readline), slash commands, file `@`-completion
- **`src/render.ts`** — ANSI escape code rendering, incremental display updates, animation
- **`src/commands/`** — Each slash command is a separate module exporting a `Command` object
- **`src/types.ts`** — `State` (mutable singleton passed to all handlers), `Command`, `AccumulatedPart`
- **`src/config.ts`** — Config at `~/.config/opencode-miniterm/opencode-miniterm.json`, overridable via `OPENCODE_MT_CONFIG_CONTENT` env var

Key dependencies: `@opencode/client` (V2 OpenCode HTTP client + local service discovery), `allmark` (markdown rendering).

The app uses stdin raw mode with manual ANSI escape code output — no terminal framework (no Ink, Blessed, etc.).

## Gotchas

- **`verbatimModuleSyntax: true`** in tsconfig — always use `import type` for type-only imports
- **V2 server API** (`@opencode/client`): the V2 server only exposes `/api/*`; the V1 `@opencode-ai/sdk` endpoints (`/session`, `/event`, `/config/providers`) no longer work
- **Service discovery**: V2 runs a shared background service on a random port, discovered via `Service.ensure()` — never hardcode a host/port
- **Location scoping**: pass `location: { directory }` to endpoints that accept it (session create, agent/provider/model lists, file find)
- **Model/agent are session-level** in V2 — call `session.switchModel()` / `session.switchAgent()` (there is no per-prompt `model` field)
- **Turn end** is `session.execution.succeeded` / `failed` / `interrupted`, not `session.idle` (V2 does not emit idle for a locally-started turn)
- **Granular event stream**: text/reasoning/tools stream as `session.text.started|delta|ended`, `session.reasoning.*`, `session.tool.input.started`, `session.tool.called`, `session.tool.success|failed` — not cumulative `message.part.updated` snapshots
- **The shell tool is named `shell`** (V1 called it `bash`)
- **Questions are V2 forms**: `form.created` → answer with `session.form.reply({ answer: { [fieldKey]: value } })`. Permissions: `permission.asked` → `permission.reply({ decision: "once" | "always" | "reject" })`
- **Subagents** create child sessions (`session.created` with `parentID`); child events are routed into a compact box
- **Client methods throw** on error (no `.error` result field)
- Config env override `OPENCODE_MT_CONFIG_CONTENT` takes priority over the config file

## Conventions

- Tabs for indentation (per `.prettierrc`)
- Import sorting via `@trivago/prettier-plugin-sort-imports`
- No comments in code unless asked
- Tests in `test/` directory, importing directly from `src/`
- Tests use `bun:test` (`describe`, `it`, `expect`, `spyOn`, `vi`, `beforeEach`, `afterEach`)
- Tests mock `process.stdout.write` and `process.stdout.columns` for terminal output
- `tmp/` directory for temporary files (gitignored)
