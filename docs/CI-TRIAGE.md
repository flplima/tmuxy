# CI Triage Guide

Quick path for agents to diagnose failures in tmuxy GitHub Actions.

## First-pass workflow

1. Find the failing run in the Actions tab.
2. Open failing job logs first (not successful jobs).
3. Check matching local command from this table.
4. Re-run the smallest equivalent local check.
5. If flaky/perf/storybook related, collect artifacts noted below.

## Job-to-command map

| Workflow job | Local command | Primary failure surface |
| --- | --- | --- |
| `lint` | `bin/lint-gate check` — the job runs every step `bin/lint-gate steps` lists and names each failed one in an annotation, so a red step is `bin/lint-gate check <step>` (`policy`, `prettier`, `rustfmt`, `eslint`, `types`, `knip`, `complexity`, `shellcheck`, `clippy`, `clippy-wasm`); the pre-push hook runs the same gate | JS/TS + Rust lint/type/format, the demo's types, the scripts under `bin/`, `tests/perf/` and the UI package, and exports, files and dependencies nothing uses (`knip` in `package.json`) |
| `changes` | `node bin/ci/ci-changes.mjs <base-sha>`, then `node bin/ci/e2e-plan.mjs commit [--with-nightly]` | Which of `desktop`, `storybook-v86-probe`, `audit` and the Mac `cargo test` this push may skip (rules and tests: `bin/ci/ci-changes.mjs`, `bin/ci/ci-changes.test.mjs`), and the E2E matrix the `e2e` job fans out over (`tests/e2e-suites.json`, with one more `nightly-tier` shard when the push edited the web suites). A skipped job is not a failure; a job that should have run and did not is a wrong rule there |
| `ci` | Read the run page: the step is a `jq` filter over the jobs' results, in the workflow | Runs last, always: red when any job failed or was cancelled (a skipped one passes) |
| `unit-tests` | `npm test` | UI unit tests, and the tests of the scripts under `bin/` and the demo's |
| `cli-tests` | `npm run test:cli` | CLI dispatcher behavior, and the guests' `tmuxy-verbs` binary (`cli-guest-verbs.test.js` builds it with cargo) |
| `rust-tests` | `cargo test --workspace` | Rust unit/integration |
| `e2e (<shard>)` | `npx jest <the shard's files>`; the shard → files map is the Suites table in [TESTS-E2E.md](TESTS-E2E.md#suites) | Browser + tmux integration; `e2e (tmux-3.4)` reruns the snapshot, alternate-screen and `run-shell` regression suites against tmux 3.4 (`tests/e2e-suites.json`, the `tmux` field) |
| `desktop` | `npm run test:tauri` (the debug build) + `node tests/smoke/smoke-test.js target/debug/tmuxy`; skipped when the push touched nothing the app is built from or tested by (`changes`) | Desktop IPC, Tauri runtime, the launch path |
| `storybook-probe` / `storybook-v86-probe` | `PROBE_TIER=commit npm run test-storybook -w tmuxy-ui` (the axe pass included) / `PROBE_TIER=gate npm run test-storybook:v86 -w tmuxy-ui`; the v86 probe is skipped when the push touched nothing it loads (`changes`) | Story play-function and accessibility regressions |
| `nightly v86 sweep / deterministic` | `npm run test-storybook -w tmuxy-ui` (every story, the axe pass on) | The `nightly`-tagged stories and accessibility |
| `audit` | `npm audit --omit=dev --audit-level=high` + `cargo audit`; runs only when a lockfile or `.cargo/audit.toml` changed (`changes`), Dependabot's alerts cover the days between | Dependency security alerts |
| `build-frontend` / `build-server` | `npm run build -w tmuxy-ui` / `cargo build --profile ci -p tmuxy-server` | The frontend bundle and the `ci`-profile server every later job downloads; a failure here fails everything after it |
| `demo-build` | `npm run build --ignore-scripts -w tmuxy-demo` | The demo site compiles (without staging its v86 assets; a full `npm run build -w tmuxy-demo` needs `npm run build:wasm`, `fetch:v86-image` and `build:v86-snapshot` first) |
| `macos-tests` | `npm run test:cli` every push; `cargo test --workspace` (on a Mac, with Homebrew tmux) when the push touches the desktop app, the CLI, the pty spawn of `tmux -CC`, a Rust file with a macOS branch or the Cargo manifests (the `macos-rust` rule in `bin/ci/ci-changes.mjs`), and on every tag (which `build-app.yml` calls) — `build-app.yml` also runs it on a Mac daily | macOS-only shell, path and tmux behaviour |
| `nightly tmux matrix / suites` | `npx jest tests/snapshots/` and `npx jest tests/8-tui-alternate-screen.test.js`, against the tmux version the job names | A tmux version the default CI tmux does not exercise |
| `nightly v86 sweep / sweep` | `npm run test-storybook:v86 -w tmuxy-ui` | The full v86 story sweep. A story that failed runs again alone in `reconfirm-v86` (`reconfirm-deterministic` for the other tier); `report` turns the two runs into the night's verdicts and opens or closes the issue ([NIGHTLY-SWEEP.md](NIGHTLY-SWEEP.md)) |
| `nightly perf / interaction-latency` | `npm run perf:interactions` + `npm run perf:compare` | Web interaction budgets (the ratio gate) |
| `nightly perf / interaction-latency-desktop` | `(cd packages/tmuxy-tauri-app && npx tauri build --no-bundle)`, then `npm run perf:interactions:tauri -- --binary target/release/tmuxy` + `npm run perf:compare -- --report tests/perf/interaction-report-tauri.json` | Desktop interaction budgets, against the release build |
| `nightly perf / core-bench` | `cargo bench -p tmuxy-core --bench core_pipeline` + `node tests/perf/compare-core-bench.mjs --threshold 20` | The Axis-A pipeline bench and its ratio budget |
| `nightly perf / soak` (nightly) and `nightly perf / interaction-baseline` (on dispatch) | `npm run perf:soak -- --socket <the server's own>`, `npm run perf:interactions` | Report numbers for a human; none gates. The soak needs the socket of a server started for it, and refuses the ones people work in |
| `nightly fuzz / fuzz` | `bin/fuzz 20` (or `TMUXY_FUZZ_CASES=<n> cargo test -p tmuxy-core --test fuzz_parsers`) | The parser fuzz targets with tens of thousands of cases. The issue carries the shrunk input; the run's artifact is the regressions file to commit with the fix |

## Structure guards

What keeps the code from tangling again after PR #177. Each is deterministic: the same code always gets the same verdict.

| Guard | Runs in | Says | What to do |
| --- | --- | --- | --- |
| Homes of facts and calls | `policy` (`bin/ci/homes.mjs`, `bin/ci/homes.json`) | a file writes a generated fact (an `@tmuxy-*` option, a window type, a state word), starts tmux (`tmux_path()`) or starts a process (`Command::new`) outside the files allowed | Use the generated constant or the module that owns the call; if the file is a new home, add it to the rule's `allow` and say why |
| tmux command strings | `eslint` (`tmuxy/no-tmux-command-literals`) | UI code spells a tmux command outside the allowed files in `packages/tmuxy-ui/eslint.config.js` | Build a `TmuxOp` (`domain/commands.ts`) and dispatch it |
| UI import cycles | `policy` (`bin/ci/import-cycles.mjs`) | modules of `packages/tmuxy-ui/src` import each other round a loop | Move what they share into a module both import |
| UI layers | `eslint` (`no-restricted-imports`) | a lower layer imports a higher one | Move what it needs down a layer |
| Core module graph | Rust tests (`packages/tmuxy-core/tests/module_graph.rs`) | a new edge between tmuxy-core's modules, or a cycle | A cycle: share or merge. A meant edge: `UPDATE_GENERATED=1 cargo test -p tmuxy-core --test module_graph`, and say why |
| Copied code | `policy` (`bin/ci/duplication.mjs`) | more lines in copied 8-line runs than `bin/ci/ratchets.json` allows | Share the code. Fewer than allowed: lower the ratchet (`node bin/ci/duplication.mjs --update`) |
| Function size | `complexity` (`bin/ci/complexity.mjs`) | more branchy or long functions than `bin/ci/ratchets.json` allows | Split the function the change grew. Fewer: `node bin/ci/complexity.mjs --update` |
| Shell scripts | `shellcheck` (`.shellcheckrc`) | a warning in any tracked shell script, a sourced library included | Fix it. A path built at run time gets a `# shellcheck source=` line beside its `source`; a variable another file sets gets a one-line `disable` that names that file |

Every allow list and ratchet only goes down: an allowance a file no longer needs, or a count that fell, fails until the file is updated.

## Where the pieces live

A phase more than one job runs is a composite action under `.github/actions/`, so a job reads as the list of phases it runs: `setup-node-rust` (Node, the npm dependencies, a Rust toolchain or none), `install-node-modules` (the workspace's `node_modules` from a lockfile-keyed cache, or `npm ci`), `install-linux-deps` (the WebKitGTK headers the desktop crate links against), `install-webkit` (Playwright's WebKit and its libraries, for the `webkit` shard), `build-frontend` and `build-server` (the `frontend-dist` and `tmuxy-server-release` artifacts), `start-test-server` (those artifacts, the CLI on `PATH`, the server started and waited for; with `e2e`, the suites' socket, port, wait scale and snapshot policy), `install-tmux`, `install-chromium`, `install-desktop-test-deps` and `start-xvfb` (the desktop suites' WebKitGTK headers, WebDriver, tauri-driver and display), `v86-guest` (tmuxy-wasm and the cached v86 guest) and `storybook-probe-setup`. The versions and package names they install — the tmux pin, the rust targets, the apt sets, the tauri-driver pin — are `bin/toolchain`'s, which the devcontainer image and `bin/install-dev-tools` read too.

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
