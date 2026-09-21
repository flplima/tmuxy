# Architecture Index

Feature-to-files retrieval map for agents.

| Feature | Key files |
|---|---|
| tmux control-mode command routing | `/home/runner/work/tmuxy/tmuxy/packages/tmuxy-core/src/command_router.rs`<br>`/home/runner/work/tmuxy/tmuxy/packages/tmuxy-ui/src/tmux/adapters.ts` |
| Backend state aggregation and emit | `/home/runner/work/tmuxy/tmuxy/packages/tmuxy-core/src/control_mode/state.rs`<br>`/home/runner/work/tmuxy/tmuxy/packages/tmuxy-server/src/state.rs` |
| SSE/HTTP server flow | `/home/runner/work/tmuxy/tmuxy/packages/tmuxy-server/src` (see docs references) |
| Frontend state machine | `/home/runner/work/tmuxy/tmuxy/packages/tmuxy-ui/src` (XState machine and hooks) |
| CLI dispatcher and event queue | `/home/runner/work/tmuxy/tmuxy/bin/tmuxy-cli` |
| Tauri bridge and desktop shell | `/home/runner/work/tmuxy/tmuxy/packages/tmuxy-tauri-app` |
| Copy mode behavior | `/home/runner/work/tmuxy/tmuxy/docs/COPY-MODE.md` + related UI files |
| Rich rendering / OSC / image protocols | `/home/runner/work/tmuxy/tmuxy/docs/RICH-RENDERING.md` |
| Performance harnesses | `/home/runner/work/tmuxy/tmuxy/perf`<br>`/home/runner/work/tmuxy/tmuxy/packages/tmuxy-ui/scripts` |
| E2E and helper layers | `/home/runner/work/tmuxy/tmuxy/tests`<br>`/home/runner/work/tmuxy/tmuxy/tests/helpers` |

## Related docs

- `/home/runner/work/tmuxy/tmuxy/docs/ARCHITECTURE.md`
- `/home/runner/work/tmuxy/tmuxy/docs/STATE-MANAGEMENT.md`
- `/home/runner/work/tmuxy/tmuxy/docs/DATA-FLOW.md`
- `/home/runner/work/tmuxy/tmuxy/docs/TMUX.md`
- `/home/runner/work/tmuxy/tmuxy/docs/AGENT-RUNBOOK.md`
- `/home/runner/work/tmuxy/tmuxy/docs/CI-TRIAGE.md`
