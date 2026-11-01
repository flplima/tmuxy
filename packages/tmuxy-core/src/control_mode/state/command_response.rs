use super::*;
use crate::{PaneId, WindowId};

/// A reply-wrapped command's output, being collected between its markers.
pub(super) struct ReplyInFlight {
    pub(super) id: u64,
    pub(super) output: String,
    /// tmux's message from the first `%error` block, if any.
    pub(super) error: Option<String>,
}

/// The re-list a window add or close needs, and the initial sync sends:
/// panes BEFORE windows (M2 in `docs/INVARIANTS.md`). A window emitted before
/// its panes are listed is a window with panes missing; the stash list is
/// independent of that order and goes last. The native monitor and the wasm
/// host both send exactly this.
pub fn window_relist_commands() -> [String; 3] {
    [
        crate::constants::tmux_formats::LIST_PANES_CMD.to_string(),
        crate::constants::tmux_formats::LIST_WINDOWS_CMD.to_string(),
        crate::constants::tmux_formats::LIST_STASH_PANES_CMD.to_string(),
    ]
}

impl StateAggregator {
    pub(super) fn on_command_response_event(
        &mut self,
        output: String,
        success: bool,
    ) -> ProcessEventResult {
        let marker_line = output.trim_end_matches(['\r', '\n']);

        // The block right after a capture's or a buffer read's BEGIN marker
        // is that read's output (each command of a list gets its own block,
        // in order), so it is taken by position, never by what it says: a
        // pane can show anything, a marker's words included.
        if let Some(pane_id) = self.capture_armed.take() {
            return self.on_capture(pane_id, &output, success);
        }
        if self.buffer_read_armed {
            self.buffer_read_armed = false;
            self.pending_buffer_reads.pop_front();
            let text = marker_line.to_string();
            // The buffer can hold anything a pane's program put there, so it
            // gets the same cap as an OSC 52 write, here where every
            // consumer of the effect (the in-browser engine included) sees it.
            if success && !text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES {
                return ProcessEventResult {
                    clipboard_writes: vec![(None, text)],
                    ..Default::default()
                };
            }
            return ProcessEventResult::default();
        }

        // Reply-wrapped commands (see reply_wrapped_lines). Everything
        // between the BEGIN and END marker blocks belongs to the
        // caller and is handed back whole; none of it may fall
        // through to the parsers below. A `list-panes -a` sent as a
        // query prints rows shaped exactly like the aggregator's own
        // list-panes poll, and letting them reach
        // handle_command_response would conjure another session's
        // panes into this one.
        if let Some(id) = self.markers.argument(marker_line, REPLY_BEGIN_MARKER) {
            self.reply_in_flight = Some(ReplyInFlight {
                id,
                output: String::new(),
                error: None,
            });
            return ProcessEventResult::default();
        }
        if let Some(id) = self.markers.argument::<u64>(marker_line, REPLY_END_MARKER) {
            let Some(reply) = self.reply_in_flight.take() else {
                return ProcessEventResult::default();
            };
            if reply.id != id {
                // A BEGIN whose END never came (its command wedged the
                // connection?) followed by a later reply's END: the
                // older reply is lost, the newer one must not inherit
                // its output. Fail the older, report nothing for this.
                return ProcessEventResult {
                    command_replies: vec![(
                        reply.id,
                        reply.output,
                        Some("reply lost: a later reply closed before it".to_string()),
                    )],
                    ..Default::default()
                };
            }
            return ProcessEventResult {
                command_replies: vec![(reply.id, reply.output, reply.error)],
                ..Default::default()
            };
        }
        if let Some(reply) = self.reply_in_flight.as_mut() {
            if success {
                // The parser hands a block over without its last
                // newline, so a command list's blocks would run
                // together: the line between them is put back.
                if !output.is_empty() && !reply.output.is_empty() && !reply.output.ends_with('\n') {
                    reply.output.push('\n');
                }
                reply.output.push_str(&output);
            } else if reply.error.is_none() {
                reply.error = Some(output.trim().to_string());
            }
            return ProcessEventResult::default();
        }

        // Marker-wrapped show-buffer responses (copy-mode yank mirror).
        // Each command in a control-mode command list gets its OWN
        // %begin/%end block, so the wrap arrives as three consecutive
        // responses: BEGIN marker → buffer content → END marker.
        if self.markers.is(marker_line, BUFFER_BEGIN_MARKER) {
            self.buffer_read_armed = !self.pending_buffer_reads.is_empty();
            return ProcessEventResult::default();
        }
        if self.markers.is(marker_line, BUFFER_END_MARKER) {
            return ProcessEventResult::default();
        }

        // Marker-routed capture-pane responses: every self-issued
        // capture is bracketed BEGIN(pane)/END (see capture_command),
        // so the block between the markers is attributed to its pane
        // exactly — never by arrival order or output-shape guessing.
        if let Some(rest) = self.markers.after(marker_line, CAPTURE_BEGIN_MARKER) {
            // The id travels as bare digits (see capture_command).
            if let Ok(number) = rest.trim_start_matches('%').parse() {
                self.capture_armed = Some(PaneId::from_number(number));
            }
            return ProcessEventResult::default();
        }
        if self.markers.is(marker_line, CAPTURE_END_MARKER) {
            return ProcessEventResult::default();
        }

        // NOTE: every unmarked SUCCESSFUL response — including the
        // empty ack of each send-keys batch — intentionally falls
        // through to a Full change below. An attempted optimization
        // (return None for empty acks, sparing a full TmuxState
        // rebuild per keystroke) regressed keystroke routing after a
        // pane-group tab click: the compound run-shell's empty ack is
        // one of the signals the frontend's optimistic-swap
        // convergence rides on, and suppressing it sent the first
        // post-click keystroke to the stale pane (7-regression
        // group-click E2E). Revisit only after the self-issued
        // list-panes/list-windows commands are marker-routed like
        // captures, so command completions can be classified exactly
        // instead of by ack shape.

        // Not a capture-pane response - parse list-panes/list-windows responses to update state
        let resized_panes = if success {
            self.handle_command_response(&output)
        } else {
            Vec::new()
        };
        ProcessEventResult {
            state_changed: true,
            panes_needing_refresh: resized_panes,
            change_type: ChangeType::Full, // Command responses may update many things,
            commands: self.collapsible_layout_commands(None),
            ..Default::default()
        }
    }

    /// A capture's block, for the pane its BEGIN marker named.
    fn on_capture(&mut self, pane_id: PaneId, output: &str, success: bool) -> ProcessEventResult {
        // In-flight bookkeeping is done for this pane regardless of
        // the outcome — a wedged entry would freeze the pane's
        // content preservation in to_state_update forever.
        self.pending_captures.retain(|id| *id != pane_id);
        if !success {
            warn!(?pane_id, "capture command failed");
            return ProcessEventResult::default();
        }
        let Some(pane) = self.panes.get_mut(&pane_id) else {
            // Pane was killed after the capture was sent — discard.
            self.panes_moved_window.remove(&pane_id);
            return ProcessEventResult::default();
        };
        if pane.in_mode {
            // In copy mode: process into separate copy_mode_content
            // to avoid corrupting the main terminal state
            pane.process_copy_mode_capture(output.as_bytes());
        } else {
            debug!(
                pane = %pane_id,
                lines = output.lines().filter(|l| !l.trim().is_empty()).count(),
                "pane captured"
            );
            // Normal mode: reset and reprocess the main terminal
            pane.reset_and_process_capture(output.as_bytes());

            // After processing capture output, the vt100 cursor
            // is at the end of the content (last row). Reposition
            // it to tmux's actual cursor position.
            let cursor_seq = format!(
                "\x1b[{};{}H",
                pane.tmux_cursor_y + 1,
                pane.tmux_cursor_x + 1
            );
            pane.terminal.process(cursor_seq.as_bytes());
        }
        // Capture arrived — clear window-move suppression
        self.panes_moved_window.remove(&pane_id);
        ProcessEventResult {
            state_changed: true,
            change_type: ChangeType::PaneOutput { pane_id },
            ..Default::default()
        }
    }

    /// Handle command response (list-panes, list-windows) and return list of panes that were resized.
    pub(super) fn handle_command_response(&mut self, output: &str) -> Vec<PaneId> {
        // A stash-members response (LIST_STASH_PANES_CMD) is a self-contained
        // block: rebuild the hidden-member map from it and return, so its rows
        // never reach the active-session pane/window parsers below. An empty
        // block (no rows) can't be told apart from an errored/absent stash
        // session, so leave the map as-is on empty; `to_tmux_state` prunes any
        // member whose group no longer has a visible pane.
        if output.lines().any(is_stash_member_line) {
            self.rebuild_stash_members(output);
            return Vec::new();
        }

        // Track which panes we see in this response
        let mut seen_panes: HashSet<PaneId> = HashSet::new();
        let mut resized_panes: Vec<PaneId> = Vec::new();
        let mut is_list_panes_response = false;

        // Try to parse as list-panes output. Require the shape tmux actually
        // emits — `%<digits>,` at the start of the line — rather than "contains
        // a % and a comma" anywhere, so arbitrary RunCommand output flowing
        // through this same channel can't be mistaken for pane records and
        // conjure ghost panes into the aggregator.
        for line in output.lines() {
            if is_list_panes_line(line) {
                if let Some((pane_id, was_resized)) = self.parse_list_panes_line(line) {
                    seen_panes.insert(pane_id.clone());
                    if was_resized {
                        resized_panes.push(pane_id);
                    }
                    is_list_panes_response = true;
                }
            }
        }

        if is_list_panes_response {
            self.pane_reports = self.pane_reports.wrapping_add(1);
            self.panes_synced = true;
        }

        // If this was a list-panes response, remove panes that weren't seen
        // (they were deleted in tmux)
        if is_list_panes_response && !seen_panes.is_empty() {
            self.panes.retain(|pane_id, pane| {
                // Keep panes that were seen in this response
                if seen_panes.contains(pane_id) {
                    return true;
                }
                // Keep panes with empty window_id (from other sessions' output events)
                // They'll be filtered out in to_tmux_state anyway
                if pane.window_id.is_none() {
                    return true;
                }
                // Remove panes that have a window_id but weren't in the list-panes response
                // (they were deleted)
                debug!(pane = %pane_id, "pane gone");
                false
            });
            self.pending_captures
                .retain(|id| self.panes.contains_key(id));
        }

        // Try to parse as list-windows output
        let mut is_list_windows_response = false;
        let mut seen_windows: HashSet<WindowId> = HashSet::new();
        for line in output.lines() {
            if line.contains('@') && line.contains(',') {
                // Extract window_id before parsing (first field is `@N`)
                if let Some(Ok(wid)) = line.split(',').next().map(|w| WindowId::parse(w.trim())) {
                    seen_windows.insert(wid);
                }
                self.parse_list_windows_line(line);
                is_list_windows_response = true;
            }
        }

        // Remove windows that weren't in the list-windows response (deleted in tmux).
        if is_list_windows_response && !seen_windows.is_empty() {
            self.windows
                .retain(|window_id, _| seen_windows.contains(window_id));
        }

        if is_list_windows_response {
            self.windows_synced = true;
        }

        resized_panes
    }
}
