# Architecture Index

Feature-to-files retrieval map for agents.

| Feature | Key files |
|---|---|
| tmux control-mode command routing | `packages/tmuxy-core/src/command_router.rs`<br>`packages/tmuxy-ui/src/tmux/adapters.ts` |
| Backend state aggregation and emit | `packages/tmuxy-core/src/control_mode/state.rs`<br>`packages/tmuxy-server/src/state.rs` |
| SSE/HTTP server flow | `packages/tmuxy-server/src` (see docs references) |
| Frontend state machine | `packages/tmuxy-ui/src` (XState machine and hooks) |
| CLI dispatcher and event queue | `bin/tmuxy-cli` |
| Tauri bridge and desktop shell | `packages/tmuxy-tauri-app` |
| Copy mode behavior | `docs/COPY-MODE.md` + related UI files |
| Rich rendering / OSC / image protocols | `docs/RICH-RENDERING.md` |
| Performance harnesses | `perf`<br>`packages/tmuxy-ui/scripts` |
| E2E and helper layers | `tests`<br>`tests/helpers` |

## Related docs

- `docs/ARCHITECTURE.md`
- `docs/STATE-MANAGEMENT.md`
- `docs/DATA-FLOW.md`
- `docs/TMUX.md`
- `docs/AGENT-RUNBOOK.md`
- `docs/CI-TRIAGE.md`
