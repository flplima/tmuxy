# Architecture Index

Feature-to-files retrieval map for agents.

| Feature | Key files |
| --- | --- |
| tmux control-mode command routing | `packages/tmuxy-core/src/command_router.rs`<br>`packages/tmuxy-core/src/command_router/cli_run.rs` (what `tmuxy run` passes on)<br>`packages/tmuxy-ui/src/infra/transport/drivers/TauriAdapter.ts` |
| A CLI verb's mutation, inside `run-shell` as the caller's pane | `packages/tmuxy-core/src/run_shell.rs`<br>`packages/tmuxy-cli/bin/tmuxy/_lib` (`_run_shell`, `_run_as_caller`) |
| The CLI's contract: exit codes, `--json` answers | `packages/tmuxy-core/src/cli_contract.rs`<br>`packages/tmuxy-verbs/src/cli_json.rs`<br>`packages/tmuxy-cli/bin/tmuxy/_contract` |
| Removing a git worktree without losing work (`tmuxy worktree remove`) | `packages/tmuxy-core/src/worktrees/guard.rs`<br>`packages/tmuxy-verbs/src/worktree_cli.rs` |
| Values the UI, the CLI scripts, the guests and CI share with tmuxy-core and the workspace (generated files) | `packages/tmuxy-core/tests/generated_constants.rs`<br>`packages/tmuxy-core/tests/generated/crate-graph.gen.json` (the crate graph, from `cargo metadata`) |
| Unguessable tokens (marker, plugin, ask, MCP, trace salt) | `packages/tmuxy-core/src/random.rs` |
| What tmux leaves unannounced (the re-lists behind a command), and the map of version workarounds | `packages/tmuxy-core/src/tmux_compat.rs` |
| The monitor loop (connect, back off, give up, restore before create, autosave) and what each host does around it | `packages/tmuxy-core/src/host/supervise.rs`<br>`packages/tmuxy-core/src/host/start.rs` (start-up and shut-down beside the sessions)<br>`packages/tmuxy-core/src/host/requests.rs` (what a host answers a client's requests with)<br>`packages/tmuxy-server/src/sse/monitor.rs`<br>`packages/tmuxy-tauri-app/src/monitor.rs` |
| The tmux config tmuxy ships (the defaults, the essentials, the user template), the code that mirrors it and builds the chain, and the pins | `packages/tmuxy-core/assets/*.conf`<br>`packages/tmuxy-core/src/session/config.rs`<br>`packages/tmuxy-core/src/paths.rs` (every file and directory) |
| `tmuxy config doctor`: what is wrong with the user's config, and `--fix` | `packages/tmuxy-core/src/session/doctor.rs` (the checks)<br>`packages/tmuxy-verbs/src/config_cli.rs` (the `config` verb) |
| `tmuxy config check`: a config's problems with file and line, found without applying it; a reload refused while tmux cannot parse it | `packages/tmuxy-core/src/session/check.rs` (the throwaway tmux, the checks)<br>`packages/tmuxy-core/src/host/bindings.rs` (`refuse_broken_config`)<br>`packages/tmuxy-core/src/control_mode/monitor/sync.rs` (`source_chain`, on connect) |
| `tmuxy keymap`: every binding with the file and line it comes from, what a later line replaced | `packages/tmuxy-core/src/session/keymap.rs` (reads the chain's files)<br>`packages/tmuxy-verbs/src/keymap_cli.rs` (the verb, and tmux's own bindings from a running server)<br>`packages/tmuxy-verbs/src/keymap_cli/plugins.rs` (plugin keys, the user's actions and verbs) |
| Pane groups: membership, order and every group operation | `packages/tmuxy-core/src/groups.rs` (the rules)<br>`packages/tmuxy-verbs/src/group_cli.rs` (the `group` verb)<br>`packages/tmuxy-cli/bin/tmuxy/pane-group` (wrapper) |
| A pane's screen as HTML (`tmuxy pane capture --format html`) | `packages/tmuxy-core/src/capture_html.rs` (the renderer, over the vt100 cells the panes are drawn from)<br>`packages/tmuxy-verbs/src/capture_cli.rs` (the `capture-html` verb)<br>`packages/tmuxy-cli/bin/tmuxy/cli-pane-run.sh` (`cmd_pane_capture`) |
| Typed ids (pane, window, group) | `packages/tmuxy-core/src/ids.rs`<br>`packages/tmuxy-ui/src/domain/ids.ts` |
| Wire shapes and the client model derived from them | `packages/tmuxy-ui/src/domain/wire.ts`<br>`packages/tmuxy-ui/src/domain/client.ts` |
| The command vocabulary (every intent the UI sends) | `packages/tmuxy-ui/src/domain/commands.ts` (`TmuxOp`, `toTmuxCommand`)<br>`packages/tmuxy-ui/src/machines/app/dispatch.ts` |
| Client command errors | `packages/tmuxy-core/src/command_error.rs`<br>`packages/tmuxy-ui/src/infra/transport/AdapterError.ts` |
| The client's command table (names, argument and answer schemas) | `packages/tmuxy-ui/src/domain/backendCalls.ts`<br>`packages/tmuxy-core/src/host/command/wire.rs` (the commands), `packages/tmuxy-core/src/host/command.rs` (the handler)<br>`packages/protocol-fixtures/command_requests.json`, `command_results.json` |
| The transport service, its Layers and the state stream | `packages/tmuxy-ui/src/infra/transport/` (`TmuxTransport.ts`, `commandLane.ts`, `keyBatching.ts`, `layers.ts`, `stateFeed.ts`, `drivers/`)<br>`packages/tmuxy-ui/src/infra/runtime.ts` |
| Backend state aggregation and emit | `packages/tmuxy-core/src/control_mode/state.rs`<br>`packages/tmuxy-server/src/state.rs` |
| SSE/HTTP server flow | `packages/tmuxy-server/src/server.rs` (the listener, the router, the frontend fallback, `tmuxy server` and its verbs)<br>`packages/tmuxy-server/src/sse.rs` and `sse/` (the `/events` stream, `/commands`, the per-session clients and monitor)<br>`packages/tmuxy-server/src/state.rs` (`AppState`, the API routes, the replay ring buffer)<br>`packages/tmuxy-server/src/request_guard.rs` (the origin and `Host` rules) |
| Server stop and status, by port | `packages/tmuxy-server/src/server/lifecycle.rs` (the pid file, the shutdown)<br>`packages/tmuxy-server/src/server/listener.rs` (the process listening on a port, through the OS) |
| The MCP endpoint (`/mcp`, `tmuxy mcp`) | `packages/tmuxy-server/src/mcp.rs`<br>`packages/tmuxy-cli/bin/tmuxy/cli-mcp.sh`<br>`docs/MCP.md` |
| Web push notifications (`/api/push`, `/api/push/subscription`) | `packages/tmuxy-server/src/push.rs` (the VAPID key, subscribe and unsubscribe, delivery; the store under `push/`)<br>`packages/tmuxy-ui/src/infra/pushNotifications.ts` |
| Frontend state machine | `packages/tmuxy-ui/src/machines` (the XState machines); the four layers of `src/` and what each may import: `packages/tmuxy-ui/README.md` |
| CLI dispatcher and event queue | `packages/tmuxy-cli/bin/tmuxy-cli` |
| Tauri bridge and desktop shell | `packages/tmuxy-tauri-app` |
| Menus: one spec per surface, rendered in-app or natively | `packages/tmuxy-ui/src/domain/menus/` (the vocabulary, generic over the action: `spec.ts`; `icons.ts`, the item icons both renderers draw)<br>`packages/tmuxy-ui/src/domain/keyLabels.ts` (every key label the app shows — menu hints, tooltips, the status line, the keys view — read from the bindings in every table and the client's own keys in `domain/keyTables.ts`)<br>`packages/tmuxy-ui/src/components/menus/specs/` (the app's specs per surface; `actions.ts`, the typed `AppMenuAction` and the `MENU_COMMANDS` table)<br>`packages/tmuxy-ui/src/components/menus/SpecMenu.tsx` (the in-app renderer and `useMenuDispatch`)<br>`packages/tmuxy-ui/src/infra/menus/nativeMenu.ts`, `components/menus/NativeMenuBar.tsx`, `useNativeMenu.ts` (the desktop's) |
| Command palette: the menu specs walked flat, plus sessions, tabs and panes to go to | `packages/tmuxy-ui/src/domain/palette/` (`entries.ts`, a spec as rows; `fuzzy.ts`, the match and its ranking)<br>`packages/tmuxy-ui/src/components/palette/` (`paletteEntries.ts`, the rows from the machine's context; `CommandPalette.tsx`)<br>`packages/tmuxy-ui/src/machines/app/actions/palette.ts` (open and close, and `GO_TO`, which switches session before it picks a pane there) |
| GUI windows, a new one's splash page (a local session, a new one, or a host over ssh, and that host's connection), and the Window menu | `packages/tmuxy-tauri-app/src/windows.rs`, `windows/attach.rs`, `windows/ssh_link.rs`, `commands/gui_windows.rs`<br>`packages/tmuxy-ui/src/components/SplashScreen.tsx`, `SplashSshForm.tsx`, `infra/splashWindow.ts`<br>`packages/tmuxy-ui/src/components/menus/specs/windowMenu.ts`<br>`packages/tmuxy-ui/src/infra/guiWindows.ts` |
| Window styles (iTerm2's set) | `packages/tmuxy-tauri-app/src/window_style.rs` |
| Trackpad gestures (desktop only): native phases → the grid | `packages/tmuxy-tauri-app/src/gestures.rs` (the shell's half)<br>`packages/tmuxy-ui/src/machines/gestures/gestureActor.ts` (`window.tmuxyGesture`)<br>`packages/tmuxy-ui/src/machines/app/actions/gestures.ts`, `machines/gestures/gestures.ts`, `components/gestures/GestureStage.tsx` |
| Menus, the tab preview, and the one-surface-at-a-time rule | `packages/tmuxy-ui/src/components/floating/Menu.tsx`<br>`packages/tmuxy-ui/src/components/floating/useFloatingSurface.ts`<br>`packages/tmuxy-ui/src/components/floating/surfaceRegistry.ts`<br>`packages/tmuxy-ui/src/components/TabPreview.tsx` |
| The `diff` widget: a checkout's changes by scope, git that runs nothing the repository names | `packages/tmuxy-core/src/diff_review.rs` (the read, its authorisation)<br>`packages/tmuxy-core/src/diff_review/git.rs` (the git it runs)<br>`packages/tmuxy-ui/src/components/widgets/diff/` (the widget)<br>`packages/tmuxy-cli/bin/tmuxy/tmuxy-widget-diff` (`tmuxy widget diff`) |
| Session snapshots: save on change, restore on start, forget | `packages/tmuxy-core/src/session_snapshot.rs` (model, queries, `ps` discovery, storage, restore plan, keeper)<br>`packages/tmuxy-verbs/src/session_cli.rs` (`tmuxy session …`)<br>`packages/tmuxy-ui/src/components/menus/specs/sessionSwitcher.ts` (restorable rows) |
| The `preview` widget: `tmuxy open`, what it may read, the sandboxed page | `packages/tmuxy-cli/bin/tmuxy/tmuxy-widget-preview` (the CLI, the pane options, the file watch)<br>`packages/tmuxy-core/src/preview.rs` (authorisation, resource rules, the page policy and store)<br>`packages/tmuxy-server/src/sse/preview.rs`, `packages/tmuxy-tauri-app/src/commands.rs` (`read_preview`, `stage_preview`, `tmuxypreview:`)<br>`packages/tmuxy-ui/src/components/widgets/preview/` (markdown, page composition, bridge)<br>`packages/tmuxy-ui/src/domain/preview.ts` |
| The e-ink page (`/?kindle`) for browsers too old for the app | `packages/tmuxy-ui/src/kindle/` (`main.ts`, the page; `grid.ts`, the drawn grid)<br>`packages/tmuxy-ui/kindle.html`, `vite.kindle.config.ts`, `public/kindle-redirect.js`<br>`docs/ARCHITECTURE.md` § The e-ink page |
| The phone layout: keys, the bar that zooms or folds the terminal, the bottom view, held sideways, touch | `docs/PHONE.md`<br>`packages/tmuxy-ui/src/infra/dom/phoneLayout.ts`, `domain/phoneSplit.ts`<br>`packages/tmuxy-ui/src/components/phone/` (`PhoneDivider.tsx`, `PhoneBottomView.tsx`, `PhoneLeftSide.tsx`, `PhoneDock.tsx`, `KeyRow.tsx`)<br>`packages/tmuxy-ui/src/styles/phone.css`, `machines/app/actions/phone.ts` |
| The open-link modifier (Cmd / Ctrl held reveals and arms auto-detected URLs) | `packages/tmuxy-ui/src/machines/actors/linkModifierActor.ts` |
| Copy mode behavior | `docs/COPY-MODE.md` + related UI files |
| Rich rendering / OSC / image protocols | `docs/RICH-RENDERING.md` |
| Performance harnesses | `tests/perf`<br>`packages/tmuxy-ui/scripts` |
| E2E and helper layers | `tests`<br>`tests/helpers` |
| Cross-layer invariants and the test holding each | `docs/INVARIANTS.md` |
| Every network connection (listeners, outbound requests, the website's analytics) | `docs/TELEMETRY.md` |

## Generated files

Never edited by hand. The first column is what is committed; the last is what fails while it is stale.

| File | Generated by | Stale check |
| --- | --- | --- |
| `packages/tmuxy-ui/src/domain/tmuxyConstants.gen.ts`, `packages/tmuxy-ui/src/infra/__tests__/openableUrlCases.gen.json`, `packages/tmuxy-ui/scripts/lib/guest.gen.json`, `packages/tmuxy-ui/src/infra/transport/drivers/guest/defaultKeybindings.gen.json`, `packages/tmuxy-cli/bin/tmuxy/_options` | `UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants` | `packages/tmuxy-core/tests/generated_constants.rs`, one test per file |
| `packages/tmuxy-core/tests/generated/crate-graph.gen.json` (the crate graph, from `cargo metadata`) | the same command | the same file's `the_crate_graph_is_cargos`; `bin/ci/crate-graph.test.mjs` reads it |
| the JSON in `packages/protocol-fixtures/` (requests, results, errors, events) | `UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-core protocol_fixtures` | `packages/tmuxy-core/src/host/protocol_fixtures.rs`, and `packages/tmuxy-ui/src/infra/transport/__tests__/protocolFixtures.test.ts` over the same files |
| `packages/tmuxy-ui/src/stories/fixtures/gen/` (states recorded from real tmux) | `node scripts/record-story-fixtures.mjs` from `packages/tmuxy-ui`, after `cargo build --release -p tmuxy-server` | none — `FixtureAdapter` replays whatever was last recorded |

## Related docs

- `docs/ARCHITECTURE.md`
- `docs/STATE-MANAGEMENT.md`
- `docs/DATA-FLOW.md`
- `docs/DESKTOP.md`
- `docs/TMUX.md`
- `docs/CI-TRIAGE.md`
