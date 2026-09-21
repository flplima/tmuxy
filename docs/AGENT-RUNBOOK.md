# Agent Runbook

Task-to-command matrix for AI coding agents working in tmuxy.

| Task | Commands | Notes |
|---|---|---|
| Bootstrap environment | `bash /home/runner/work/tmuxy/tmuxy/bin/agent-bootstrap` | Idempotent and non-interactive. |
| Quick validation before commit | `npm run copilot:fast-check` | Lint + TS + unit checks. |
| Deeper pre-merge validation | `npm run copilot:full-check` | Adds CLI + Rust workspace tests. |
| UI-only change (`packages/tmuxy-ui/src/**`) | `npm run lint -w tmuxy-ui`<br>`(cd packages/tmuxy-ui && npx tsc --noEmit)`<br>`npm test -- --run` | Matches core CI checks for UI logic. |
| E2E behavior/debug | `npm run test:e2e` | Requires Playwright + tmux runtime. |
| Tauri behavior/debug | `npm run test:tauri` | Linux CI uses `tauri-driver` + Xvfb. |
| Rust core/server change | `cargo clippy -p tmuxy-core -p tmuxy-server -- -D warnings`<br>`cargo test --workspace` | Keep `packages/tmuxy-ui/dist` placeholder when needed. |
| CI parity lint pass | `npm run lint && npm run lint:tests`<br>`(cd packages/tmuxy-ui && npx tsc --noEmit)` | Same surface area as lint workflow gates. |
| Release artifact smoke validation | See `/home/runner/work/tmuxy/tmuxy/.github/workflows/build-app.yml` | Workflow includes Linux/macOS smoke paths. |

## Order of operations

1. Bootstrap.
2. Apply focused checks for changed area.
3. Run full-check before handoff if scope crosses UI + Rust.
4. Use `/home/runner/work/tmuxy/tmuxy/docs/CI-TRIAGE.md` when CI fails.

## Related

- `/home/runner/work/tmuxy/tmuxy/docs/TESTS.md`
- `/home/runner/work/tmuxy/tmuxy/docs/TMUX.md`
- `/home/runner/work/tmuxy/tmuxy/docs/CI-TRIAGE.md`
