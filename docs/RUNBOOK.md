# Runbook

Task-to-command matrix for anyone working in tmuxy.

| Task | Commands | Notes |
|---|---|---|
| Bootstrap environment | `bash bin/bootstrap` | Idempotent and non-interactive. |
| Repo policy checks | `npm run check:policy` | Enforces workflow/docs/control-mode guardrails. |
| Quick validation before commit | `npm run check:fast` | Lint + TS + unit checks. |
| Deeper pre-merge validation | `npm run check:full` | Adds CLI + Rust workspace tests. |
| UI-only change (`packages/tmuxy-ui/src/**`) | `npm run lint -w tmuxy-ui`<br>`(cd packages/tmuxy-ui && npx tsc --noEmit)`<br>`npm test -- --run` | Matches core CI checks for UI logic. |
| E2E behavior/debug | `npm run test:e2e` | Requires Playwright + tmux runtime. |
| Tauri behavior/debug | `npm run test:tauri` | Linux CI uses `tauri-driver` + Xvfb. |
| Tauri prerequisite preflight | `npm run preflight:tauri` | Checks pkg-config toolchain/libs before desktop checks. |
| Rust core/server change | `cargo clippy -p tmuxy-core -p tmuxy-server -- -D warnings`<br>`cargo test --workspace` | Keep `packages/tmuxy-ui/dist` placeholder when needed. |
| CI parity lint pass | `(cd packages/tmuxy-ui && npx prettier --check src)`<br>`npx prettier --check 'tests/**/*.js'`<br>`npm run lint && npm run lint:tests`<br>`(cd packages/tmuxy-ui && npx tsc --noEmit)` | Same surface area as lint workflow gates. |
| Release artifact smoke validation | See `.github/workflows/build-app.yml` | Workflow includes Linux/macOS smoke paths. |

## Order of operations

1. Bootstrap.
2. Run the repo policy checks.
3. Apply focused checks for changed area.
4. Before wrap-up, run `npm run check:fast` and the CI parity lint pass command above.
5. Run full-check before handoff if scope crosses UI + Rust.
6. Use `docs/CI-TRIAGE.md` when CI fails.

## Related

- `docs/TESTS.md`
- `docs/TMUX.md`
- `docs/CI-TRIAGE.md`
