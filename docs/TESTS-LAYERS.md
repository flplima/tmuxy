# Test Layers and Tiers

Every test layer, where a new test goes, and which tier runs it. Part of [TESTS.md](TESTS.md).

## The Test Layers

```
                 cost / realism
                       ^
                       |   Desktop smoke (built app, Linux + macOS)   build-app.yml, tags + daily
                       |   Tauri E2E (WebDriver -> WebKitGTK app)     desktop
                       |   Web E2E + snapshots (Chromium -> server    e2e matrix (10 runners)
                       |     -> tmux 3.7a)
                       |   Storybook v86 probe (real tmux in an       storybook-v86-probe
                       |     x86 emulator, in the browser)
                       |   Storybook probe (recorded tmux states,     storybook-probe
                       |     Chromium)
                       |   CLI suite (mocked tmux)                    cli-tests
                       |   Vitest (jsdom)  |  cargo test              unit-tests | rust-tests
                       |   ESLint, tsc, Prettier, rustfmt, clippy     lint (+ pre-commit hook)
                       +-------------------------------------------------------------------->
```

| Layer | Tool | Location | What it is for | Run locally | CI job | Fails the run? |
| --- | --- | --- | --- | --- | --- | --- |
| Lint / types / format | ESLint, `tsc`, Prettier, rustfmt, clippy | `eslint.config.mjs` (tests), `packages/tmuxy-ui/eslint.config.js` (+ `eslint-rules/`), `Cargo.toml` `[workspace.lints.clippy]` | Static gates; bans skipped tests and tmux shortcuts in E2E code | `npm run lint`, `npx tsc --noEmit` (in `packages/tmuxy-ui`), `cargo clippy -p tmuxy-core -p tmuxy-server -p tmuxy-tauri-app -p tmuxy-group -p tmuxy-pty -- -D warnings` | `lint` | Yes |
| Rust unit + integration | `cargo test` (proptest, fixtures) | `#[cfg(test)]` modules in every crate; `packages/tmuxy-core/tests/` | Parser, state aggregator, reflow, command routing, server/Tauri seams; five core integration tests drive a real `tmux -CC` | `cargo test --workspace` (needs `tmux` on PATH) | `rust-tests` | Yes |
| UI unit | Vitest + Testing Library, jsdom | `packages/tmuxy-ui/src/**/__tests__/`, `src/test/` (setup: `src/test/setup.ts`, config: `vite.config.ts`) | Pure logic, machine state handlers, adapters, a few mocked component renders | `npm test -- --run` (plain `npm test` watches) | `unit-tests` | Yes |
| CLI | Jest, mocked binaries | `tests/cli/` (`mocks/tmux`, `mocks/tmuxy-server`) | `bin/tmuxy-cli` dispatch and argv; asserts every tmux call carries the dedicated socket flag | `npm run test:cli` | `cli-tests` | Yes |
| Storybook probe | Playwright + `storybook dev` | `packages/tmuxy-ui/src/**/*.stories.tsx`, `scripts/probe-stories.mjs`; recordings in `src/stories/fixtures/` | Every non-`v86` story renders over states recorded from real tmux and its play function passes (render, glitch, immediacy budgets) | `npm run storybook -w tmuxy-ui`, then `npm run test-storybook -w tmuxy-ui` | `storybook-probe` (commit tier); nightly `deterministic` (all + axe) | Yes |
| Storybook v86 probe | Playwright, v86 + `tmuxy-wasm` | `v86`-tagged stories (`src/stories/App*.stories.tsx`), `scripts/probe-spikes.mjs` | Real tmux behind the real UI with no server: the stories whose subject is tmux's reply — optimistic updates reconciled, `%output` rendering, `%exit` — and the demo site's own guards | `npm run test-storybook:v86 -w tmuxy-ui` (needs the assets below) | `storybook-v86-probe` | Gate step (three id filters): yes. Full sweep: nightly, blocking there |
| Web E2E | Jest + Playwright over CDP | `tests/1-…` to `tests/15-…`, `tests/helpers/` | Whole chain: keyboard/mouse in Chromium → server → tmux → SSE → DOM | `npm run test:e2e` (Chrome on 9222, see below) | `e2e` matrix, one runner per file (`2-layout` is split across two) | Yes |
| Snapshot | Jest + Playwright | `tests/snapshots/snapshot.test.js` | Read-only UI ↔ tmux consistency checks (structure, then the tab strip); also the nightly tmux-matrix smoke | `npx jest tests/snapshots/` | `e2e (snapshots)` | Yes |
| Interaction latency | Playwright | `packages/tmuxy-ui/scripts/measure-interactions.mjs`, `compare-interactions.mjs`, `perf/interaction-baseline.json` | Cost of key-echo, pane nav, zoom, split, tab switch, as a ratio to a keystroke | See [Interaction-Latency Tests](TESTS-E2E.md#interaction-latency-tests) | nightly `perf measurements` (`interaction-latency`, `-desktop`) | Nightly only. Ratio budgets fail that run; absolute ms warn |
| Tauri E2E | Jest + WebdriverIO + `tauri-driver`, Xvfb | `tests/tauri/` | Desktop IPC seam (`invoke`/`listen`), app lifecycle, state sync. Linux/WebKitGTK only | `npm run test:tauri` (Linux) | `desktop` | Yes |
| Desktop smoke | WebdriverIO, `tauri-driver` / `tauri-webdriver` | `tests/smoke/` | The packaged app launches, runs a command, connects once; launch-environment regressions | Built by CI; `node tests/smoke/smoke-test.js <binary>` with a driver on 4444 | `build-app.yml` `build` matrix | `smoke-test.js` and macOS `macos-sparse-path-test.js`: yes |
| Dependency audit | `npm audit`, `cargo audit` | `.cargo/audit.toml` | Production npm deps (high+) and the Rust workspace | same commands | `audit` | Yes |

The criterion benchmark `packages/tmuxy-core/benches/core_pipeline.rs` (see [PERFORMANCE.md](PERFORMANCE.md) Axis A) runs nightly in `nightly-perf.yml` (`core-bench`); its ratio budget fails that run, its absolute numbers only warn.

### CI Workflows

| Workflow | Trigger | Jobs | Runner |
| --- | --- | --- | --- |
| `.github/workflows/lint-and-tests.yml` | push to `main`, PRs to `main` | `build-frontend` + `build-server` (the dist and a `ci`-profile server, shared by the jobs below), `changes` (what the push touched: `bin/ci-changes.mjs`), `lint` (`bin/lint-gate check`), `unit-tests`, `macos-tests` (the CLI suite; the Rust suite only when macOS-specific code changed, and on tags), `rust-tests`, `cli-tests`, `demo-build`, `e2e` (matrix), `desktop` (debug Tauri build, smoke test + Tauri E2E; skipped when nothing it covers changed), `storybook-probe`, `storybook-v86-probe` (skipped likewise), `audit` (only when a lockfile moved) | `ubuntu-latest`, plus `macos-latest` for `macos-tests` |
| `.github/workflows/nightly-v86.yml` | nightly cron, manual | the full v86 story sweep; a failure opens an issue | `ubuntu-latest` |
| `.github/workflows/nightly-tmux-matrix.yml` | nightly cron, manual | the tmux-facing suites against each supported tmux version; released versions gate, `HEAD` reports only | `ubuntu-latest` |
| `.github/workflows/build-app.yml` | `v*` tags, daily cron, manual | `build` (Tauri build + smoke tests) + `upgrade-path`, then on tags `release`, `bump-cask`, `bump-formula` | `ubuntu-22.04` (amd64), `ubuntu-22.04-arm`, `macos-latest` |
| `.github/workflows/nightly-perf.yml` | nightly cron, manual | `interaction-latency`, `interaction-latency-desktop` and `core-bench` (their ratio budgets fail the run), `soak` (reports only), plus on dispatch an interaction-baseline refresh | `ubuntu-latest` |
| `.github/workflows/deploy-demo.yml` | push to `main` touching the demo or UI source, manual | demo build + Pages deploy (no tests) | `ubuntu-latest` |

**"Blocking" means the job turns the run red — nothing is enforced at merge.** `main` has no branch protection or required status checks; its only ruleset blocks deletion and force-push. Nothing in the PR run is non-blocking any more: the suites that used to be waved through (`9-animations`, `hostile-config-test.js`) were deleted rather than left reporting a result nobody could act on, and the v86 sweep moved to its own nightly workflow where it blocks and opens an issue.

Quarantine is the one deliberate exception, and it is bounded: a story listed in `packages/tmuxy-ui/scripts/probe-quarantine.json` (deterministic probe) still runs and is still reported, but does not fail the job until its expiry date, after which it blocks again. The list is capped, and every entry carries a reason and an ISO expiry — `scripts/probe-quarantine.mjs` enforces that and refuses to run on a list that breaks it.

Jobs that need tmux build **3.7a** from source and cache it (`e2e`, `desktop`, `rust-tests`, and the nightly perf jobs). The macOS smoke test uses Homebrew's `tmux` and the Linux smoke test apt's `tmux`.

### Red-Main Policy & Bug-Fix Attribution

The rules for a red `main` — fix or quarantine within 24 hours, no features on a red main, quarantine only through the bounded lists — and the `[missed-by: <layer>]` and `[invariant: <id>]` tags a bug-fix commit carries live in `AGENTS.md` (Testing & Bug Fixes). The ids point at rows of [INVARIANTS.md](INVARIANTS.md), where each cross-layer promise names the test that holds it; a row whose kind is ordering or liveness wants a property or interleaving test, since one scripted ordering only proves the bug it was written for. One addition that matters here: **re-runs are not fixes.** Clicking re-run on a failing job masks a race and degrades confidence in CI; fix the synchronization or the wait condition instead.

### Local Gates

One list, `bin/lint-gate`, says what is formatted, linted, type-checked and clippy'd — the UI sources, the E2E suites, the scripts under `bin/`, `perf/` and the UI package, the demo site, every crate — and the hooks and CI's `lint` job all run it, so they cannot disagree about what a clean tree is. `.github/pre-commit` (enabled by `npm install` through the `prepare` script) runs `bin/lint-gate format` (Prettier, `eslint --fix`, `cargo fmt`), re-staging rewrites only for fully staged files, then a check that `eslint.config.mjs` still bans `tmuxExec`, `tmuxRun`, `tmuxCmd` and `execSync`, `vitest related --run` for staged UI sources, and the repo policy checks. `.github/pre-push` runs `bin/lint-gate check`, the read-only gate CI's `lint` job runs step by step: type checks and clippy with `-D warnings` once per push rather than once per commit.

ESLint rules that exist to protect test quality (`eslint.config.mjs`):

- `jest/no-disabled-tests` is an error for `tests/**/*.js`.
- Every `tests/**/*.test.js` outside `tests/tauri/` may not call `tmuxRun` or `tmuxCmd`, use `execSync` or import `child_process`; setup and ground-truth reads go through `tmuxExec()` in `tests/helpers/tmux-socket.js`. The interaction helpers `tests/helpers/pane-ops.js` and `tests/helpers/keyboard.js` may not call `tmuxExec` or `tmuxRun` at all, since they must act the way a user does.

Clippy warns on `unwrap_used` and `expect_used` workspace-wide; CI promotes all warnings to errors. Test files opt out explicitly with an `allow` attribute.

## Which Layer Does a New Test Go In?

Pick the cheapest layer that can still fail for the bug you care about. If the bug lives in the chain between two layers, the test belongs in the layer that contains the whole chain.

| The behavior is… | Put the test in |
| --- | --- |
| A pure function, parser or state transition in TypeScript (layout math, copy-mode engine, key mapping, a machine handler) | Vitest, next to the code in `__tests__/` |
| Rust parsing, aggregation, reflow or routing that can be fed recorded control-mode text | `cargo test` — a `#[cfg(test)]` module, or `packages/tmuxy-core/tests/` with a fixture |
| Rust behavior that depends on how real tmux answers or orders replies | `packages/tmuxy-core/tests/` against a scratch socket, like `reply_channel.rs` |
| What the `tmuxy` CLI sends to tmux | `tests/cli/` |
| How a component looks or animates, render counts, flicker, optimistic paint timing with controlled latency or forced rejection | A Storybook story with a play function on `FixtureApp`/`FixtureProvider` (`src/stories/FixtureHarness.tsx`), over a recording of real tmux ([Recorded fixtures](TESTS-STORYBOOK.md#recorded-fixtures)) |
| "tmux did X and the UI showed it" without needing the Rust server or HTTP | A `v86`-tagged story on `V86AppHarness` |
| A user-visible feature through the real server and transport: keyboard, mouse, touch, floats, groups, reconnect, OSC, widgets | Web E2E — extend the numbered file whose theme fits (below); a production bug with no better home goes in `tests/7-regression-bugs.test.js` |
| Something that got slower but still works | An entry in `measure-interactions.mjs` plus a budget in `compare-interactions.mjs` |
| Anything that differs on desktop: IPC commands, events, app lifecycle | `tests/tauri/tauri-app.test.js` |
| The packaged app failing to start in a particular launch environment | `tests/smoke/` |

Whatever the layer, the rules below apply: assert what the user sees, drive it through the user's path, and keep one feature in one test. A unit or story test does not replace an E2E test for a user path — it catches the bug earlier and cheaper.

## Tiers: per commit, nightly, and before a release

Not every E2E test earns a runner on every push. A test whose logic a cheaper layer already holds — a zoom whose geometry `zoomIdentity.test.ts` and a story both check, a context menu every `PaneContextMenu` story opens, a backoff schedule `disconnected.test.ts` times — still has value against the real server and real tmux, but a regression there is not something a push has to wait for. Those tests carry **`[nightly]`** at the end of their name, and run in three places:

| Run | What runs | How |
| --- | --- | --- |
| every push and PR (`lint-and-tests.yml`) | every E2E test **without** the tag | `bin/e2e-plan.mjs commit` builds the matrix from `tests/e2e-suites.json`, with a jest name pattern that skips `[nightly]`; a file marked `tier: nightly` there (every test tagged) gets no runner at all |
| a push or PR that edits the web suites | the above, plus every test **with** the tag | `bin/ci-changes.mjs` sees a changed file under `tests/` (not `tests/cli/` or `tests/tauri/`) and the plan adds one `nightly-tier` runner (about five minutes) that runs the tagged tests as the nightly does, so a push that breaks one fails then rather than the next night |
| nightly (`nightly-tmux-matrix.yml`, on 3.7a) | every test **with** the tag, every file | `npx jest tests/ --testNamePattern '\[nightly\]'` on the runner that already has the server up; a failure opens or comments on the nightly tracking issue, and a run where every released version passes closes it (`bin/nightly-issue`) |
| a tag build (`build-app.yml`) | everything | it calls `lint-and-tests.yml` with `e2e-tier: full`, so the release is gated on the whole suite, the nightly tier included |

So the tag is the one source of truth: adding it to a test moves it out of the push and into the nightly and the release gate; nothing else needs listing. The per-commit matrix is still the one that fails a push, and a test in it is one the push cannot do without — moving a test to the nightly tier is a claim that a cheaper layer covers its logic, and the test's doc comment should name that layer. A test that only matters for packaging or a deployment shape (a reverse proxy, a sparse launchd `PATH`) belongs in the nightly tier too: the tag build runs it before anything ships.

The same tag works for stories (`tags: ['nightly']` on a story), where the per-commit probe leaves them out and the nightly `deterministic` job runs them. A quarantined story that fails by **timing out** belongs there as well while it is quarantined: it sits at the per-story deadline on every push and gates nothing, so the minutes it costs are better spent nightly.

A push that changes only prose — `docs/**` or any `*.md` — runs no workflow at all (`paths-ignore` on `lint-and-tests.yml`). Nothing in the suite reads those files, and `main` has no required check that a skipped run could leave pending.

## UI Unit Tests

- Vitest with jsdom, configured in `packages/tmuxy-ui/vite.config.ts`; `src/test/setup.ts` installs jest-dom matchers, an in-memory `localStorage` for Node ≥ 22, and cleans up after each test
- Tests live beside the code in `__tests__/` directories: `src/utils/`, `src/machines/` (state handlers share `src/machines/app/states/__tests__/testHarness.ts`), `src/domain/` (the command vocabulary, the delta protocol, the store's pure logic), `src/infra/` (the transport service and its drivers — HTTP, Tauri, the demo backend — key batching, the store), `src/components/`, `src/hooks/`
- Test pure logic: parsers, state transformations, utility functions, adapter protocol handling
- Component rendering in jsdom is limited to a few mocked-context tests in `src/test/`. jsdom has no layout, so a jsdom render test can prove "does not throw" and "renders this text", never "is visible" — anything visual belongs in a story or E2E
- Keep unit tests fast (< 1s per file)

## Rust Tests

- `cargo test --workspace` runs every crate's `#[cfg(test)]` modules plus the integration tests in `packages/tmuxy-core/tests/`. Most of the count is in `tmuxy-core`; `tmuxy-server`, `tmuxy-tauri-app`, `tmuxy-wasm`, `tmuxy-group` and `tmuxy-pty` (whose `tests/pane.rs` drives the helper over a socket pair) have smaller suites
- Prefer fixtures over a live tmux: `control_mode_push_api.rs` feeds recorded `tmux -CC` text through the parser and aggregator, `terminal_fidelity.rs` and `pane_reflow_parity.rs` replay byte streams through the emulator (`tests/fixtures/`), and `state_aggregator_props.rs` is a proptest suite (its regressions file is committed)
- `initial_state.rs`, `initial_state_history.rs`, `reply_channel.rs`, `pinned_split_race.rs` and `enforced_settings.rs` drive a real `tmux -CC` monitor on a per-process scratch socket and need a `tmux` binary; use that pattern only when the bug depends on how tmux itself answers
- Test code opts out of the `unwrap_used`/`expect_used` lints with an `allow` attribute

## CLI Tests

`tests/cli/` has its own Jest config (`tests/cli/jest.config.js`) and runs `bin/tmuxy-cli` against the mock `tmux` and `tmuxy-server` scripts in `tests/cli/mocks/`, which log every invocation. `tests/cli/helpers/run-cli.js` fails any recorded tmux call that does not lead with the dedicated socket flag, so socket isolation is enforced for every subcommand. It is hermetic: no tmux, no server, no browser.
