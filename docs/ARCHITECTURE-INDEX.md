# Architecture Index

Feature-to-files retrieval map for agents.

| Feature | Key files |
| --- | --- |
| tmux control-mode command routing | `packages/tmuxy-core/src/command_router.rs`<br>`packages/tmuxy-ui/src/infra/transport/drivers/TauriAdapter.ts` |
| What tmux leaves unannounced (the re-lists behind a command), and the map of version workarounds | `packages/tmuxy-core/src/tmux_compat.rs` |
| The monitor loop (connect, back off, give up, restore before create, autosave) and what each host does around it | `packages/tmuxy-core/src/host/supervise.rs`<br>`packages/tmuxy-server/src/sse/monitor.rs`<br>`packages/tmuxy-tauri-app/src/monitor.rs` |
| The tmux config tmuxy ships (the defaults, the essentials, the user template), the code that mirrors it and builds the chain, the pins, and the migration of an older config dir | `packages/tmuxy-core/assets/*.conf`<br>`packages/tmuxy-core/src/session/config.rs`<br>`packages/tmuxy-core/src/session/migrate.rs`<br>`packages/tmuxy-core/src/paths.rs` (every file and directory) |
| Pane groups: membership, order and every group operation | `packages/tmuxy-core/src/groups.rs` (the rules)<br>`packages/tmuxy-group/src/lib.rs` (`tmuxy-server group`, `tmuxy-group`)<br>`packages/tmuxy-cli/bin/tmuxy/pane-group` (wrapper) |
| Typed ids (pane, window, group) | `packages/tmuxy-core/src/ids.rs`<br>`packages/tmuxy-ui/src/domain/ids.ts` |
| Wire shapes and the client model derived from them | `packages/tmuxy-ui/src/domain/wire.ts`<br>`packages/tmuxy-ui/src/domain/client.ts` |
| The command vocabulary (every intent the UI sends) | `packages/tmuxy-ui/src/domain/commands.ts` (`TmuxOp`, `toTmuxCommand`)<br>`packages/tmuxy-ui/src/machines/app/dispatch.ts` |
| Client command errors | `packages/tmuxy-core/src/command_error.rs`<br>`packages/tmuxy-ui/src/infra/transport/AdapterError.ts` |
| The client's command table (names, argument and answer schemas) | `packages/tmuxy-ui/src/domain/backendCalls.ts`<br>`packages/tmuxy-core/src/host/command.rs`<br>`packages/protocol-fixtures/command_requests.json`, `command_results.json` |
| The transport service, its Layers and the state stream | `packages/tmuxy-ui/src/infra/transport/` (`TmuxTransport.ts`, `commandLane.ts`, `keyBatching.ts`, `layers.ts`, `stateFeed.ts`, `drivers/`)<br>`packages/tmuxy-ui/src/infra/runtime.ts` |
| Backend state aggregation and emit | `packages/tmuxy-core/src/control_mode/state.rs`<br>`packages/tmuxy-server/src/state.rs` |
| SSE/HTTP server flow | `packages/tmuxy-server/src` (see docs references) |
| Frontend state machine | `packages/tmuxy-ui/src/machines` (the XState machines); the four layers of `src/` and what each may import: `packages/tmuxy-ui/README.md` |
| CLI dispatcher and event queue | `packages/tmuxy-cli/bin/tmuxy-cli` |
| Tauri bridge and desktop shell | `packages/tmuxy-tauri-app` |
| Menus: one spec per surface, rendered in-app or natively | `packages/tmuxy-ui/src/domain/menus/` (the vocabulary, generic over the action: `spec.ts`; `icons.ts`, the item icons both renderers draw; `keyHint.ts`, key hints and key formatting)<br>`packages/tmuxy-ui/src/components/menus/specs/` (the app's specs per surface; `actions.ts`, the typed `AppMenuAction` and the `MENU_COMMANDS` table)<br>`packages/tmuxy-ui/src/components/menus/SpecMenu.tsx` (the in-app renderer and `useMenuDispatch`)<br>`packages/tmuxy-ui/src/infra/menus/nativeMenu.ts`, `components/menus/NativeMenuBar.tsx`, `useNativeMenu.ts` (the desktop's) |
| GUI windows on one session, and the Window menu | `packages/tmuxy-tauri-app/src/windows.rs`<br>`packages/tmuxy-ui/src/components/menus/specs/windowMenu.ts`<br>`packages/tmuxy-ui/src/infra/guiWindows.ts` |
| Window styles (iTerm2's set) | `packages/tmuxy-tauri-app/src/window_style.rs` |
| Trackpad gestures (desktop only): native phases → the grid | `packages/tmuxy-tauri-app/src/gestures.rs` (the shell's half)<br>`packages/tmuxy-ui/src/machines/gestures/gestureActor.ts` (`window.tmuxyGesture`)<br>`packages/tmuxy-ui/src/machines/app/actions/gestures.ts`, `machines/gestures/gestures.ts`, `components/gestures/GestureStage.tsx` |
| Menus, the tab preview, and the one-surface-at-a-time rule | `packages/tmuxy-ui/src/components/floating/Menu.tsx`<br>`packages/tmuxy-ui/src/components/floating/useFloatingSurface.ts`<br>`packages/tmuxy-ui/src/components/floating/surfaceRegistry.ts`<br>`packages/tmuxy-ui/src/components/TabPreview.tsx` |
| Session snapshots: save on change, restore on start, forget | `packages/tmuxy-core/src/session_snapshot.rs` (model, queries, `ps` discovery, storage, restore plan, keeper)<br>`packages/tmuxy-server/src/session_cli.rs` (`tmuxy session …`)<br>`packages/tmuxy-ui/src/components/menus/specs/sessionSwitcher.ts` (restorable rows) |
| The `preview` widget: `tmuxy open`, what it may read, the sandboxed page | `packages/tmuxy-cli/bin/tmuxy/tmuxy-widget-preview` (the CLI, the pane options, the file watch)<br>`packages/tmuxy-core/src/preview.rs` (authorisation, resource rules, the page policy and store)<br>`packages/tmuxy-server/src/sse/preview.rs`, `packages/tmuxy-tauri-app/src/commands.rs` (`read_preview`, `stage_preview`, `tmuxypreview:`)<br>`packages/tmuxy-ui/src/components/widgets/preview/` (markdown, page composition, bridge)<br>`packages/tmuxy-ui/src/domain/preview.ts` |
| Copy mode behavior | `docs/COPY-MODE.md` + related UI files |
| Rich rendering / OSC / image protocols | `docs/RICH-RENDERING.md` |
| Performance harnesses | `perf`<br>`packages/tmuxy-ui/scripts` |
| E2E and helper layers | `tests`<br>`tests/helpers` |
| Cross-layer invariants and the test holding each | `docs/INVARIANTS.md` |
| Every network connection (listeners, outbound requests, the website's analytics) | `docs/TELEMETRY.md` |

## Related docs

- `docs/ARCHITECTURE.md`
- `docs/STATE-MANAGEMENT.md`
- `docs/DATA-FLOW.md`
- `docs/DESKTOP.md`
- `docs/TMUX.md`
- `docs/CI-TRIAGE.md`
