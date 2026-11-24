# Invariants

Cross-layer promises, each with the test that holds it. Doc comments explain _how_ an invariant is kept; this file indexes _what_ is promised across a seam and _whether anything checks it_. Module-local assertions stay in code.

| Column | Meaning |
| --- | --- |
| `Id` | Stable name prefixed by seam. Cite in commits and test titles; never renumber. |
| `Kind` | `ordering` (A before B), `safety` (X never happens), `liveness` (Y happens within a bound). Ordering/liveness want a property or interleaving test, not one scripted run. |
| `Stated in` | Code defining the mechanism. |
| `Enforced by` | `file › test title`. `(example)` marks a single scripted run standing in for a property; `—` means uncovered. The policy step (`bin/ci/invariant-enforcers.mjs`) reads every `file › title` in the cell: a tracked file whose path ends in `file` must contain `title`; a title cut short with `…` is matched by its longest uncut piece; a `› title` with no file reuses the file named before it; a cell with a file and no `›` is not checked. |

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
| A1 | Step effect order: `Send(WindowSetup)` → `Notify` (images, clipboard, messages) → `Send(Own)`/`Reply` → `Send(WindowRelist)` → `Send(PaneRefresh)` → `Send(Resume)` → `Emit`. | ordering | `control_mode/state/step_and_output.rs` (`step_at`) | `state_aggregator_props.rs › effects_within_a_step…`, `› the_seam_events_reach…` (property) |
| A2 | Window add/close relists before emit: `Send(WindowRelist)` precedes `Emit`. | ordering | `control_mode/state/step_and_output.rs` (`step_at`) | `state_aggregator_props.rs › window_add_refresh_precedes_any_emit` (property); A1 |
| A3 | Tag-only steps promote to `Window` change so untagged windows emit immediately. | liveness | `control_mode/state/step_and_output.rs` (`step_at`) | — |
| A4 | Every read the aggregator issues — captures, `list-panes`, `list-windows`, the stash list, buffer and client reads — routes by its marker, never arrival order or shape; an unmarked block changes nothing; dead-pane captures are discarded. | safety | `control_mode/state/markers.rs` (`Read`), `control_mode/state/command_response.rs` | `state/tests_capture.rs › capture_routing…`, `› capture_marker…`, `› capture_for_dead_pane…`, `› a_failed_capture…`, `control_mode/state/tests.rs › an_unmarked_ack_changes_nothing`, `› non_list_panes_output…`; `state_aggregator_props.rs › queue_captures…` (property) |
| A5 | Output between reply markers skips pane/window parsers; mismatched END fails the older reply cleanly. | safety | `state.rs` (replies) | `control_mode/state/tests.rs › a_query_between_markers…`, `› a_mismatched_end_marker…`, `› non_list_panes_output…` |
| A6 | Reply-wrapped commands send `BEGIN`, cmd, `END` in order, each its own line; `END` runs even after `%error`. | ordering | `control_mode/state/markers.rs` (`reply_wrapped_lines`) | `control_mode/state/tests.rs › reply_markers_collect…`, `› a_failed_block_fails…`; `reply_channel.rs › replies_come_back…` (real tmux); `AppOptimistic.stories.tsx › RefusedSplitReportsTmuxsReason` (v86) |
| A7 | Settling emits at most one `EmitState` and clears by safety ceiling (silently if idle). | liveness | `state.rs` (`arm_settling`, `tick`) | `state_aggregator_props.rs › settling_window…`, `› settling_round_trips`, `› suppressed_window…` (properties); `state_aggregator_sideeffects.rs › tick_after_deadline…`, `› tick_safety_timeout…` |
| A8 | `change_type` surfaces during suppressed emissions so settling timers extend on window changes. | liveness | `state.rs` (`step_at`) | `state_aggregator_sideeffects.rs › change_type_is_surfaced…`, `› step_at_extends…`; `state_aggregator_props.rs › emit_state_change…` (property) |
| A9 | A pane whose screen is unknown — moved to another window, or just appeared (a split, a group member back from the stash) — holds `%output` until its capture lands or fails: no state carries a screen built from a fragment. | safety | `state.rs` (`panes_awaiting_capture`) | `tests_awaiting_capture.rs › a_moved_pane…`, `› a_pane_that_appears_shows_no_screen_before_its_capture` |
| A10 | Stray `%end`/`%error` without `%begin` never produces a command response. | safety | `parser.rs` | `parser/tests.rs › stray_end_without_begin_is_ignored`; `pane_bytes_props.rs › …arbitrary_lines`, `› …hostile_notifications` (properties) |
| A11 | A pane's output bytes reach the emulator exactly, wherever tmux cut its `%output` lines — a character split across lines included, and a picture's escape taken out on the way ends the sequence it cut short, as on a terminal — so the screen is the same however it was cut; pane output is never read as text. | safety | `parser.rs` (`parse_line`), `control_mode/connection/spawn.rs`, `control_mode/images.rs` (`process_with`) | `pane_bytes_props.rs › output_cut_anywhere_carries_the_bytes`, `fuzz_parsers.rs › the_same_output_split_differently_leaves_the_same_screen` (properties); `control_mode_push_api.rs › a_character_split_across_output_lines_reaches_the_screen_whole`; `images/tests_split.rs › a_stripped_escape_ends_the_sequence_it_cut_short`, `› a_dcs_ends_at_a_c1_st…` |
| A12 | An in-browser guest runs the native client core (`MonitorCore`, compiled to wasm): its replies are the core's (what came between the reply's markers, a relayed `run-shell`'s output, tmux's refusal, a timeout), and its attach, routing and timers are the native ones. | safety | `tmuxy-wasm/src/lib.rs`; `infra/transport/drivers/guest/GuestEngine.ts` | `tmuxy-wasm/src/lib.rs › replies_refusals_messages_and_the_end_reach_the_guest`, `› the_attach_is_the_native_monitors`; `replyBook.test.ts` |
| A13 | Pane output in a block is only its body: a block closes only on the `%end`/`%error` repeating its `%begin`'s guard, markers carry the aggregator's random token, and the block after a read's BEGIN (a capture, a list, a buffer or client read) is that read's output whatever it says. | safety | `control_mode/parser/block.rs`; `control_mode/state/markers.rs` | `pane_bytes_props.rs › a_blocks_body_is_whatever…` (property); `parser/tests.rs › a_block_closes_only_on_the_guard…`; `state_aggregator_props.rs › a_capture_lands_on_its_pane_whatever…`, `› a_reply_is_what_lies…` (properties); `pane_output_spoofs.rs › a_pane_printing_tmuxys_markers_cannot_stall…` (real tmux) |
| A14 | A capture refill leaves the emulator's cursor where tmux's was in the captured screen: the capture's BEGIN marker reads it in the capture's own command list, never a `list-panes` of another moment, so output after the capture continues from it. | safety | `control_mode/state/markers.rs` (`capture_command`), `control_mode/state/command_response.rs` (`on_capture`) | `tests_capture_cursor.rs › a_capture_refill_draws_later_output_from_the_cursor_of_the_captured_screen` |
| A15 | A pane on no client's screen (not in the session's active window, nor a float or sidebar; the window is the session's, which every client of the monitor shows) sends its screen and title changes at most once per `HIDDEN_PANE_EVERY`: the first at once, the latest when due, the monitor waking for it (`hidden_panes_due`); any other change to it, and all of it once its tab is shown, goes at once. A held pane stays in `prev_state` as last sent, so the delta that carries it holds every change since, and a client joining meanwhile is handed that copy (`to_client_state`). | liveness | `control_mode/state/hidden_panes.rs`, `control_mode/state/delta_emit.rs`, `control_mode/monitor/event_loop.rs` | `control_mode/state/hidden_panes/tests.rs › a_hidden_pane_sends_its_latest_frame_once_a_second`, `› a_held_pane_goes_at_once_when_its_tab_is_shown`, `› a_client_joining_while_a_pane_is_held_gets_it_as_last_sent`, `› only_a_hidden_screen_change_may_wait` (the monitor's wake at `hidden_panes_due` is —) |
| A16 | No state shows a window that only a notification (`%window-add`, `%window-renamed`) has announced, nor its panes, until list-windows reports its tags; the session's current window excepted. A chrome window made by `split-window ; break-pane -d ; set-option` is never drawn as a tab. | safety | `control_mode/state/stash_and_helpers.rs` (`to_tmux_state`), `control_mode/state/window_state.rs` (`WindowState::listed`, the flag M13 reads) | `state/tests_announced_windows.rs › a_dock_window_is_shown_only_once_listed_as_the_dock` (every order of the announcements) |
| A17 | A pane's geometry is the pane's, never its layout cell's: under `pane-border-status top`, read off the last `list-panes` (unknown before one, and on a window tmuxy is setting to something else), a cell on the window's top edge holds a pane a row lower and shorter, so a `%layout-change` and a list that agree ask no capture. | safety | `control_mode/state/border_row.rs` | `tests_border_row.rs › a_layout_names_the_pane_its_cell_holds_under_the_top_border_row`, `› a_border_row_no_list_has_shown_is_not_assumed` |
| A18 | A capture still on its way shows every change reported before its answer begins (tmux runs a client's commands in order and writes their output and its notifications in the order they happen), so a pane asked for again meanwhile is captured once; a change reported after it is captured again. | safety | `control_mode/state/window_state.rs` (`queue_captures`) | `tests_capture.rs › a_capture_on_its_way_shows_a_change_reported_before_its_answer`; `tests_rounds.rs › attaching_at_the_clients_size_captures_each_pane_once` |

## M — monitor dispatch

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| M1 | Every host runs the core's actions one-to-one, in the order the core returns them, dropping none. | ordering | `monitor_core.rs` (`Action`); `control_mode/monitor/event_loop.rs` (`dispatch`); `tmuxy-wasm/src/lib.rs` (`apply`) | `monitor/tests.rs › a_step_sends_its_effects_commands_in_effect_order` (example; order is A1); `tmuxy-wasm/src/lib.rs › replies_refusals_messages…` |
| M2 | Every re-list of the windows — add/close, the attach, the metadata sync, the idle heartbeat, a reorder — sends `list-panes` before `list-windows`, the stash last. | ordering | `control_mode/state/markers.rs` (`window_relist_commands`), `monitor_core.rs` | `monitor_command_order.rs › a_window_relist_sends_panes_before_windows…`; `monitor_core/tests.rs › an_attach_enforces…`, `› a_pane_that_keeps_printing…`, `› the_idle_heartbeat_lists_panes…`, `› a_command_settles_or_relists…` |
| M3 | A pane refresh, and the copy-mode poll, send `list-panes` before per-pane `capture-pane`s for fresh cursor positions. | ordering | `control_mode/state/window_state.rs` (`pane_refresh_commands`) | `monitor_command_order.rs › a_pane_refresh_lists_panes_before_every_capture` (property) |
| M4 | Windows set `window-size manual` and `aggressive-resize off` before first `resizew` so SIGWINCH never races captures. | ordering | `control_mode/state/window_state.rs` (`window_setup_commands`), `monitor_core.rs` | `monitor/tests.rs › a_window_is_told_to_stop_sizing_itself_before_it_is_sized` (example) |
| M5 | Client-size pass runs after the step's own effects, never ahead of `Emit`. | ordering | `monitor_core.rs` (`step`) | — |
| M6 | `GetState` waits for sync, captures, and queued refreshes (15 s cap); first state awaits resize up to 750 ms. | liveness | `monitor.rs`, `host/requests.rs`, `sse.rs` | `sse/tests_sessions.rs › a_clients_first_state…`, `› a_first_state_waits…`, `› a_client_that_sets_no_size…`; `initial_state.rs`, `initial_state_history.rs` (real tmux) |
| M7 | Every reply resolves within `REPLY_TIMEOUT`, or immediately on send failure. | liveness | `control_mode/monitor_core/replies.rs` | `monitor_core/tests.rs › a_callers_command_is_answered_by_its_reply_or_its_timeout`; `reply_channel.rs` (real tmux) |
| M8 | Reply ids are monotonic so expired reply blocks never match newer ones. | safety | `monitor_core.rs` | — |
| M9 | A session event about another session changes nothing: one is ours by the id `%session-changed` gave once known, by the configured name before. | safety | `control_mode/state/events.rs` (`names_our_session`) | `monitor_core/tests.rs › a_session_event_about_another_session_changes_nothing` |
| M10 | A `resizew` is judged only by the answer to a `list-panes` sent after it (a list already on its way reports the old size): asked again <=3 times per size while that report shows another; new sizes reset count; unmonitored sizes re-request. | liveness | `control_mode/monitor_core/sizing.rs`, `sse.rs` | `monitor_core/tests.rs › a_window_tmux_did_not_resize…`, `› …not_asked_again…`, `› a_size_tmux_keeps_refusing…`, `› a_new_size_starts…`, `› a_window_with_no_panes…`; `tests_rounds.rs › a_client_resize_resizes_each_window_once…`; `host/runtime_tests.rs › a_size_that_reached_no_monitor…` |
| M11 | UI choices re-apply after every `source-file` (connect, reload, a client's own) and win, unless the user's `tmuxy.conf` pins the option; enforced settings after both. | ordering | `control_mode/monitor_core/attach.rs`, `control_mode/monitor/sync.rs`, `session/state.rs`, `host/bindings.rs` | `enforced_settings.rs › connecting_enforces_the_settings…` (final values, every window); `monitor_core/tests.rs › an_attach_enforces_the_settings_after_the_config…` (order); `session/tests.rs › a_pinned_option_is_not_reapplied…` (the pin) |
| M12 | A paced link (`ReadPacing::OneBatchInFlight`, the guest) has one batch of reads out, the attach's lists the first; a host's re-sync goes at once as a batch of its own, with what waited. Reads asked for meanwhile go once each in the next batch, after tmux answers them all or `REPLY_TIMEOUT`. | liveness | `control_mode/monitor_core/reads.rs` | `monitor_core/tests_reads.rs › on_a_paced_link_reads_asked_for_while_a_batch_is_out_go_once_after_it`, `› …copy_mode_poll_waits_for_its_answer`, `› …unanswered_batch_is_given_up_at_the_reply_timeout`; `tests_rounds.rs › an_attach_captures_each_pane_once…`, `› a_client_resize_resizes_each_window_once…` |
| M13 | A window is sized to the grid the UI draws it at, once `list-windows` has said what it is: a tab to the viewport, a sidebar to its column, a float to its size tags, held to the viewport (a drawer only on the side it docks by) and with no border row. Until then it is only told to stop sizing itself. | safety | `control_mode/monitor_core/sizing.rs` (`size_windows`, `float_size`), `control_mode/state/window_state.rs` (`WindowState::listed`, `window_ids_by_sizing`, `window_setup`), `constants/float_grid.rs` | `monitor_core/tests.rs › a_float_is_sized_to_its_tags_and_a_tab_to_the_viewport`; `tests_sidebar_and_delta.rs › a_window_only_announced_gets_no_border_row_and_no_size`, `› float_loses_the_pane_border_a_tab_gets`; `monitor/tests.rs › a_window_is_told_to_stop_sizing_itself_before_it_is_sized`; `tests/2-layout-navigation-float.test.js › a 50x12 float → its program reads 12 rows and 50 columns → what it draws on its last row is on screen, inside the float` |

## X — the tmux connection and the router

In [INVARIANTS-CONNECTION.md](INVARIANTS-CONNECTION.md), the ledger's companion.

## S — server stream

In [INVARIANTS-SERVER-STREAM.md](INVARIANTS-SERVER-STREAM.md), the ledger's companion.

## C, Q and P — client stream stage, command queue and input, client model

In [INVARIANTS-CLIENT-MODEL.md](INVARIANTS-CLIENT-MODEL.md), the ledger's companion.

## U and L — UI-mode records, session lifecycle

In [INVARIANTS-UI-LIFECYCLE.md](INVARIANTS-UI-LIFECYCLE.md), the ledger's companion.

The `—` cells, and the parenthesised "(x is —)" partials, are the gaps: a new property test belongs there first.

## Related

- `docs/STATE-MANAGEMENT.md`, `docs/DATA-FLOW.md`, `docs/TESTS.md`, `docs/TMUX.md`
