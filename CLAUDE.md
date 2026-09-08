# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

**This project is under active development, not production.** Breaking changes are welcome. No backwards compatibility required — delete, rename, and restructure freely.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for high-level system overview and component interaction.
See [docs/STATE-MANAGEMENT.md](docs/STATE-MANAGEMENT.md) for frontend XState and backend Rust state details.
See [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for SSE/HTTP protocol, Tauri IPC, and deployment scenarios.
See [docs/TMUX.md](docs/TMUX.md) for control mode routing, version-specific bugs, workarounds, and the `@tmuxy-*` window/pane tag schema.
See [docs/COPY-MODE.md](docs/COPY-MODE.md) for the client-side scrollback rendering and native browser scrolling in copy mode.
See [docs/SECURITY.md](docs/SECURITY.md) for security risks, mitigations, and deployment warnings.
See [docs/TESTS.md](docs/TESTS.md) for testing guidelines and principles.
See [docs/NON-GOALS.md](docs/NON-GOALS.md) for what tmuxy intentionally does NOT do.
See [docs/RICH-RENDERING.md](docs/RICH-RENDERING.md) for terminal image/OSC protocol support.
See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for speed measurement: core/render processing (Axis A) vs transport (Axis B).
See [docs/TELEMETRY.md](docs/TELEMETRY.md) for unified cross-layer action tracing into a single local NDJSON file (design: schema, seams, redaction boundary, phased plan).

## CLI Usage

The `tmuxy` CLI is a noun-verb dispatcher at `bin/tmuxy-cli`, symlinked as `~/.local/bin/tmuxy`.
All mutating commands route through `tmux run-shell` for safety with control mode.

Run `tmuxy --help`, `tmuxy <command> --help`, or `tmuxy <command> <subcommand> --help` for details.

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

## Test Guidelines

**Read [docs/TESTS.md](docs/TESTS.md) before writing, reviewing, or modifying any test.** Every time you touch test code, check your work against those guidelines. Flag any test that violates them — even pre-existing tests. If you see a test asserting DOM state without visual verification, or using adapter calls instead of user paths, call it out and suggest a fix.

Key rules:

- **Test what the user sees, not what the DOM contains.** An element in the DOM but clipped by `overflow: hidden` is not visible. Always verify bounding rects, not just element existence or `textContent`.
- **Use real user paths.** If a user creates a float by typing `tmuxy pane float`, the test should type that command — not call `_exec('break-pane')`. Adapter calls skip the entire chain where bugs live.
- **One feature, one test.** Cover create → verify visible → interact → close in a single test. Do not split into separate "check state" and "check DOM" tests.
- **Never install Playwright browsers locally** (`npx playwright install`). In the dev environment, tests connect to an existing Chrome via CDP on port 9222. (CI is the exception: its workflows provision their own chromium because the runners start empty.)
- All E2E tests run **sequentially** (`maxWorkers: 1`) — they share one tmux server.
- Scrollback is a client-side reimplementation with **two views** over one engine (`copyModeStates[paneId].mode`): the native-like `scroll` view a wheel/touch scroll opens (no cursor, browser selection, tmux never told) and tmux's `copy` mode from `prefix [` (cursor, vi keys, cell selection). Both render in `ScrollbackTerminal` and fetch history on demand. Drive them via real user input (`prefix [` and vi keys for copy mode; wheel/touch for the scroll view) and assert on the rendered scrollback and on the client engine via `getCopyModeState()` (reads `copyModeStates[paneId]`: mode, loaded lines, cursor, selection, scrollTop) — not `send-keys -X` tmux commands. Selecting text outside copy mode is the browser's own selection, so assert it with `window.getSelection()`, and never re-add a mouse path that opens copy mode. See docs/COPY-MODE.md.

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

**Stage files explicitly — never `git add -A`.**

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
| 🚀 | Version bump / release |

The release process lives in the `release` skill (`.claude/skills/release/`) — invoke it when shipping a version.
