# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

**This project is under active development, not production.** Breaking changes are welcome. No backwards compatibility required — delete, rename, and restructure freely.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for high-level system overview and component interaction.
See [docs/STATE-MANAGEMENT.md](docs/STATE-MANAGEMENT.md) for frontend XState and backend Rust state details.
See [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for SSE/HTTP protocol, Tauri IPC, and deployment scenarios.
See [docs/TMUX.md](docs/TMUX.md) for control mode routing, version-specific bugs, and workarounds.
See [docs/COPY-MODE.md](docs/COPY-MODE.md) for the client-side copy mode architecture.
See [docs/SECURITY.md](docs/SECURITY.md) for security risks, mitigations, and deployment warnings.
See [docs/TESTS.md](docs/TESTS.md) for running and writing E2E tests.
See [docs/E2E-TEST-SCENARIOS.md](docs/E2E-TEST-SCENARIOS.md) for comprehensive test coverage planning.
See [docs/NON-GOALS.md](docs/NON-GOALS.md) for what tmuxy intentionally does NOT do.
See [docs/RICH-RENDERING.md](docs/RICH-RENDERING.md) for terminal image/OSC protocol support.

## Project Structure

```
tmuxy/
├── packages/
│   ├── tmuxy-core/           # Rust: tmux control mode, parsing, state
│   ├── tmuxy-server/         # Rust: server (SSE, HTTP, embedded frontend, dev mode)
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

The `tmuxy` CLI is a noun-verb dispatcher at `scripts/tmuxy-cli`, symlinked as `~/.local/bin/tmuxy`.
All mutating commands route through `tmux run-shell` for safety with control mode.

```bash
# Pane operations
tmuxy pane list [--json] [--all]       # List panes
tmuxy pane split [-h|-v]               # Split current pane
tmuxy pane kill [%id]                  # Kill pane
tmuxy pane select [-U|-D|-L|-R|%id]    # Select pane
tmuxy pane resize [-U|-D|-L|-R] [n]    # Resize pane
tmuxy pane swap %0 %1                  # Swap two panes
tmuxy pane zoom                        # Toggle zoom
tmuxy pane break                       # Break pane into own tab
tmuxy pane capture [%id] [--json]      # Capture pane content
tmuxy pane send ls Enter               # Send keys to pane
tmuxy pane paste "some text"           # Paste text into pane
tmuxy pane float [cmd args...]         # Create a float pane
tmuxy pane group add                   # Add pane to a group
tmuxy pane group close [%id]           # Close pane from group
tmuxy pane group switch %5             # Switch to pane in group
tmuxy pane group next                  # Next pane in group
tmuxy pane group prev                  # Previous pane in group

# Tab operations
tmuxy tab list [--json]                # List tabs
tmuxy tab create [name]                # Create tab (safe splitw+breakp)
tmuxy tab kill [@id]                   # Kill tab
tmuxy tab select <index|@id>           # Switch to tab
tmuxy tab next                         # Next tab
tmuxy tab prev                         # Previous tab
tmuxy tab rename <name>                # Rename current tab
tmuxy tab layout [next|even-h|...]     # Change pane layout

# Widgets
tmuxy widget image /path/to/img.png    # Display image widget
tmuxy widget markdown README.md        # Display markdown widget
echo "# Hello" | tmuxy widget markdown - # Markdown from stdin

# Escape hatch (routes safely through run-shell)
tmuxy run swap-pane -s %0 -t %1       # Run any tmux command safely
tmuxy run new-window                   # Intercepted → splitw+breakp
tmuxy run resize-window                # Blocked (crashes control mode)

# Server
tmuxy server                           # Start production server
tmuxy server stop                      # Stop production server
```

Run `tmuxy --help`, `tmuxy <command> --help`, or `tmuxy <command> <subcommand> --help` for details.

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

**All tmux commands must go through the control mode stdin connection**, not via external subprocess calls. Running external `tmux` commands while control mode is attached crashes tmux 3.5a. See [docs/TMUX.md](docs/TMUX.md) for version-specific workarounds.

Use short command forms: `splitw`, `selectp`, `killp`, `resizep`, etc. **Exception:** `neww` crashes tmux 3.5a — always use `splitw ; breakp` instead (the server rewrites this automatically).

Use `adapter.invoke('run_tmux_command', { command: '...' })` for all tmux operations from the frontend. See `tmuxy-ui/src/tmux/adapters.ts` for the adapter implementations and [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the SSE/HTTP protocol details.

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

The `docs/` directory contains architectural and design documentation. **Review relevant docs before and after working on a task** — they provide critical context (especially `TMUX.md`, `STATE-MANAGEMENT.md`, `DATA-FLOW.md`, and `COPY-MODE.md`).

- **Before starting**: read docs related to the area you're changing. Flag any misalignment between the docs and the user's request before proceeding.
- **After finishing**: if your changes affect behavior described in docs, suggest updates to the user.
- **No project-specific code in docs**: docs should describe architecture, protocols, and conventions in prose and tables — not inline code snippets from the codebase. Code is fragile and changes constantly; docs that embed it go stale immediately. Reference file paths instead (e.g., "see `tmuxy-server/src/state.rs`").
- **Use ASCII diagrams, not Mermaid**: diagrams in docs should use plain ASCII art inside fenced code blocks. Mermaid requires a renderer and is not universally supported by all markdown viewers or AI agents.

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
