# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

See [docs/architecture.md](docs/architecture.md) for system design, data flow, and critical constraints.
See [docs/communication.md](docs/communication.md) for frontend↔backend and backend↔tmux communication protocols.
See [docs/non-goals.md](docs/non-goals.md) for what tmuxy intentionally does NOT do.
See [docs/rich-rendering.md](docs/rich-rendering.md) for terminal image/OSC protocol support.
See [docs/e2e-test-scenarios.md](docs/e2e-test-scenarios.md) for comprehensive test coverage planning.
See [docs/tests.md](docs/tests.md) for running and writing E2E tests.

## Project Structure

```
tmuxy/
├── packages/
│   ├── tmuxy-core/      # Rust: tmux control mode, parsing, state
│   ├── tmuxy-server/    # Rust: production server with embedded frontend
│   ├── web-server/      # Rust: shared Axum routes and SSE handlers
│   ├── tmuxy-ui/        # React/Vite frontend
│   └── tauri-app/       # Tauri desktop app wrapper
├── scripts/
│   ├── tmuxy-cli        # Shell dispatcher (symlinked as ~/.local/bin/tmuxy)
│   └── tmuxy/           # Shell scripts for floats, groups, widgets
├── tests/               # E2E tests (Jest + Playwright)
│   ├── helpers/         # One file per helper function
│   └── *.test.js        # Test suites grouped by operation
├── docs/                # Project documentation
└── docker/              # Docker development environment
```

## CLI Usage

The `tmuxy` CLI is a shell dispatcher at `scripts/tmuxy-cli`, symlinked as `~/.local/bin/tmuxy`.

```bash
tmuxy float                    # Interactive float (outputs pane ID)
tmuxy float fzf                # Run fzf in float, capture stdout
tmuxy group add                # Add current pane to a group
tmuxy group next               # Next tab in group
tmuxy group prev               # Previous tab in group
tmuxy group switch %5          # Switch to specific pane in group
tmuxy group close [%5]         # Close pane from group
tmuxy image /path/to/img.png   # Display image widget
tmuxy md README.md             # Display markdown widget
echo "# Hello" | tmuxy md -   # Markdown from stdin
tmuxy server                   # Start production server
tmuxy server stop              # Stop production server
```

## Development

```bash
npm start               # Start dev server (pm2 + cargo-watch)
npm run stop            # Stop dev server
npm test                # Unit tests (Vitest)
npm run test:e2e        # E2E tests (requires server + Chrome CDP)
```

## Devcontainer

| Variable | Description |
|----------|-------------|
| `CONTAINER_NAME` | Container name (e.g., `tmuxy-worktree-1`) |
| `HOST_PORT` | Port exposed on the host (e.g., `14089`) |
| `PORT` | Internal server port (`9000`) |

## Coding Guidelines

### General

1. **No legacy code** - Remove dead code immediately. No commented-out code, no unused imports.
2. **No "not doing" comments** - Comments explain what code does, not what it doesn't do.
3. **DRY** - Extract repeated logic. If you write similar code twice, refactor it.
4. **Modular helpers** - Test helpers in `helpers/` directory, organized by domain.
5. **Never modify ESLint rules** - Do not disable, remove, or weaken any ESLint rule. Do not add `eslint-disable` comments. If the user asks to disable or remove a rule, ask "Are you sure?" before proceeding.

### React + XState

1. **Avoid `useEffect`** - Side effects belong in the state machine, not components.
2. **Components are for rendering** - Business logic goes in XState machines.
3. **Derive, don't sync** - Derive values from state instead of syncing with `useEffect`.

### Tmux Control Mode (Critical)

**All tmux commands must go through the control mode stdin connection**, not via external subprocess calls. Running external `tmux` commands while control mode is attached crashes tmux 3.3a.

Use short command forms: `neww`, `splitw`, `selectp`, `killp`, `resizep`, etc.

Use `run_tmux_command` for all tmux operations from the frontend:
```typescript
await invoke('run_tmux_command', { command: 'swap-pane -s %0 -t %1' });
```

### SSE Protocol

```typescript
// Client sends
{ "type": "invoke", "id": "uuid", "cmd": "command_name", "args": {...} }

// Server responds
{ "type": "response", "id": "uuid", "result": ... }
{ "type": "error", "id": "uuid", "error": "message" }

// Server pushes state
{ "type": "event", "name": "tmux-state-update", "payload": {...} }
```

## Testing & Bug Fixes (Critical)

**ALWAYS fix any test failure or bug you encounter, even if it is unrelated to your current task or predates your changes.** Do not skip, ignore, or defer broken tests. If CI is red, make it green before moving on. A failing test is never "someone else's problem" — if you see it, you own it. This applies to unit tests, E2E tests, linting errors, type errors, and any other validation failures.

**NEVER commit skipped tests** (`it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, `xdescribe`). If a test is failing, either fix the test, fix the underlying bug, or ask the user whether to remove the test entirely. ESLint enforces this via `jest/no-disabled-tests` (error) — the pre-commit hook and CI will reject skipped tests.

## Git

Use [gitmoji](https://gitmoji.dev/) for commit messages:

| Emoji | Description |
|-------|-------------|
| ✨ | New feature |
| 🐛 | Bug fix |
| ♻️ | Refactor |
| 🎨 | Improve structure/format |
| ⚡ | Performance |
| 🔥 | Remove code/files |
| ✅ | Tests |
| 📝 | Documentation |
| 🔧 | Configuration |
