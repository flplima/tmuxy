# Runbook

Task-to-command matrix for anyone working in tmuxy. Which checks a change needs before a push, and what each CI job runs, live in one place: the job-to-command map in [CI-TRIAGE.md](CI-TRIAGE.md).

| Task                                                        | Commands                              | Notes                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap environment                                       | `bash bin/bootstrap`                  | Idempotent and non-interactive.                                                                                                                                                                          |
| Repo policy checks                                          | `npm run check:policy`                | Enforces workflow/docs/control-mode guardrails.                                                                                                                                                          |
| Quick validation before commit                              | `npm run check:fast`                  | Lint + TS + unit checks.                                                                                                                                                                                 |
| Deeper pre-merge validation                                 | `npm run check:full`                  | Adds CLI + Rust workspace tests.                                                                                                                                                                         |
| E2E behavior/debug                                          | `npm run test:e2e`                    | Requires Playwright + tmux runtime.                                                                                                                                                                      |
| Tauri behavior/debug                                        | `npm run test:tauri`                  | Linux CI uses `tauri-driver` + Xvfb.                                                                                                                                                                     |
| Tauri prerequisite preflight                                | `npm run preflight:tauri`             | Checks pkg-config toolchain/libs before desktop checks.                                                                                                                                                  |
| Release artifact smoke validation                           | See `.github/workflows/build-app.yml` | Workflow includes Linux/macOS smoke paths.                                                                                                                                                               |
| A pane will not open, or `/dev/ttys*` numbers keep climbing | `tmuxy cleanup` (`-n` to look first)  | Reaps shells left blocked in the kernel by a pane torn down mid-start-up; each holds a pseudoterminal, and enough of them exhaust the machine's supply. `npm start` and the E2E teardown already run it. |

## Order of operations

1. Bootstrap.
2. Run the repo policy checks.
3. Apply focused checks for changed area.
4. Before wrap-up, run `npm run check:fast` and the `lint` job's commands from [CI-TRIAGE.md](CI-TRIAGE.md).
5. Run full-check before handoff if scope crosses UI + Rust.
6. Use `docs/CI-TRIAGE.md` when CI fails.

## Related

- `docs/TESTS.md`
- `docs/TMUX.md`
- `docs/CI-TRIAGE.md`
