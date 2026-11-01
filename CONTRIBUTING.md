# Contributing to tmuxy

Thanks for helping build **tmuxy**, a web and desktop UI over real `tmux`.

Whether you are posting a 2-minute action trace on a bug, adding a CSS theme, or fixing a Rust control-mode race, any PR or draft PR is welcome at any stage. There is no need to claim an issue before starting.

> **Security issues:** Please do not post exploit details in public issues. Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/flplima/tmuxy/security/advisories/new) and review our threat model in [docs/SECURITY.md](docs/SECURITY.md).

## 1. Setup in 3 minutes (without touching your own tmux)

tmuxy drives `tmux` control mode, so development never touches your real work sessions. Three separate sockets keep everything isolated:

- Released app: `tmux -L tmuxy`
- Dev server (`npm start`): `tmux -L tmuxy-dev`
- E2E suite (`npm run test:e2e`): `tmux -L tmuxy-test`

Pick any of three ways to start:

1. **GitHub Codespaces:** Click **Code > Create codespace on main**.
2. **Local Docker container (recommended):** Run `npm run devcontainer` (or VS Code *Reopen in Container*).
3. **Local host:** Run `bash bin/bootstrap`, then `npm start` (`cargo watch` + Vite HMR on `http://localhost:9000` against `tmuxy-dev`).

## 2. Two review speeds: isolated edges vs core seams

Not every part of tmuxy carries the same risk, so we review PRs at two speeds depending on what you touch.

### Fast lane (isolated edges)

Changes here cannot corrupt control-mode state or break security boundaries:

- Built-in themes (`packages/tmuxy-ui/public/themes/`)
- Widgets (`packages/tmuxy-ui/src/components/widgets/`) and menu specs (`packages/tmuxy-ui/src/domain/menus/`)
- CLI subcommands (`packages/tmuxy-cli/bin/tmuxy-cli`, `packages/tmuxy-cli/bin/tmuxy/`) with tests in `tests/cli/`
- Storybook stories and visual probes (`packages/tmuxy-ui/src/stories/`)
- Documentation (`docs/`, `README.md`)

If a fast-lane PR solves a clear problem, stays inside its boundary, and passes checks, we merge quickly and iterate in follow-ups.

### High-bar lane (core seams)

Changes here cross process, protocol, or security boundaries:

- Control-mode parser and command router (`packages/tmuxy-core/src/control_mode/`, `packages/tmuxy-core/src/command_router.rs`)
- Server state aggregation and streams (`packages/tmuxy-server/src/state.rs`, `packages/tmuxy-server/src/sse.rs`)
- Client transport, sequencer, and XState machines (`packages/tmuxy-ui/src/infra/transport/`, `packages/tmuxy-ui/src/machines/`)
- Security and trace redaction boundaries (`docs/SECURITY.md`, `packages/tmuxy-core/src/trace.rs`)

Rules for core seams:

1. **Align early.** Check [docs/NON-GOALS.md](docs/NON-GOALS.md) first, and open an issue, discussion, or small draft PR before writing a large change.
2. **Respect control mode.** Never run mutating raw `tmux` subprocesses while control mode is attached (it crashes tmux 3.3a-3.5a), and never send raw `neww` (`splitw ; breakp` is used instead). See [docs/TMUX.md](docs/TMUX.md).
3. **Hold the invariant.** Bug fixes on a seam must cite the row they strengthen (or add a new row and test) in [docs/INVARIANTS.md](docs/INVARIANTS.md).

## 3. Good places to start

See [docs/ARCHITECTURE-INDEX.md](docs/ARCHITECTURE-INDEX.md) for the full feature-to-file map:

1. **Add a built-in theme (~30 min):** Copy `packages/tmuxy-ui/public/themes/nord.css` to a new CSS file with dark and light palettes. Register it in `packages/tmuxy-core/src/session/assets.rs`, `packages/tmuxy-ui/src/infra/transport/drivers/guest/GuestTmuxAdapter.ts`, `packages/tmuxy-ui/src/stories/fixtures/FixtureAdapter.ts`, and `packages/tmuxy-ui/src/stories/ThemeFaces.stories.tsx`, then run `npm run test-storybook -w tmuxy-ui`.
2. **Add or extend a CLI subcommand (~1 hr):** Add the verb in `packages/tmuxy-cli/bin/tmuxy-cli` (routing mutations via `tmux run-shell`, supporting `--json` where appropriate) and add tests in `tests/cli/`.
3. **Add a menu item or widget (~1-2 hrs):** Edit one spec in `packages/tmuxy-ui/src/domain/menus/` (one spec drives both the web menu and the native macOS menu bar) and map its `TmuxOp` in `packages/tmuxy-ui/src/domain/commands.ts`.
4. **Capture or test a bug with traces (~5-60 min):** Enable **Debug > Enable Traces** at `Shape` level (records action IDs and layout timelines without keystrokes or terminal output; see [docs/TRACING.md](docs/TRACING.md)), run `tmuxy trace --check`, and attach the slice to an issue or turn it into a regression test following [docs/TESTS.md](docs/TESTS.md).

## 4. Verification and commits

Format everything in one step with `bin/lint-gate format`, then run the floor check (mirrors CI's lint job plus UI unit tests):

```bash
npm run check:fast
```

Run the suite for any extra layer your diff touches (full map in [docs/CI-TRIAGE.md](docs/CI-TRIAGE.md)):

- **Storybook stories:** `npm run test-storybook -w tmuxy-ui`
- **CLI (`packages/tmuxy-cli/`):** `npm run test:cli`
- **Rust (`packages/tmuxy-core/`, `packages/tmuxy-server/`):** `cargo test --workspace`
- **Browser + tmux E2E:** `npm run test:e2e`
- **Desktop / Tauri E2E:** `npm run test:tauri`
- **Everything (lint + unit + CLI + Rust):** `npm run check:full`

We use [gitmoji](https://gitmoji.dev/) in commit subjects (`✨` feature, `🐛` bug fix, `♻️` refactor, `✅` tests, `📝` docs). Bug-fix commits (`🐛`) tag the test layer that missed the bug, plus the invariant ID when fixing a seam:

```text
🐛 harden CLI quoting and key batching [missed-by: cli] [invariant: Q3]
```

## 5. Coding with AI agents

Using AI coding agents is welcome and encouraged. That is how tmuxy is built too, and [AGENTS.md](AGENTS.md) ships in the repo so your agent has full context. Read [AI_POLICY.md](AI_POLICY.md) before opening an AI-assisted PR.
