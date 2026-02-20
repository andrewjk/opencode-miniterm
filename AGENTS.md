# OpenCode MiniTerm - Agent Guidelines

## Build & Development Commands

### Run the application
```bash
bun run src/index.ts
# Or just:
bun src/index.ts
```

### Build (when bundler is added)
```bash
bun build src/index.ts --outdir dist
```

### Testing
No test framework is currently configured. Add one of these to package.json:
- **Bun Test**: `bun test` (recommended - built-in, fast)
- **Jest**: `npm test` or `bun run test`
- **Vitest**: `vitest`

To run a single test (once configured):
- Bun Test: `bun test --test-name-pattern "testName"`
- Jest: `npm test -- testName`
- Vitest: `vitest run testName`

### Linting & Formatting (recommended additions)
Install and configure these tools:
```bash
bun add -d eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier
```

Commands to add to package.json:
```json
{
  "lint": "eslint src --ext .ts",
  "lint:fix": "eslint src --ext .ts --fix",
  "format": "prettier --write \"src/**/*.ts\"",
  "format:check": "prettier --check \"src/**/*.ts\"",
  "typecheck": "tsc --noEmit"
}
```

## Code Style Guidelines

### TypeScript Configuration
- Use strict mode: `"strict": true` in tsconfig.json
- Target ES2022+ for modern Node/Bun features
- Use `moduleResolution: "bundler"` for Bun compatibility

### Imports
- Use ES6 imports (ESM): `import { something } from 'module'`
- Group imports in this order:
  1. Node/Bun built-ins
  2. External packages
  3. Internal modules
- Use absolute imports where possible (configure path aliases in tsconfig.json)
- Avoid default exports; prefer named exports for better tree-shaking

### Formatting
- Use 2 spaces for indentation
- Use single quotes for strings
- Use semicolons at end of statements
- Maximum line length: 100 characters
- Trailing commas in multi-line arrays/objects
- Spaces around operators: `a = b + c` not `a=b+c`

### Types & Type Safety
- Always provide explicit return types for functions
- Use `interface` for object shapes, `type` for unions/primitives
- Avoid `any`; use `unknown` when type is truly unknown
- Use type guards for runtime type checking
- Leverage Bun's built-in type definitions (from `bun-types`)

### Naming Conventions
- **Files**: kebab-case: `my-service.ts`
- **Variables/Functions**: camelCase: `myFunction`
- **Classes**: PascalCase: `MyService`
- **Constants**: UPPER_SNAKE_CASE for global constants: `MAX_RETRIES`
- **Private members**: Leading underscore: `_privateMethod`
- **Types/Interfaces**: PascalCase, often with suffixes: `UserService`, `ConfigOptions`

### Error Handling
- Use try/catch for async operations
- Create custom error classes for domain-specific errors:
  ```ts
  class TerminalError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'TerminalError';
    }
  }
  ```
- Always include error context in error messages
- Log errors appropriately (avoid logging secrets)
- Never swallow errors silently

### Async/Promise Handling
- Use async/await over .then()/.catch()
- Handle promise rejections: `process.on('unhandledRejection')`
- Use Bun's optimized APIs where available (e.g., `Bun.file()`)
- Implement timeouts for network requests

### Code Organization
- Structure by feature/domain, not by file type
- Keep files focused: one responsibility per file
- Export at file end; avoid export分散
- Use barrel files (`index.ts`) for cleaner imports

### Comments
- Use JSDoc for public APIs: `/** @description ... */`
- Comment WHY, not WHAT
- Keep comments current with code changes
- Avoid inline comments for obvious logic

### Performance (Bun-Specific)
- Leverage Bun's fast I/O: `Bun.write()`, `Bun.file()`
- Use `TextEncoder`/`TextDecoder` for encoding
- Prefer native over polyfills
- Benchmark before optimizing

## Project Context

This is an alternative terminal UI for OpenCode. Focus on:
- Fast, responsive terminal rendering
- Clean CLI UX with good error messages
- Efficient resource usage (memory/CPU)
- Compatibility with OpenCode's API

## OpenCode Server Integration

### Starting the Server
- Use `opencode serve` to start a headless HTTP server (not `opencode server`)
- Default URL: `http://127.0.0.1:4096` (port may vary, can be 0/random)
- Server requires 2-3 seconds to initialize before accepting requests
- Spawn with `stdio: ['ignore', 'pipe', 'pipe']` to avoid interfering with parent I/O
- Always handle SIGINT to properly shut down the server process

### Authentication
- Server may require HTTP Basic Auth if `OPENCODE_SERVER_PASSWORD` is set
- Username: `OPENCODE_SERVER_USERNAME` env var (default: 'opencode')
- Password: `OPENCODE_SERVER_PASSWORD` env var
- Include `Authorization: Basic <base64(username:password)>` header when password is set
- Include `Content-Type: application/json` header for all POST requests

### Creating Sessions
```ts
POST /session
Headers: { "Content-Type": "application/json", "Authorization": "Basic <creds>" }
Body: {}
Response: { id: string, title?: string, ... }
```

### Sending Messages
```ts
POST /session/:id/message
Headers: { "Content-Type": "application/json", "Authorization": "Basic <creds>" }
Body: {
  model: {
    modelID: 'big-pickle',
    providerID: 'opencode'
  },
  parts: [{ type: 'text', text: 'your message here' }]
}
Response: { info: Message, parts: Part[] }
```

**IMPORTANT**: The `model` field is required when sending messages. Without it, the request will hang indefinitely. Get available models from `GET /config/providers` or `GET /models`. Common models:
- `big-pickle` (opencode provider) - default, high quality
- `glm-5-free` (opencode provider) - free GLM model
- `gpt-5-nano` (opencode provider) - fast GPT model

### Response Format
- Response has `{ info, parts }` structure
- Parts can be: `text`, `tool_use`, or `tool_result`
- Filter out `tool_use` and `tool_result` parts for display to user
- Text parts contain the AI's response

### Error Handling
- Server returns 401 Unauthorized when authentication is missing/invalid
- Handle connection errors (server may not be ready yet)
- Always parse error text from response for debugging
- Bun's fetch doesn't timeout by default - use AbortController for timeouts:
  ```ts
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeout);
  ```

## Safety Notes

- Never commit API keys, tokens, or secrets
- Validate all user inputs
- Sanitize terminal output to prevent injection
- Use environment variables for configuration