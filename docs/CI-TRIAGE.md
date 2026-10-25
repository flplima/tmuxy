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
| `lint` | `bin/lint-gate check` — the job's steps are its steps, so a red step is `bin/lint-gate check <step>` (`policy`, `prettier`, `rustfmt`, `eslint`, `types`, `knip`, `clippy`, `clippy-wasm`); the pre-push hook runs the same gate | JS/TS + Rust lint/type/format, the demo's types, the scripts under `bin/`, `tests/perf/` and the UI package, and exports, files and dependencies nothing uses (`knip` in `package.json`) |
| `changes` | `node bin/ci/ci-changes.mjs <base-sha>` | Which of `desktop`, `storybook-v86-probe`, `audit` and the Mac `cargo test` this push may skip; the rules and their tests are `bin/ci/ci-changes.mjs` and `packages/tmuxy-ui/scripts/ci-changes.test.mjs`. A skipped job is not a failure; a job that should have run and did not is a wrong rule there |
| `node-checks / unit-tests` | `npm test -- --run` | UI unit tests |
| `node-checks / cli-tests` | `npm run test:cli` | CLI dispatcher behavior |
| `rust-tests` | `cargo test --workspace` | Rust unit/integration |
| `e2e (...)` | `npm run test:e2e` | Browser + tmux integration; `e2e (tmux-3.4)` is the snapshot and alternate-screen suites against tmux 3.4 (`tests/e2e-suites.json`, the `tmux` field) |
| `desktop` | `npm run test:tauri` (the debug build) + `node tests/smoke/smoke-test.js target/debug/tmuxy`; skipped when the push touched nothing the app is built from or tested by (`changes`) | Desktop IPC, Tauri runtime, the launch path |
| `storybook-probe` / `storybook-v86-probe` | `PROBE_TIER=commit npm run test-storybook -w tmuxy-ui` (the axe pass included) / `npm run test-storybook:v86 -w tmuxy-ui`; the v86 probe is skipped when the push touched nothing it loads (`changes`) | Story play-function and accessibility regressions |
| nightly `v86 / deterministic` | `npm run test-storybook -w tmuxy-ui` (every story, the axe pass on) | The `nightly`-tagged stories and accessibility |
| `audit` | `npm audit --omit=dev --audit-level=high` + `cargo audit`; runs only when a lockfile or `.cargo/audit.toml` changed (`changes`), the Sunday sweep covers the days between | Dependency security alerts |
| `build-frontend` / `build-server` | `npm run build -w tmuxy-ui` / `cargo build --profile ci -p tmuxy-server` | The frontend bundle and the `ci`-profile server every later job downloads; a failure here fails everything after it |
| `node-checks / demo-build` | `npm run build --ignore-scripts -w tmuxy-demo` | The demo site compiles (without staging its v86 assets; a full `npm run build -w tmuxy-demo` needs `npm run build:wasm`, `fetch:v86-image` and `build:v86-snapshot` first) |
| `macos-tests` | `npm run test:cli` every push; `cargo test --workspace` (on a Mac, with Homebrew tmux) when the push touches `packages/tmuxy-tauri-app/`, `control_mode/connection.rs`, `bin/` or the Cargo manifests, and on every tag — `build-app.yml` also runs it on a Mac daily and on tags | macOS-only shell, path and tmux behaviour |
| nightly `tmux matrix / suites` | `npx jest tests/snapshots/` and `npx jest tests/8-tui-alternate-screen.test.js`, against the tmux version the job names | A tmux version the default CI tmux does not exercise |
| nightly `v86 / sweep` | `npm run test-storybook:v86 -w tmuxy-ui` | The full v86 story sweep; a failure opens an issue |
| nightly `perf measurements / interaction-latency` | `npm run perf:interactions` + `npm run perf:compare` | Web interaction budgets (the ratio gate) |
| nightly `perf measurements / interaction-latency-desktop` | `(cd packages/tmuxy-tauri-app && npx tauri build --no-bundle)`, then `npm run perf:interactions:tauri -- --binary target/release/tmuxy` + `npm run perf:compare -- --report tests/perf/interaction-report-tauri.json` | Desktop interaction budgets, against the release build |
| nightly `perf measurements / core-bench` | `cargo bench -p tmuxy-core --bench core_pipeline` + `node tests/perf/compare-core-bench.mjs --threshold 20` | The Axis-A pipeline bench and its ratio budget |
| `perf measurements / soak` (nightly) and `interaction-baseline` (on dispatch) | `npm run perf:soak`, `npm run perf:interactions` | Report numbers for a human; none gates |
| weekly `sunday sweep / sweep` | `GH_REPO=flplima/tmuxy node bin/ci/sunday-sweep.mjs --dry-run` (needs a `gh` that can read the security alerts) |
| `dependabot actions merge / merge` | nothing to run: it only merges a green `dependabot/github_actions/*` PR |

## Artifact/log entry points

- `interaction-latency-*`: `tests/perf/interaction-report.json` (nightly `perf measurements`)
- `interaction-latency-desktop-*`: `tests/perf/interaction-report-tauri.json` (nightly `perf measurements`)
- `core-pipeline-bench-*`: `tests/perf/core-pipeline-report.json` (nightly `perf measurements`)
- `v86-probe-timings-*`: `tests/perf/v86-probe-timings.json`
- `storybook-*-artifacts`: screenshots, DOM dumps, stack traces
- `v86-storybook-log-*`: Storybook startup/runtime logs
- `e2e-<suite>-attempt-<n>`: a failed E2E shard's action trace (`tmuxy-e2e-trace.ndjson`, read with `tmuxy trace --check --window "<file> › <test> › start" <file>`), server log and Jest output
- Annotations titled **Silent shell pane** on any E2E job: the trace health check found a shell pane that never showed a byte — even on a green run

## Common causes

- Missing `packages/tmuxy-ui/dist` before Rust/Tauri checks.
- tmux version drift (CI pins 3.7a in several jobs).
- Environment mismatch for browser/driver/Xvfb jobs.
- Tests asserting internals instead of user-visible behavior (see `docs/TESTS.md`).

## Related

- `docs/TESTS.md`
- `docs/PERFORMANCE.md`
