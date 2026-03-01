# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

See [docs/architecture.md](docs/architecture.md) for system design, data flow, and critical constraints.
See [docs/communication.md](docs/communication.md) for frontend↔backend and backend↔tmux communication protocols.
See [docs/non-goals.md](docs/non-goals.md) for what tmuxy intentionally does NOT do.
See [docs/rich-rendering.md](docs/rich-rendering.md) for terminal image/OSC protocol support.
See [docs/e2e-test-scenarios.md](docs/e2e-test-scenarios.md) for comprehensive test coverage planning.
See [docs/tests.md](docs/tests.md) for running and writing E2E tests.
See [docs/copy-mode.md](docs/copy-mode.md) for the client-side copy mode architecture.
See [docs/tmux.md](docs/tmux.md) for tmux version-specific bugs and workarounds.

## Project Structure

```
tmuxy/
├── packages/
│   ├── tmuxy-core/           # Rust: tmux control mode, parsing, state
│   ├── tmuxy-server/         # Rust: production server with embedded frontend
│   ├── web-server/           # Rust: shared Axum routes and SSE handlers
│   ├── tmuxy-ui/             # React/Vite frontend
│   │   └── src/tmux/demo/    # In-browser demo engine (DemoAdapter, DemoTmux, DemoShell)
│   ├── tmuxy-landing-page/   # Next.js landing page (static export → GitHub Pages)
│   └── tauri-app/            # Tauri desktop app wrapper
├── scripts/
│   ├── tmuxy-cli              # Shell dispatcher (symlinked as ~/.local/bin/tmuxy)
│   └── tmuxy/                 # Shell scripts for floats, groups, widgets
├── tests/                    # E2E tests (Jest + Playwright)
│   ├── helpers/              # One file per helper function
│   └── *.test.js             # Test suites grouped by operation
├── docs/                     # Project documentation
└── docker/                   # Docker development environment
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

**All tmux commands must go through the control mode stdin connection**, not via external subprocess calls. Running external `tmux` commands while control mode is attached crashes tmux 3.5a. See [docs/tmux.md](docs/tmux.md) for version-specific workarounds.

Use short command forms: `splitw`, `selectp`, `killp`, `resizep`, etc. **Exception:** `neww` crashes tmux 3.5a — always use `splitw ; breakp` instead (the server rewrites this automatically).

Use `adapter.invoke('run_tmux_command', { command: '...' })` for all tmux operations from the frontend. See `tmuxy-ui/src/tmux/HttpAdapter.ts` for the adapter implementation and [docs/communication.md](docs/communication.md) for the SSE/HTTP protocol details.

## E2E Test Conventions

- Tests use `createTestContext()` from `tests/helpers/test-setup.js` for shared setup/teardown.
- All E2E tests run **sequentially** (`maxWorkers: 1`) — they share one tmux server.
- Tests interact with the **browser UI** (keyboard events, page queries), not tmux directly. State assertions read from the XState machine context via `page.evaluate()`.
- Copy mode is a client-side reimplementation — test it via browser keyboard events and `getCopyModeState()`, not `send-keys -X` tmux commands.
- Never install Playwright browsers (`npx playwright install`). Tests connect to Chrome via CDP on port 9222, or use the pre-installed Chromium in `~/.cache/ms-playwright/`.

## Testing & Bug Fixes (Critical)

**ALWAYS fix any test failure or bug you encounter, even if it is unrelated to your current task or predates your changes.** Do not skip, ignore, or defer broken tests. If CI is red, make it green before moving on. A failing test is never "someone else's problem" — if you see it, you own it. This applies to unit tests, E2E tests, linting errors, type errors, and any other validation failures.

**NEVER commit skipped tests** (`it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, `xdescribe`). If a test is failing, either fix the test, fix the underlying bug, or ask the user whether to remove the test entirely. ESLint enforces this via `jest/no-disabled-tests` (error) — the pre-commit hook and CI will reject skipped tests.

## Documentation

The `docs/` directory contains architectural and design documentation. **Review relevant docs before and after working on a task** — they provide critical context (especially `tmux.md`, `communication.md`, and `copy-mode.md`).

- **Before starting**: read docs related to the area you're changing. Flag any misalignment between the docs and the user's request before proceeding.
- **After finishing**: if your changes affect behavior described in docs, suggest updates to the user.
- **No project-specific code in docs**: docs should describe architecture, protocols, and conventions in prose and tables — not inline code snippets from the codebase. Code is fragile and changes constantly; docs that embed it go stale immediately. Reference file paths instead (e.g., "see `web-server/src/lib.rs`").

## Git

When working on a branch other than `main`, always `git merge main` before starting work to avoid future conflicts.

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
