# Invariants

Cross-layer promises, in one place, each with the test that holds it. Doc comments explain _how_ an invariant is kept; this file indexes _what_ is promised across a seam and _whether anything checks it_. Module-local assertions stay in code.

| Column | Meaning |
| --- | --- |
| `Id` | Stable name prefixed by seam. Cite in commits and test titles; never renumber. |
| `Kind` | `ordering` (A before B), `safety` (X never happens), `liveness` (Y happens within a bound). Ordering/liveness want a property or interleaving test, not one scripted run. |
| `Stated in` | Code defining the mechanism. |
| `Enforced by` | `file › test title`. `(example)` marks a single scripted run standing in for a property; `—` means uncovered. |

| Prefix | Seam |
| --- | --- |
| `A` | Control-mode events → `StateAggregator` → `SideEffect`s (`tmuxy-core`, sans-IO) |
| `M` | `SideEffect`s → `TmuxMonitor` dispatch → tmux commands (`tmuxy-core` runtime) |
| `X` | Tmux connection and command router (`tmuxy-core`) |
| `S` | Server → client stream: SSE seq, ring buffer, first state (`tmuxy-server`) |
| `C` | Client stream stage: sequencer, resync, per-frame coalescing (`tmuxy-ui`) |
| `Q` | Client command queue and keyboard batching (`tmuxy-ui`) |
| `P` | Client model: predictions and reconcile (`TmuxClientModel`) |
| `U` | UI-mode records: copy mode, resize preview, scrollback, menus |
| `R` | Read-only clients |
| `L` | Session lifecycle: attach, restore, autosave |

See `AGENTS.md`: a bug-fix commit on a seam cites or adds a row, and a row's enforcer is a test title that exists.

## A — aggregator effects

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| A1 | Step effect order: `AdoptUntaggedWindows` → `StoreImages`/`WriteClipboard` → `SendTmuxCommand`/`CommandReply` → `RefreshAfterWindowAdd` → `RefreshPanes` → `ResumePane` → `EmitState`. | ordering | `state.rs` (`step_at`) | `state_aggregator_props.rs › effects_within_a_step…`, `› the_seam_events_reach…` (property) |
| A2 | Window add/close relists before emit: `RefreshAfterWindowAdd` precedes `EmitState`. | ordering | `state.rs` (`step_at`) | `state_aggregator_props.rs › window_add_refresh_precedes_any_emit` (property); A1 |
| A3 | Tag-only steps promote to `Window` change so untagged windows emit immediately. | liveness | `state.rs` (`step_at`) | — |
| A4 | Captures route by marker, never arrival order or shape; dead-pane captures are discarded. | safety | `state.rs` (`queue_captures`) | `state.rs › capture_routing…`, `› capture_marker…`, `› capture_for_dead_pane…`, `› a_failed_capture…`; `state_aggregator_props.rs › queue_captures…` (property) |
| A5 | Output between reply markers skips pane/window parsers; mismatched END fails the older reply cleanly. | safety | `state.rs` (replies) | `state.rs › a_query_between_markers…`, `› a_mismatched_end_marker…`, `› non_list_panes_output…` |
| A6 | Reply-wrapped commands send `BEGIN`, cmd, `END` in order; `END` runs even after `%error`. | ordering | `state.rs` (`reply_wrapped_lines`) | `state.rs › reply_markers_collect…`, `› a_failed_block_fails…`; `reply_channel.rs › replies_come_back…` (real tmux) |
| A7 | Settling emits at most one `EmitState` and clears by safety ceiling (silently if idle). | liveness | `state.rs` (`arm_settling`, `tick`) | `state_aggregator_props.rs › settling_window…`, `› settling_round_trips`, `› suppressed_window…` (properties); `state_aggregator_sideeffects.rs › tick_after_deadline…`, `› tick_safety_timeout…` |
| A8 | `change_type` surfaces during suppressed emissions so settling timers extend on window changes. | liveness | `state.rs` (`step_at`) | `state_aggregator_sideeffects.rs › change_type_is_surfaced…`, `› step_at_extends…`; `state_aggregator_props.rs › emit_state_change…` (property) |
| A9 | Moved panes hold `%output` until capture lands and drop old content; others keep content during capture. | safety | `state.rs` (refill) | — |
| A10 | Stray `%end`/`%error` without `%begin` never produces a command response. | safety | `parser.rs` | `parser.rs › stray_end_without_begin_is_ignored`; `pane_bytes_props.rs › …arbitrary_lines`, `› …hostile_notifications` (properties) |

## M — monitor dispatch

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| M1 | Monitor dispatches step effects one-to-one in exact aggregator order. | ordering | `monitor.rs` | `monitor.rs › a_step_sends_its_effects_commands_in_effect_order` (example; order is A1) |
| M2 | Window add/close and initial sync send `list-panes` before `list-windows` (stash last) in monitor and wasm. | ordering | `state.rs`, `monitor.rs` | `monitor_command_order.rs › a_window_relist_sends_panes_before_windows…` |
| M3 | `RefreshPanes` sends `list-panes` before per-pane `capture-pane`s for fresh cursor positions. | ordering | `state.rs`, `monitor.rs` | `monitor_command_order.rs › a_pane_refresh_lists_panes_before_every_capture` (property) |
| M4 | Windows set `window-size manual` and `aggressive-resize off` before first `resizew` so SIGWINCH never races captures. | ordering | `monitor.rs` | `monitor.rs › a_window_is_told_to_stop_sizing_itself_before_it_is_sized` (example) |
| M5 | Client-size pass runs after the step's own effects, never ahead of `EmitState`. | ordering | `monitor.rs` | — |
| M6 | `GetState` waits for sync, captures, and queued refreshes (15 s cap); first state awaits resize up to 750 ms. | liveness | `monitor.rs`, `transport.rs`, `sse.rs` | `sse.rs › a_clients_first_state…`, `› a_first_state_waits…`, `› a_client_that_sets_no_size…`; `initial_state.rs`, `initial_state_history.rs` (real tmux) |
| M7 | Every reply resolves within `REPLY_TIMEOUT`, or immediately on send failure. | liveness | `monitor.rs` | `reply_channel.rs` (success/error; timeout is —) |
| M8 | Reply ids are monotonic so expired reply blocks never match newer ones. | safety | `monitor.rs` | — |
| M9 | `%session-changed` for another session is filtered before reaching the aggregator. | safety | `monitor.rs` | — |
| M10 | Resizes retry <=3 times per size after new tmux reports; new sizes reset count; unmonitored sizes re-request. | liveness | `monitor.rs`, `sse.rs` | `monitor.rs › a_window_tmux_did_not_resize…`, `› …not_asked_again…`, `› a_size_tmux_keeps_refusing…`, `› a_new_size_starts…`, `› a_window_with_no_panes…`; `sse.rs › a_size_that_reached_no_monitor…` |
| M11 | UI choices re-apply after `source-file` (UI wins), and enforced settings after both. | ordering | `monitor.rs` | `enforced_settings.rs › connecting_enforces_the_settings…` (final values; order is —) |

## X — the tmux connection and the router

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| X1 | Client commands keep pins intact, refuse `resize-window`, and rewrite `new-window` to `splitw ; breakp`. | safety | `command_router.rs` | `command_router.rs › a_pinned_list…`, `› resize_window_is_refused…`, `› new_window_is_rewritten…`; `pinned_split_race.rs › a_pinned_split_survives…` (real tmux) |
| X2 | No tmux subprocess runs while control mode is attached; all reads/writes use control mode (`docs/TMUX.md`). | safety | `command_router.rs`, `docs/TMUX.md` | `tests/cli/` (socket flag); ESLint ban on `tmuxExec` in E2E (`docs/TESTS.md`) |
| X3 | Control-mode client is never killed with SIGKILL; it detaches with a 3 s grace period. | safety | `connection.rs` | — |
| X4 | Attach and create serialize under one lock via `new-session -A`; attach never creates a session. | safety | `connection.rs` | `connection.rs › creating_a_session_attaches…`, `› attaching_never_creates_a_session` (lock is —) |

## S — server stream

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| S1 | Per-session broadcast seqs count from 1 (0 = empty) and the ring preserves concurrent broadcast order. | ordering | `tmuxy-server/src/state.rs` | `state.rs › seqs_are_monotonic…`, `› concurrent_broadcasters_keep…`, `› replay_since_returns…`, `› ring_buffer_drops_oldest…` |
| S2 | No duplicates or fillable gaps: connect replays from `Last-Event-Id + 1`; lag replays ring tail (dropping `<= last_replayed`) or leaves one edge gap for C1. | safety | `sse.rs` | `sse.rs › the_first_broadcast…`, `› a_lagged_stream…`, `› a_client_that_stops_reading…`, `› a_client_beyond_the_buffer…` |
| S3 | Reconnecting beyond the ring serves no replay so the first live delta triggers a gap refetch (C1). | safety | `sse.rs` | `sse.rs › a_client_beyond_the_buffer…` (`can_replay_from`; connect path is —) |
| S4 | Streams end on shutdown; the last client leaving keeps the monitor for a 2 s grace period. | liveness | `sse.rs` | `sse.rs › open_stream_ends…`, `› the_last_client_leaving_keeps…` |
| S5 | Monitor reconnect gives up after 5 short runs and broadcasts fatal so clients stop retrying. | liveness | `sse.rs` | — |

## C — client stream stage

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| C1 | Deltas apply only to their base state; missing, misordered, repeated or undecodable deltas drop and refetch full state. | safety | `stateSequencer.ts`, `stateFeed.ts`, `deltaProtocol.ts` | `stateSequencer.test.ts › asks for a resync…`, `› treats a payload…`; `stateFeed.test.ts › a payload…`; `deltaProtocol.test.ts`; `HttpAdapter.test.ts › a state update…` |
| C2 | Pre-full-state deltas are ignored; full states/answers carry `seq` so a delta lost after sync triggers a gap. | safety | `stateSequencer.ts`, `deltaProtocol.ts` | `stateSequencer.test.ts › ignores a delta…`, `› a delta lost…`; `stateFeed.props.test.ts › never paints backwards…` (property); `deltaProtocol.test.ts › no gap…` |
| C3 | At most one refetch runs in flight; arriving deltas are boundedly held, and failed refetches retry on next delta. | safety | `stateFeed.ts`, `stateSequencer.ts` | `stateFeed.props.test.ts › never paints backwards…` (property); `stateFeed.test.ts › a gap refetches…`; `stateSequencer.test.ts › the deltas…` |
| C4 | Post-refetch publish merges the answer, held deltas `> seq`, and queued deltas monotonically; held gaps refetch. | ordering | `stateFeed.ts`, `stateSequencer.ts` | `stateFeed.props.test.ts › never paints backwards…` (property) |
| C5 | Once synced, initial-state answers only fill empty panes; before sync or after a gap, they set starting state. | ordering | `deltaProtocol.ts`, `stateSequencer.ts` | `HttpAdapter.test.ts › an initial-state answer…`, `› …does not take back…`, `› after a gap…`; `stateSequencer.test.ts › after a gap…`; `stateFeed.props.test.ts › never paints backwards…` (property) |
| C6 | New connections or session switches reset sequencing so old delta seqs never gate new streams. | safety | `HttpAdapter.ts`, `TauriAdapter.ts` | — |
| C7 | Transport publishes events in arrival order (including pre-`connect` subscribers); web frame-hold never reorders state ahead of earlier events. | ordering | `TmuxTransport.ts`, `events.ts`, `stateFeed.ts` | `TmuxTransport.test.ts › publishes what the driver pushes…`; `stateFeed.test.ts › publishes a full state…` (examples; per-frame hold is —) |
| C8 | States coalesce to one per frame (latest wins); older states never paint after newer ones. | ordering | `stateFeed.ts` | — |
| C9 | Each pane id appears at most once in client state, and a delta removes exactly the panes it nulls. | safety | `deltaProtocol.ts` | `deltaProtocol.props.test.ts` (property) |
| C10 | Dropped/silent streams retry with backoff, online/visibility/Retry reconnect immediately, refused streams stop, and `EventSource` is singleton. | liveness | `HttpAdapter.ts` | `HttpAdapter.test.ts › keeps retrying…`, `› ten drops…`, `› a pinged stream…`, `› a stream the server refuses…`, `› dedupes concurrent…`; `tests/4-session-connectivity.test.js › six drops…` [nightly] |

## Q — command queue and input

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| Q1 | Mutations serialize in issue order so splits never land in a tab a queued `select-window` is leaving. | ordering | `HttpAdapter.ts`, `TauriAdapter.ts` | `HttpAdapter.test.ts › runs run_tmux_command…` (example; Tauri is —); `tests/4-session-connectivity.test.js › 2 panes → reload…` |
| Q2 | Keystroke batches share the mutation queue and non-`send-keys` flush pending batches first. | ordering | `TauriAdapter.ts`, `HttpAdapter.ts`, `keyBatching.ts` | `keyBatching.test.ts › flushAll drains…` (batcher only; mutation interleaving is —) |
| Q3 | Lone keystrokes send on leading edge; literal/special order holds; hex-byte sends (`-H`) never batch. | ordering | `keyBatching.ts` | `keyBatching.test.ts › sends an isolated…`, `› preserves literal→special…`, `› preserves special→literal…`, `› never intercepts…`; `tests/1-input-interaction.test.js › Type → backspace…` |
| Q4 | Client reads (`query_tmux`) run unserialized; order vs. mutations holds in-band on control mode (A6). | ordering | `HttpAdapter.ts`, `docs/DATA-FLOW.md` | — |

## P — client model

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| P1 | Placeholder (predicted) pane or window ids are never sent to tmux as targets. | safety | `commands.ts` | `dispatch.test.ts › leaves the target to tmux…`, `› once tmux has confirmed them…` |
| P2 | Ops mark in-flight before send and always settle: unacked sweeps at `OP_STALE_TIMEOUT_MS`, acked at `OP_ACKED_STALE_TIMEOUT_MS`, errors roll back. | liveness | `TmuxStore.ts`, `model.ts`, `types.ts` | `model.test.ts › stale ops…`, `› in-flight ops…`; `TmuxStore.test.ts › dispatch rolls back…`, `› TransportError…` |
| P3 | Pending ops re-reconcile on a timer so time-based verdicts fire on an idle stream. | liveness | `TmuxStore.ts` | — |
| P4 | Confirmed focus ops linger (`FOCUS_CONFIRM_LINGER_MS`), yield to a 3rd pane after `FOCUS_SUPERSEDE_GRACE_MS`, drop on newer focus, and skip dead panes. | ordering | `ops.ts`, `model.ts` | `ops.test.ts › holds a confirmed…`, `› holds through stale…`, `› holds briefly…` (examples; `dropSupersededFocusOps` is —); `tests/2-layout-navigation.test.js › Clicking an inactive tab…` [nightly] |
| P5 | In-flight splits never claim the same pane id within a reconcile pass. | safety | `ops.ts` (`reconcile`) | — |
| P6 | `NewWindow` placeholders match only tab windows with a pane; the patch hides unmatched newborns. | safety | `windowOps.ts` | `ops.test.ts › stays pending until…`, `› patch hides a tab-typed-but-paneless…` |
| P7 | Session switch clears pending ops and committed state before the new session's first state. | ordering | `tmuxStoreActor.ts`, `appMachine.ts` | `workflows.test.ts › TmuxStore — clear…` (store only; order vs. first state is —) |
| P8 | `MoveWindow` predicts dropped strip order immediately and holds until server places the window beside its anchor. | ordering | `windowOps.ts`, `tabOverview.ts` | `ops.test.ts › MoveWindow predict…`; `tests/2-layout-navigation.test.js › a tab dragged along the strip…` |

## U — UI-mode records

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| U1 | At most one copy-mode record per pane; exit closes only if seen in mode, cooldown ignores stale `in_mode`, and viewers never auto-enter. | ordering | `copyMode.ts`, `docs/COPY-MODE.md` | `reconcilePaneMode.test.ts › a snapshot…`, `› is ignored…`, `› never happens…`; `copyMode.test.ts › the end of a blink…` (examples) |
| U2 | Resize preview holds for two matching quiet updates or a 2 s fallback that never clobbers newer resizes. | liveness | `appMachine.ts`, `layout.ts` | `layout.test.ts › the 2s RESIZE_COMPLETED…`, `› …does not clobber…` (two-quiet-updates hold is —) |
| U3 | Only the latest scrollback fetch per pane applies; different panes fetch concurrently without cancelling. | ordering | `tmuxActor.ts` | `tmuxActor.test.ts › interrupts the previous fetch…`, `› different paneId fetches…` |
| U4 | Group switch holds swap over stale snapshots, drops if a pane dies, and never selects parked/stash panes. | safety | `appMachine.ts`, `windowOps.ts` | `tests/7-regression-bugs.test.js › Clicking three pane-group tabs…` [nightly] (E2E only) |
| U5 | Every menu renders a `domain/menus/` spec and dispatches via `executeMenuAction` or machine events. | safety | `domain/menus/`, `SpecMenu.tsx`, `nativeMenu.ts` | `specs.test.ts`; `menuActions.test.ts › sends the op of every op-backed item…` |

## R — read-only clients

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| R1 | Read-only clients allow only read commands, cancel mutations, and never send a viewport. | safety | `readOnly.ts`, `HttpAdapter.ts`, `stateFeed.ts` | `HttpAdapter.test.ts › a read-only server…`; `tests/10-read-only.test.js › viewer follows output…`, `› a viewer cannot reach…` |
| R2 | Read-only store predicts only local focus, and `notReadOnly` drops mutating events before side effects. | safety | `TmuxStore.ts`, `readOnlyGuard.ts`, `tmuxActor.ts` | `TmuxStore.test.ts › refuses anything…`, `› a tab switch…`, `› pane focus is kept…`; guard is E2E only (`tests/10-read-only.test.js`) |

## L — session lifecycle

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| L1 | Snapshot restore runs after attach/sync and holds autosave from before spawn so placeholders aren't saved and live sessions aren't overwritten. | ordering | `transport.rs`, `session_snapshot.rs` | `session_snapshot.rs › a_restore_in_flight…`; `transport.rs › a_running_session_is_not_restored_over` |
| L2 | Restore plans avoid `new-window`, split panes in index order, apply layouts after splits, and restore focus last. | ordering | `session_snapshot.rs` | `session_snapshot.rs › a_restore_never_uses…`, `› focus_is_restored_last`, `› a_reordered_group…`; `tests/15-session-snapshot.test.js › the shape survives…` [nightly] |
| L3 | New sessions are never created on a closing connection. | safety | `appMachine.ts`, `HttpAdapter.ts` | `tests/4-session-connectivity.test.js` (regression example) |
| L4 | Disconnect during `connecting` transitions to `disconnected`, never a stuck spinner. | liveness | `appMachine.ts` (`connecting`) | `disconnected.test.ts › ends a connection…`, `› ends a reconnection…` |

## What the ledger says today

- **Uncovered (`—`)**: A3, A9, M5, M8, M9, X3, S5, C6, C8, Q4, P3, P5.
- **Partial**: M7 (timeout), M11 (order), X4 (lock), S3 (connect), C7 (frame hold), Q1 (Tauri), Q2 (interleaving), P4 (`dropSupersededFocusOps`), P7 (first-state order), U2 (2-update hold).
- **Example only**: M1, M4, Q1, U1.
- **Property**: C3–C5 (`stateFeed.props.test.ts`) and S2 (`sse.rs`).

## Related

- `docs/STATE-MANAGEMENT.md`, `docs/DATA-FLOW.md`, `docs/TESTS.md`, `docs/TMUX.md`
