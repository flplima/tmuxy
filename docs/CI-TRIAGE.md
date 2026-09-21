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
|---|---|---|
| `lint` | `(cd packages/tmuxy-ui && npx prettier --check src)`<br>`npx prettier --check 'tests/**/*.js'`<br>`cargo fmt --check -p tmuxy-core -p tmuxy-server -p tmuxy-tauri-app -p tmuxy-tree -p tmuxy-connect -p tmuxy-wasm`<br>`npm run lint -w tmuxy-ui && npm run lint:tests`<br>`mkdir -p packages/tmuxy-ui/dist`<br>`cargo clippy -p tmuxy-core -p tmuxy-server -p tmuxy-tauri-app -p tmuxy-tree -p tmuxy-connect -- -D warnings`<br>`cargo clippy -p tmuxy-wasm --target wasm32-unknown-unknown --no-default-features -- -D warnings`<br>`(cd packages/tmuxy-ui && npx tsc --noEmit)` | JS/TS + Rust lint/type/format |
| `unit-tests` | `npm test -- --run` | UI unit tests |
| `cli-tests` | `npm run test:cli` | CLI dispatcher behavior |
| `rust-tests` | `cargo test --workspace` | Rust unit/integration |
| `e2e (...)` | `npm run test:e2e` | Browser + tmux integration |
| `tauri-e2e` | `npm run test:tauri` | Desktop IPC + Tauri runtime |
| `desktop-smoke` | See `tests/smoke/smoke-test.js` invocation in workflow | Release-like desktop launch path |
| `interaction-latency` | `npm run perf:interactions` + `npm run perf:compare` | Performance budgets |
| `storybook-probe` / `storybook-v86-probe` | `npm run test-storybook -w tmuxy-ui` / `npm run test-storybook:v86 -w tmuxy-ui` | Story play-function regressions |
| `audit` | `npm audit --omit=dev --audit-level=high` + `cargo audit` | Dependency security alerts |

## Artifact/log entry points

- `interaction-latency-*`: `perf/interaction-report.json`
- `core-pipeline-bench-*`: `perf/core-pipeline-report.json`
- `v86-probe-timings-*`: `perf/v86-probe-timings.json`
- `storybook-*-artifacts`: screenshots, DOM dumps, stack traces
- `v86-storybook-log-*`: Storybook startup/runtime logs

## Common causes

- Missing `packages/tmuxy-ui/dist` before Rust/Tauri checks.
- tmux version drift (CI pins 3.7a in several jobs).
- Environment mismatch for browser/driver/Xvfb jobs.
- Tests asserting internals instead of user-visible behavior (see `docs/TESTS.md`).

## Related

- `docs/TESTS.md`
- `docs/PERFORMANCE.md`
- `docs/RUNBOOK.md`
