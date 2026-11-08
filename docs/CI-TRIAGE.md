# CI Triage Guide

Quick path for agents to diagnose failures in tmuxy GitHub Actions.

## First-pass workflow

1. Find the failing run in the Actions tab.
2. Open failing job logs first (not successful jobs).
3. Check matching local command from this table.
4. Re-run the smallest equivalent local check.
5. If flaky/perf/storybook related, collect artifacts noted below.

A run that is green but slow is triaged from its summary page: the `timing` job writes a table of jobs, steps and the slowest tests there, and `bin/ci/ci-timing.mjs <run-id>` prints the same locally.

## Job-to-command map

| Workflow job | Local command | Primary failure surface |
| --- | --- | --- |
| `lint` | `bin/lint-gate check` — the job runs every step `bin/lint-gate steps` lists and names each failed one in an annotation, so a red step is `bin/lint-gate check <step>` (`policy`, `prettier`, `rustfmt`, `eslint`, `types`, `knip`, `clippy`, `clippy-wasm`); the pre-push hook runs the same gate | JS/TS + Rust lint/type/format, the demo's types, the scripts under `bin/`, `tests/perf/` and the UI package, and exports, files and dependencies nothing uses (`knip` in `package.json`) |
| `changes` | `node bin/ci/ci-changes.mjs <base-sha>` | Which of `desktop`, `storybook-v86-probe`, `audit` and the Mac `cargo test` this push may skip; the rules and their tests are `bin/ci/ci-changes.mjs` and `bin/ci/ci-changes.test.mjs`. A skipped job is not a failure; a job that should have run and did not is a wrong rule there |
| `unit-tests` | `npm test` | UI unit tests, and the tests of the scripts under `bin/` and the demo's |
| `cli-tests` | `npm run test:cli` | CLI dispatcher behavior, and the guests' `tmuxy-verbs` binary (`cli-guest-verbs.test.js` builds it with cargo) |
| `rust-tests` | `cargo test --workspace` | Rust unit/integration |
| `e2e (...)` | `npm run test:e2e` | Browser + tmux integration; `e2e (tmux-3.4)` is the snapshot and alternate-screen suites against tmux 3.4 (`tests/e2e-suites.json`, the `tmux` field) |
| `desktop` | `npm run test:tauri` (the debug build) + `node tests/smoke/smoke-test.js target/debug/tmuxy`; skipped when the push touched nothing the app is built from or tested by (`changes`) | Desktop IPC, Tauri runtime, the launch path |
| `storybook-probe` / `storybook-v86-probe` | `PROBE_TIER=commit npm run test-storybook -w tmuxy-ui` (the axe pass included) / `PROBE_TIER=gate npm run test-storybook:v86 -w tmuxy-ui`; the v86 probe is skipped when the push touched nothing it loads (`changes`) | Story play-function and accessibility regressions |
| nightly `v86 / deterministic` | `npm run test-storybook -w tmuxy-ui` (every story, the axe pass on) | The `nightly`-tagged stories and accessibility |
| `audit` | `npm audit --omit=dev --audit-level=high` + `cargo audit`; runs only when a lockfile or `.cargo/audit.toml` changed (`changes`), the Sunday sweep covers the days between | Dependency security alerts |
| `build-frontend` / `build-server` | `npm run build -w tmuxy-ui` / `cargo build --profile ci -p tmuxy-server` | The frontend bundle and the `ci`-profile server every later job downloads; a failure here fails everything after it |
| `demo-build` | `npm run build --ignore-scripts -w tmuxy-demo` | The demo site compiles (without staging its v86 assets; a full `npm run build -w tmuxy-demo` needs `npm run build:wasm`, `fetch:v86-image` and `build:v86-snapshot` first) |
| `macos-tests` | `npm run test:cli` every push; `cargo test --workspace` (on a Mac, with Homebrew tmux) when the push touches the desktop app, the CLI, the pty spawn of `tmux -CC`, a Rust file with a macOS branch or the Cargo manifests (the `macos-rust` rule in `bin/ci/ci-changes.mjs`), and on every tag (which `build-app.yml` calls) — `build-app.yml` also runs it on a Mac daily | macOS-only shell, path and tmux behaviour |
| nightly `tmux matrix / suites` | `npx jest tests/snapshots/` and `npx jest tests/8-tui-alternate-screen.test.js`, against the tmux version the job names | A tmux version the default CI tmux does not exercise |
| nightly `v86 / sweep` | `npm run test-storybook:v86 -w tmuxy-ui` | The full v86 story sweep; a failure opens an issue |
| nightly `nightly perf / interaction-latency` | `npm run perf:interactions` + `npm run perf:compare` | Web interaction budgets (the ratio gate) |
| nightly `nightly perf / interaction-latency-desktop` | `(cd packages/tmuxy-tauri-app && npx tauri build --no-bundle)`, then `npm run perf:interactions:tauri -- --binary target/release/tmuxy` + `npm run perf:compare -- --report tests/perf/interaction-report-tauri.json` | Desktop interaction budgets, against the release build |
| nightly `nightly perf / core-bench` | `cargo bench -p tmuxy-core --bench core_pipeline` + `node tests/perf/compare-core-bench.mjs --threshold 20` | The Axis-A pipeline bench and its ratio budget |
| `nightly perf / soak` (nightly) and `interaction-baseline` (on dispatch) | `npm run perf:soak`, `npm run perf:interactions` | Report numbers for a human; none gates |
| weekly `sunday sweep / sweep` | `GH_REPO=flplima/tmuxy node bin/ci/sunday-sweep.mjs --dry-run` (needs a `gh` that can read the security alerts; add `--red-prs` for what a hand-dispatched run with `red_prs` would hand over) |
| `dependabot actions merge / merge` | `gh pr diff <n> \| node bin/ci/actions-bump.mjs` — it merges a green Dependabot PR only when that prints nothing (a moved `actions/*` pin and no other line); anything else waits for a review |

## Where the pieces live

A phase more than one job runs is a composite action under `.github/actions/`, so a job reads as the list of phases it runs: `setup-node-rust` (Node, the npm dependencies, a Rust toolchain or none), `build-frontend` and `build-server` (the `frontend-dist` and `tmuxy-server-release` artifacts), `start-test-server` (those artifacts, the CLI on `PATH`, the server started and waited for; with `e2e`, the suites' socket, port, wait scale and snapshot policy), `install-tmux`, `install-chromium`, `install-desktop-test-deps` and `start-xvfb` (the desktop suites' WebKitGTK headers, WebDriver, tauri-driver and display), `v86-guest` (tmuxy-wasm and the cached v86 guest) and `storybook-probe-setup`. The versions and package names they install — the tmux pin, the rust targets, the apt sets, the tauri-driver pin — are `bin/toolchain`'s, which the devcontainer image and `bin/install-dev-tools` read too.

## Artifact/log entry points

- `interaction-latency-*`: `tests/perf/interaction-report.json` (`nightly perf`)
- `interaction-latency-desktop-*`: `tests/perf/interaction-report-tauri.json` (`nightly perf`)
- `core-pipeline-bench-*`: `tests/perf/core-pipeline-report.json` (`nightly perf`)
- `v86-probe-timings-*`: `tests/perf/v86-probe-timings.json`
- `storybook-*-artifacts`: screenshots, DOM dumps, stack traces
- `v86-storybook-log-*`: Storybook startup/runtime logs
- `e2e-<suite>-attempt-<n>`: a failed E2E shard's action trace (`tmuxy-e2e-trace.ndjson`, read with `tmuxy trace --check --window "<file> › <test> › start" <file>`), server log and Jest output
- Annotations titled **Silent shell pane** on any E2E job: the trace health check found a shell pane that never showed a byte — even on a green run

## Common causes

- Missing `packages/tmuxy-ui/dist` before Rust/Tauri checks.
- tmux version drift: CI pins one tmux (`bin/toolchain tmux-version`); the nightly matrix runs the others.
- Environment mismatch for browser/driver/Xvfb jobs.
- Tests asserting internals instead of user-visible behavior (see `docs/TESTS.md`).

## Related

- `docs/TESTS.md`
- `docs/PERFORMANCE.md`
