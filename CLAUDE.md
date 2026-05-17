# Tmuxy

A web-based tmux interface built with React (Vite) frontend and Rust backend.

**This project is under active development, not production.** Breaking changes are welcome. No backwards compatibility required — delete, rename, and restructure freely.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for high-level system overview and component interaction.
See [docs/STATE-MANAGEMENT.md](docs/STATE-MANAGEMENT.md) for frontend XState and backend Rust state details.
See [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for SSE/HTTP protocol, Tauri IPC, and deployment scenarios.
See [docs/TMUX.md](docs/TMUX.md) for control mode routing, version-specific bugs, and workarounds.
See [docs/COPY-MODE.md](docs/COPY-MODE.md) for the client-side copy mode architecture.
See [docs/SECURITY.md](docs/SECURITY.md) for security risks, mitigations, and deployment warnings.
See [docs/TESTS.md](docs/TESTS.md) for testing guidelines and principles.
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
│   ├── tmuxy-demo/           # Next.js demo site (static export → GitHub Pages)
│   └── tauri-app/            # Tauri desktop app wrapper
├── bin/
│   ├── tmuxy-cli              # Shell dispatcher (symlinked as ~/.local/bin/tmuxy)
│   └── tmuxy/                 # Shell scripts for floats, groups, widgets
├── tests/                    # E2E tests (Jest + Playwright)
│   ├── helpers/              # One file per helper function
│   └── *.test.js             # Test suites grouped by operation
└── docs/                     # Project documentation
```

## CLI Usage

The `tmuxy` CLI is a noun-verb dispatcher at `bin/tmuxy-cli`, symlinked as `~/.local/bin/tmuxy`.
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

# Event queue (inter-agent coordination)
tmuxy event emit <name> <msg|->        # Publish message (- for stdin)
tmuxy event wait <name>                # Block until message arrives
tmuxy event list                       # Show pending events

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

## Test Guidelines

**Read [docs/TESTS.md](docs/TESTS.md) before writing, reviewing, or modifying any test.** Every time you touch test code, check your work against those guidelines. Flag any test that violates them — even pre-existing tests. If you see a test asserting DOM state without visual verification, or using adapter calls instead of user paths, call it out and suggest a fix.

Key rules:

- **Test what the user sees, not what the DOM contains.** An element in the DOM but clipped by `overflow: hidden` is not visible. Always verify bounding rects, not just element existence or `textContent`.
- **Use real user paths.** If a user creates a float by typing `tmuxy pane float`, the test should type that command — not call `_exec('break-pane')`. Adapter calls skip the entire chain where bugs live.
- **One feature, one test.** Cover create → verify visible → interact → close in a single test. Do not split into separate "check state" and "check DOM" tests.
- **Never install Playwright browsers** (`npx playwright install`). Tests connect to Chrome via CDP on port 9222.
- All E2E tests run **sequentially** (`maxWorkers: 1`) — they share one tmux server.
- Copy mode is a client-side reimplementation — test it via browser keyboard events and `getCopyModeState()`, not `send-keys -X` tmux commands.

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
| 🚀 | Version bump / release |

## Release Workflow (Critical)

The full ship sequence — from a green main commit all the way to a Homebrew-installable release. Each step must succeed before the next; never tag ahead of CI.

### 1. Land the change on main
Stage files explicitly (never `git add -A`), commit with a gitmoji prefix, push to `origin/main`. CI runs three workflows: `lint and tests`, `Build App`, `Deploy Demo`. The `Build App` workflow on a non-tag push builds and uploads artifacts but **skips** the `release` and `bump-cask` jobs — those are tag-gated.

### 2. Wait for CI green on the change commit
Poll with `gh run list --commit <SHA> --json name,status,conclusion`. All three must be `success` before proceeding. If `lint and tests` fails on something pre-existing (e.g., `cargo fmt --check` drift in a file you didn't touch), fix it as a separate commit per the "Testing & Bug Fixes" rule above.

### 3. Bump the version
The next version is the existing version with the alpha number incremented. Update **all** of these to keep the workspace consistent:

- `Cargo.toml` (workspace.package.version)
- `package.json` (root)
- `packages/tmuxy-ui/package.json`
- `packages/tmuxy-demo/package.json`
- `packages/tauri-app/tauri.conf.json` (literal — Tauri 2 forbids templating; `packages/tauri-app/build.rs` auto-syncs from `Cargo.toml` at build time, but commit the synced value explicitly so the tag is reproducible without a build step)
- `Cargo.lock` — regenerate with `cargo build -p tmuxy-server`

Commit as `🚀 v<new-version>` with no body. Same 6 files as every prior version bump — check `git show v<previous-version> --stat` to confirm the pattern.

**Heads-up:** stopping `tmuxy-dev` in pm2 first (`pm2 stop tmuxy-dev`) avoids transient `Permission denied` errors when `cargo build` races the dev-mode binary.

### 4. Tag and push
```
git tag v<new-version> <commit-sha>
git push origin main
git push origin v<new-version>
```
Order matters: push main first so the tag's commit is on the remote when the tag arrives.

### 5. Wait for tag-triggered Build App run
Pushing the tag triggers a **second** `Build App` run (this one with `github.ref = refs/tags/v...`). This run executes `build` → `release` → `bump-cask`. Watch it with `gh run list --workflow build-app.yml --limit 5` — the new row has `head_branch = v<new-version>`.

- The `release` job downloads the build artifacts and creates a GitHub Release with `tmuxy_<version>_amd64.AppImage`, `tmuxy_<version>_amd64.deb`, and `tmuxy_<version>_universal.dmg` attached.
- The `bump-cask` job downloads the `.dmg`, computes sha256, and pushes an updated `Casks/tmuxy.rb` to `flplima/homebrew-tap`.

**This run is what makes `brew install --cask flplima/tap/tmuxy` pick up the new version.** Until it finishes green, the brew cask still points at the previous tag.

### 6. Verify brew is ready
- `gh release view v<new-version>` should list 3 assets (`.AppImage`, `.deb`, `.dmg`).
- The latest commit on `flplima/homebrew-tap` should be `chore: bump tmuxy to v<new-version>`.
- A user running `brew update && brew upgrade --cask flplima/tap/tmuxy` should now get the new build.

### Common failures
- **Linux build hangs on `npm install`** — runner-side flake. Cancel the hung run (`gh run cancel <id>`) and re-run the workflow (`gh run rerun <id>` or push an empty commit on the tag — simpler is to delete + repush the tag, but that requires `--force` on the second push, so prefer rerun).
- **`cargo fmt --check` fails on a pre-existing file** — run `cargo fmt -p <crate>`, commit the result as `🎨 cargo fmt <path>` before the version bump, and re-wait for CI.
- **Tag-triggered run starts but `release` job is skipped** — the tag wasn't pushed (only the commit was). Confirm with `git ls-remote --tags origin`.
- **`bump-cask` fails with "already at v..."** — benign; means a previous run already pushed the cask update. Brew is ready.
