# Invariants

Cross-layer promises, each with the test that holds it. Doc comments explain _how_ an invariant is kept; this file indexes _what_ is promised across a seam and _whether anything checks it_. Module-local assertions stay in code.

| Column | Meaning |
| --- | --- |
| `Id` | Stable name prefixed by seam. Cite in commits and test titles; never renumber. |
| `Kind` | `ordering` (A before B), `safety` (X never happens), `liveness` (Y happens within a bound). Ordering/liveness want a property or interleaving test, not one scripted run. |
| `Stated in` | Code defining the mechanism. |
| `Enforced by` | `file › test title`. `(example)` marks a single scripted run standing in for a property; `—` means uncovered. |

| Prefix | Seam |
| --- | --- |
| `A` | Control-mode events → `StateAggregator` → `SideEffect`s (`tmuxy-core`, sans-IO) |
| `M` | `SideEffect`s → `MonitorCore` → each host's dispatch → tmux commands (`tmuxy-core`, the native monitor and the wasm guest) |
| `X` | Tmux connection and command router (`tmuxy-core`) |
| `S` | Server → client stream: SSE seq, ring buffer, first state (`tmuxy-server`) |
| `C` | Client stream stage: sequencer, resync, per-frame coalescing (`tmuxy-ui`) |
| `Q` | Client command queue and keyboard batching (`tmuxy-ui`) |
| `P` | Client model: predictions and reconcile (`TmuxClientModel`) |
| `U` | UI-mode records: copy mode, resize preview, scrollback, menus |
| `L` | Session lifecycle: attach, restore, autosave |

See `AGENTS.md`: a bug-fix commit on a seam cites or adds a row, and a row's enforcer is a test title that exists (the lint gate's policy step checks each one: `bin/ci/invariant-enforcers.mjs`).

## A — aggregator effects

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| A1 | Step effect order: `Send(WindowSetup)` → `Notify` (images, clipboard, messages) → `Send(Own)`/`Reply` → `Send(WindowRelist)` → `Send(PaneRefresh)` → `Send(Resume)` → `Emit`. | ordering | `state/step_and_output.rs` (`step_at`) | `state_aggregator_props.rs › effects_within_a_step…`, `› the_seam_events_reach…` (property) |
| A2 | Window add/close relists before emit: `Send(WindowRelist)` precedes `Emit`. | ordering | `state/step_and_output.rs` (`step_at`) | `state_aggregator_props.rs › window_add_refresh_precedes_any_emit` (property); A1 |
| A3 | Tag-only steps promote to `Window` change so untagged windows emit immediately. | liveness | `state/step_and_output.rs` (`step_at`) | — |
| A4 | Every read the aggregator issues — captures, `list-panes`, `list-windows`, the stash list, buffer and client reads — routes by its marker, never arrival order or shape; an unmarked block changes nothing; dead-pane captures are discarded. | safety | `state/markers.rs` (`Read`), `state/command_response.rs` | `state/tests_capture.rs › capture_routing…`, `› capture_marker…`, `› capture_for_dead_pane…`, `› a_failed_capture…`, `control_mode/state/tests.rs › an_unmarked_ack_changes_nothing`, `› non_list_panes_output…`; `state_aggregator_props.rs › queue_captures…` (property) |
| A5 | Output between reply markers skips pane/window parsers; mismatched END fails the older reply cleanly. | safety | `state.rs` (replies) | `control_mode/state/tests.rs › a_query_between_markers…`, `› a_mismatched_end_marker…`, `› non_list_panes_output…` |
| A6 | Reply-wrapped commands send `BEGIN`, cmd, `END` in order, each its own line; `END` runs even after `%error`. | ordering | `state/markers.rs` (`reply_wrapped_lines`) | `control_mode/state/tests.rs › reply_markers_collect…`, `› a_failed_block_fails…`; `reply_channel.rs › replies_come_back…` (real tmux); `AppOptimistic.stories.tsx › RefusedSplitReportsTmuxsReason` (v86) |
| A7 | Settling emits at most one `EmitState` and clears by safety ceiling (silently if idle). | liveness | `state.rs` (`arm_settling`, `tick`) | `state_aggregator_props.rs › settling_window…`, `› settling_round_trips`, `› suppressed_window…` (properties); `state_aggregator_sideeffects.rs › tick_after_deadline…`, `› tick_safety_timeout…` |
| A8 | `change_type` surfaces during suppressed emissions so settling timers extend on window changes. | liveness | `state.rs` (`step_at`) | `state_aggregator_sideeffects.rs › change_type_is_surfaced…`, `› step_at_extends…`; `state_aggregator_props.rs › emit_state_change…` (property) |
| A9 | Moved panes hold `%output` until a capture lands or fails, dropping old content. | safety | `state.rs` | `tests_capture.rs › a_moved_pane…` |
| A10 | Stray `%end`/`%error` without `%begin` never produces a command response. | safety | `parser.rs` | `parser/tests.rs › stray_end_without_begin_is_ignored`; `pane_bytes_props.rs › …arbitrary_lines`, `› …hostile_notifications` (properties) |
| A11 | A pane's output bytes reach the emulator exactly, wherever tmux cut its `%output` lines — a character split across lines included; pane output is never read as text. | safety | `parser.rs` (`parse_line`), `connection/spawn.rs` | `pane_bytes_props.rs › output_cut_anywhere_carries_the_bytes` (property); `control_mode_push_api.rs › a_character_split_across_output_lines_reaches_the_screen_whole` |
| A12 | An in-browser guest runs the native client core (`MonitorCore`, compiled to wasm): its replies are the core's (what came between the reply's markers, a relayed `run-shell`'s output, tmux's refusal, a timeout), and its attach, routing and timers are the native ones. | safety | `tmuxy-wasm/src/lib.rs`; `guest/GuestEngine.ts` | `tmuxy-wasm/src/lib.rs › replies_refusals_messages_and_the_end_reach_the_guest`, `› the_attach_is_the_native_monitors`; `replyBook.test.ts` |
| A13 | Pane output in a block is only its body: a block closes only on the `%end`/`%error` repeating its `%begin`'s guard, markers carry the aggregator's random token, and the block after a read's BEGIN (a capture, a list, a buffer or client read) is that read's output whatever it says. | safety | `parser/block.rs`; `state/markers.rs` | `pane_bytes_props.rs › a_blocks_body_is_whatever…` (property); `parser/tests.rs › a_block_closes_only_on_the_guard…`; `state_aggregator_props.rs › a_capture_lands_on_its_pane_whatever…`, `› a_reply_is_what_lies…` (properties); `pane_output_spoofs.rs › a_pane_printing_tmuxys_markers_cannot_stall…` (real tmux) |

## M — monitor dispatch

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| M1 | Every host runs the core's actions one-to-one, in the order the core returns them, dropping none. | ordering | `monitor_core.rs` (`Action`); `monitor/event_loop.rs` (`dispatch`); `tmuxy-wasm/src/lib.rs` (`apply`) | `monitor/tests.rs › a_step_sends_its_effects_commands_in_effect_order` (example; order is A1); `tmuxy-wasm/src/lib.rs › replies_refusals_messages…` |
| M2 | Every re-list of the windows — add/close, the attach, the metadata sync, the idle heartbeat, a reorder — sends `list-panes` before `list-windows`, the stash last. | ordering | `state/markers.rs` (`window_relist_commands`), `monitor_core.rs` | `monitor_command_order.rs › a_window_relist_sends_panes_before_windows…`; `monitor_core/tests.rs › an_attach_enforces…`, `› a_pane_that_keeps_printing…`, `› the_idle_heartbeat_lists_panes…`, `› a_command_settles_or_relists…` |
| M3 | A pane refresh, and the copy-mode poll, send `list-panes` before per-pane `capture-pane`s for fresh cursor positions. | ordering | `state/window_state.rs` (`pane_refresh_commands`) | `monitor_command_order.rs › a_pane_refresh_lists_panes_before_every_capture` (property) |
| M4 | Windows set `window-size manual` and `aggressive-resize off` before first `resizew` so SIGWINCH never races captures. | ordering | `state/window_state.rs` (`window_setup_commands`), `monitor_core.rs` | `monitor/tests.rs › a_window_is_told_to_stop_sizing_itself_before_it_is_sized` (example) |
| M5 | Client-size pass runs after the step's own effects, never ahead of `Emit`. | ordering | `monitor_core.rs` (`step`) | — |
| M6 | `GetState` waits for sync, captures, and queued refreshes (15 s cap); first state awaits resize up to 750 ms. | liveness | `monitor.rs`, `host/requests.rs`, `sse.rs` | `sse/tests_sessions.rs › a_clients_first_state…`, `› a_first_state_waits…`, `› a_client_that_sets_no_size…`; `initial_state.rs`, `initial_state_history.rs` (real tmux) |
| M7 | Every reply resolves within `REPLY_TIMEOUT`, or immediately on send failure. | liveness | `monitor_core/replies.rs` | `monitor_core/tests.rs › a_callers_command_is_answered_by_its_reply_or_its_timeout`; `reply_channel.rs` (real tmux) |
| M8 | Reply ids are monotonic so expired reply blocks never match newer ones. | safety | `monitor_core.rs` | — |
| M9 | A session event about another session changes nothing: one is ours by the id `%session-changed` gave once known, by the configured name before. | safety | `state/events.rs` (`names_our_session`) | `monitor_core/tests.rs › a_session_event_about_another_session_changes_nothing` |
| M10 | Resizes retry <=3 times per size after new tmux reports; new sizes reset count; unmonitored sizes re-request. | liveness | `monitor_core/sizing.rs`, `sse.rs` | `monitor_core/tests.rs › a_window_tmux_did_not_resize…`, `› …not_asked_again…`, `› a_size_tmux_keeps_refusing…`, `› a_new_size_starts…`, `› a_window_with_no_panes…`; `host/runtime_tests.rs › a_size_that_reached_no_monitor…` |
| M11 | UI choices re-apply after every `source-file` (connect, reload, a client's own) and win, unless the user's `tmuxy.conf` pins the option; enforced settings after both. | ordering | `monitor_core/attach.rs`, `monitor/sync.rs`, `session/state.rs`, `host/bindings.rs` | `enforced_settings.rs › connecting_enforces_the_settings…` (final values, every window); `monitor_core/tests.rs › an_attach_enforces_the_settings_after_the_config…` (order); `session/tests.rs › a_pinned_option_is_not_reapplied…` (the pin) |
| M12 | A paced link (`ReadPacing::OneBatchInFlight`, the guest) has one batch of reads out; reads asked for meanwhile go once each in the next batch, after tmux answers or `REPLY_TIMEOUT`. | liveness | `monitor_core/reads.rs` | `monitor_core/tests_reads.rs › on_a_paced_link_reads_asked_for_while_a_batch_is_out_go_once_after_it`, `› …copy_mode_poll_waits_for_its_answer`, `› …unanswered_batch_is_given_up_at_the_reply_timeout` |

## X — the tmux connection and the router

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| X1 | Client commands keep pins intact, refuse `resize-window`, and rewrite `new-window` to `splitw ; breakp`. | safety | `command_router.rs` | `command_router.rs › a_pinned_list…`, `› resize_window_is_refused…`, `› new_window_is_rewritten…`; `pinned_split_race.rs › a_pinned_split_survives…` (real tmux) |
| X2 | No tmux subprocess runs while control mode is attached; all reads/writes use control mode (`docs/TMUX.md`). | safety | `command_router.rs`, `docs/TMUX.md` | `tests/cli/` (socket flag); ESLint ban on `tmuxExec` in E2E (`docs/TESTS.md`) |
| X3 | Control-mode client is never killed with SIGKILL; it detaches with a 3 s grace period. | safety | `connection.rs` | — |
| X4 | Attach and create serialize under one lock via `new-session -A`; attach never creates a session. | safety | `connection.rs` | `connection/tests.rs › creating_a_session_attaches…`, `› attaching_never_creates_a_session` (lock is —) |
| X5 | The router sees every command a client sends: each line, each command where tmux would split it (`;`, `\;`, newline, `{ … }` blocks; tmux quoting), under every name tmux runs it by, and writes the `\;` separator as `;` once. No blank line reaches control mode; one write is one line. | safety | `command_router.rs`; `tmux_command.rs`; `connection.rs` | `command_router.rs › resize_window_is_refused_however…`, `› new_window_is_rewritten_on_whatever_line…`, `› lines_go_out_as_they_came…`, `› brace_blocks_are_routed_whole`, `› long_verbs_and_quoted_separators…`; `tmux_command/tests.rs › a_list_splits_where_tmux_does`, `› a_command_is_seen_under_every_name…`, `› a_list_runs_the_commands_of_its_blocks`, `› escaped_separators_become_plain_ones…` |
| X6 | A client query runs only tmux's reads; anything else in it is refused as `forbidden` (it belongs to `run_tmux_command`). | safety | `command_router.rs` (`route_query`) | `command_router.rs › a_query_that_reads_routes…`, `› a_query_that_would_change_anything…`; `sse/tests_errors.rs › a_mutation_sent_as_a_query…` |

## S — server stream

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| S1 | Per-session broadcast seqs count from 1 (0 = empty) and the ring preserves concurrent broadcast order. | ordering | `tmuxy-server/src/state.rs` | `state/broadcast_tests.rs › seqs_are_monotonic…`, `› concurrent_broadcasters_keep…`, `› replay_since_returns…`, `› ring_buffer_drops_oldest…` |
| S2 | No duplicates or fillable gaps: connect replays from `Last-Event-Id + 1`; lag replays ring tail (dropping `<= last_replayed`) or leaves one edge gap for C1. | safety | `sse.rs` | `sse/tests_errors.rs › the_first_broadcast…`, `› a_lagged_stream…`, `sse/tests_stream.rs › a_client_that_stops_reading…`, `› a_client_beyond_the_buffer…` |
| S3 | Reconnecting beyond the ring serves no replay so the first live delta triggers a gap refetch (C1). | safety | `sse.rs` | `sse/tests_stream.rs › a_client_beyond_the_buffer…` (`can_replay_from`; connect path is —) |
| S4 | Streams end on shutdown; the last client leaving keeps the monitor for a 2 s grace period. | liveness | `sse.rs` | `sse/tests_errors.rs › open_stream_ends…`, `sse/tests_stream.rs › the_last_client_leaving_keeps…` |
| S5 | Monitor reconnect gives up after 5 short runs and broadcasts fatal so clients stop retrying. | liveness | `sse.rs` | — |
| S6 | `GET /events` attaches only to a session a live monitor holds or tmux has; any other is a 404, so the client creates it with `POST /commands`, a killed session included. | liveness | `sse.rs` | `sse/tests_errors.rs › a_session_whose_monitor_ended…` |

## C, Q and P — client stream stage, command queue and input, client model

In [INVARIANTS-CLIENT-MODEL.md](INVARIANTS-CLIENT-MODEL.md), the ledger's companion.

## U and L — UI-mode records, session lifecycle

In [INVARIANTS-UI-LIFECYCLE.md](INVARIANTS-UI-LIFECYCLE.md), the ledger's companion.

## What the ledger says today

- **Uncovered (`—`)**: A3, M5, M8, X3, S5, C6, C8, Q4, P3, P5.
- **Partial**: X4 (lock), S3 (connect), C7 (frame hold), Q1 (Tauri), Q2 (interleaving), P4 (`dropSupersededFocusOps`), P7 (first-state order), U2 (2-update hold), L6 (lock).
- **Example only**: M1, M4, Q1, Q5, U1.
- **Property**: C3–C5 (`stateFeed.props.test.ts`) and S2 (`sse.rs`).

## Related

- `docs/STATE-MANAGEMENT.md`, `docs/DATA-FLOW.md`, `docs/TESTS.md`, `docs/TMUX.md`
