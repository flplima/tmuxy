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
See [docs/CI-TRIAGE.md](docs/CI-TRIAGE.md) for the failing-CI-job → local-command map.
See [docs/ARCHITECTURE-INDEX.md](docs/ARCHITECTURE-INDEX.md) for where a given concern lives in the tree.

## CLI Usage

The `tmuxy` CLI is a noun-verb dispatcher at `bin/tmuxy-cli`, symlinked as `~/.local/bin/tmuxy`.
All mutating commands route through `tmux run-shell` for safety with control mode.

Run `tmuxy --help`, `tmuxy <command> --help`, or `tmuxy <command> <subcommand> --help` for details.

## Running it

| Want | Do | Notes |
|---|---|---|
| The dev server | `npm start` (pm2), `npm stop`, `npm logs` | `bin/dev` = `cargo watch` + Vite HMR, port `9000`, tmux socket `tmuxy-dev` |
| A one-off server | `cargo run -p tmuxy-server -- --port 9000 --no-auth --dev` | No watcher, no pm2 — what to reach for when `cargo watch` is missing |
| Drive the app | `agent-browser --session <slug> open http://localhost:9000` | See its own skill for the command set |
| The trace | `jq` / `grep` over `~/.local/state/tmuxy/trace.ndjson` (macOS: `~/Library/Application Support/tmuxy/trace.ndjson`) | On by default in a dev build; see [docs/TELEMETRY.md](docs/TELEMETRY.md) |
| Server logs | `npm logs` (pm2), or the server's own stderr | `RUST_LOG` filters it |

**Three sockets, never mixed:** a released build serves `tmuxy`, the dev server
`tmuxy-dev`, the E2E suite `tmuxy-test`. A change of socket is a change of
server, which is how a test run cannot disturb the session you are working in.

Everything an agent needs on top of `npm ci` and a Rust toolchain is
`bin/install-dev-tools`, shared by the devcontainer image and the cloud agent's
runner so neither can drift from the other.

## Devcontainer

| Variable | Description |
|----------|-------------|
| `CONTAINER_NAME` | Container name (e.g., `tmuxy-worktree-1`) |
| `HOST_PORT` | Port exposed on the host (e.g., `14089`) |
| `PORT` | Internal server port (`9000`) |
| `CODESPACES` | Set by GitHub Codespaces; the credential-volume scripts no-op when present |

One `.devcontainer/` serves `bin/devcontainer` (plain Docker), VS Code Dev
Containers and GitHub Codespaces. **Never hardcode the workspace path** — every
script derives the repo root from its own location, because Codespaces picks the
path and ignores a custom `workspaceMount`. Anything essential must stay out of
`runArgs` (Codespaces ignores it). Shared start-up work belongs in
`.devcontainer/setup.sh`, which all hosts run.

Copilot's cloud agent uses none of this: it is an ephemeral runner that
bootstraps from `.github/workflows/copilot-setup-steps.yml` (custom images and
`devcontainer.json` are not supported there). Both hosts call
`bin/install-dev-tools` for the tooling on top, which is the only place that
list lives — add a tool there, not in one of them.

## Coding Guidelines

### General

1. **No legacy code** - Remove dead code immediately. No commented-out code, no unused imports.
2. **No "not doing" comments** - Comments explain what code does, not what it doesn't do.
3. **DRY** - Extract repeated logic. If you write similar code twice, refactor it.
4. **Modular helpers** - Test helpers in `helpers/` directory, organized by domain.
5. **Never modify ESLint rules** - Do not disable, remove, or weaken any ESLint rule. Do not add `eslint-disable` comments. If the user asks to disable or remove a rule, ask "Are you sure?" before proceeding.

### Tmux Control Mode (Critical)

**All tmux commands must go through the control mode stdin connection**, not via external subprocess calls. Running external `tmux` commands while control mode is attached crashes tmux 3.5a. See [docs/TMUX.md](docs/TMUX.md) for version-specific workarounds.

Use short command forms: `splitw`, `selectp`, `killp`, `resizep`, etc. **Exception:** `neww` crashes tmux 3.5a — always use `splitw ; breakp` instead (the server rewrites this automatically).

Use `adapter.invoke('run_tmux_command', { command: '...' })` for all tmux mutations from the frontend (fire-and-forget, resolves `null` on every transport) and `adapter.query(command)` when the command's output is needed — reads are answered in-band on the same connection (`RunCommandWithReply`). Never add a subprocess or shell path for a client command; the routing policy is `packages/tmuxy-core/src/command_router.rs` and both transports must call it. See `packages/tmuxy-ui/src/tmux/adapters.ts` for the adapter implementations and [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the SSE/HTTP protocol details.

## Test Guidelines

**Read [docs/TESTS.md](docs/TESTS.md) before writing, reviewing, or modifying any test.** Every time you touch test code, check your work against those guidelines. Flag any test that violates them — even pre-existing tests. If you see a test asserting DOM state without visual verification, or using adapter calls instead of user paths, call it out and suggest a fix.

Key rules:

- **Test what the user sees, not what the DOM contains.** An element in the DOM but clipped by `overflow: hidden` is not visible. Always verify bounding rects, not just element existence or `textContent`.
- **Use real user paths.** If a user creates a float by typing `tmuxy pane float`, the test should type that command — not call `_exec('break-pane')`. Adapter calls skip the entire chain where bugs live.
- **One feature, one test.** Cover create → verify visible → interact → close in a single test. Do not split into separate "check state" and "check DOM" tests.
- **Never install Playwright browsers locally** (`npx playwright install`). Tests connect to an existing Chrome via CDP on port 9222; point `TMUXY_CDP_PORT` at a closed port to make a run launch its own headless browser instead — the shape CI runs in. In a container the browser is the one `bin/install-dev-tools` provides, named by `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. (CI is the exception: its workflows provision their own chromium because the runners start empty.)
- All E2E tests run **sequentially** (`maxWorkers: 1`) — they share one tmux server.

## Testing & Bug Fixes (Critical)

**ALWAYS fix any test failure or bug you encounter, even if it is unrelated to your current task or predates your changes.** Do not skip, ignore, or defer broken tests. If CI is red, make it green before moving on. A failing test is never "someone else's problem" — if you see it, you own it. This applies to unit tests, E2E tests, linting errors, type errors, and any other validation failures.

**NEVER commit skipped tests** (`it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, `xdescribe`). If a test is failing, either fix the test, fix the underlying bug, or ask the user whether to remove the test entirely. ESLint enforces this via `jest/no-disabled-tests` (error) — the pre-commit hook and CI will reject skipped tests.

Before wrapping up a task, run local checks that mirror CI lint gates:
- `npm run check:fast`
- `(cd packages/tmuxy-ui && npx prettier --check src)`
- `npx prettier --check 'tests/**/*.js'`
- `npm run lint && npm run lint:tests && (cd packages/tmuxy-ui && npx tsc --noEmit)`

The rest of the map, for when a change reaches further:

| Scope | Command |
|---|---|
| First run in a fresh environment | `bash bin/bootstrap` |
| Everything, including Rust and the CLI | `npm run check:full` |
| E2E (browser + tmux) | `npm run test:e2e` |
| Desktop / Tauri E2E | `npm run test:tauri` |
| Rust workspace | `cargo test --workspace` |
| A red CI job | [docs/CI-TRIAGE.md](docs/CI-TRIAGE.md) maps each job to its local command |

### Before pushing: run the CI jobs your change touches

The lint gate above is the floor, not the bar. **Before `git push`, run the local
equivalent of every CI job your diff can break** — the ones it touches, not all of
them. `npm run check:full` is for a change that reaches everywhere; reaching for it
by default wastes twenty minutes, and reaching for nothing ships a red main.

Work out the set from what you changed:

| Changed | Also run before pushing |
|---|---|
| `packages/tmuxy-ui/src/**` (app code) | `npm test -- --run`, and the E2E suites covering the feature |
| `packages/tmuxy-ui/src/stories/**` | `npm run test-storybook -w tmuxy-ui` (add `test-storybook:v86` for a `v86`-tagged story) |
| `tests/**` | the suites you edited, **plus** any other suite sharing their helpers |
| `packages/tmuxy-core/**`, `tmuxy-server/**` | `cargo test --workspace`, `cargo clippy … -D warnings`, and the E2E suites for the behaviour |
| a `constants.rs` tmux format string | `cargo test --workspace` **and** E2E — the format is parsed at runtime, so no unit test sees a field shift |
| `bin/tmuxy-cli`, `scripts/**` | `npm run test:cli` |
| `packages/tmuxy-tauri-app/**` | `npm run test:tauri` |
| perf harnesses, `perf/**` | `npm run perf:interactions` + `npm run perf:compare` |

[docs/CI-TRIAGE.md](docs/CI-TRIAGE.md) has the full job-to-command map — it is the
source of truth for which command stands in for which job, and it works in both
directions: use it to pick checks before a push, not only to triage a red one.

**"It passed locally" is weak evidence for anything timing-sensitive.** A CI runner
is slower than a dev machine, so a wait that assumes something has already happened
passes here and fails there. When a test polls for state, treat "not ready yet" as
*keep waiting*, never as *done* — and never bound a loop by a constant that encodes
how fast the machine is, or by a magic number that happens to match today's layout.
A local pass cannot rule this class of bug out; only the shape of the wait can.

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

The release process lives in the `release` skill (`.agents/skills/release/`) — invoke it when shipping a version.
