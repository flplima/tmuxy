use super::markers::Read;
use super::*;
use crate::constants::tmux_formats::TmuxList;
use crate::{PaneId, WindowId};

pub(super) struct ReplyInFlight {
    pub(super) id: u64,
    pub(super) output: String,
    /// tmux's message from the first `%error` block, if any.
    pub(super) error: Option<String>,
}

impl StateAggregator {
    pub(super) fn on_command_response_event(
        &mut self,
        output: String,
        success: bool,
    ) -> ProcessEventResult {
        let marker_line = output.trim_end_matches(['\r', '\n']);

        // The block right after a read's BEGIN marker is that read's output
        // (see `Read`): a pane can show anything, a marker's words included,
        // and a reply can print rows shaped exactly like a list's.
        if let Some(read) = self.armed.take() {
            return self.on_read(read, &output, success);
        }

        // Everything between a reply's BEGIN and END blocks
        // (`reply_wrapped_lines`) goes back to the caller whole: a
        // `list-panes -a` sent as a query prints rows shaped exactly like
        // the aggregator's own poll, and parsing them would conjure another
        // session's panes into this one.
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
                let cap = crate::control_mode::parser::MAX_RESPONSE_BYTES;
                if reply.output.len().saturating_add(output.len()) > cap {
                    if reply.error.is_none() {
                        reply.error = Some(format!("reply larger than {cap} bytes"));
                    }
                    reply.output.clear();
                    return ProcessEventResult::default();
                }
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

        if let Some(read) = self.markers.read_begun(marker_line) {
            if read != Read::Buffer || self.pending_buffer_reads > 0 {
                self.armed = Some(read);
            }
            return ProcessEventResult::default();
        }

        // Anything else — a read's END marker, the ack of a keystroke or of
        // any command sent without a marker — changes nothing tmux will not
        // announce on its own: the state is kept from notifications and the
        // marked reads above.
        ProcessEventResult::default()
    }

    fn on_read(&mut self, read: Read, output: &str, success: bool) -> ProcessEventResult {
        match read {
            Read::Capture(pane_id, cursor) => self.on_capture(pane_id, cursor, output, success),
            Read::Clients(pane_id) => self.on_clients_listed(&pane_id, output, success),
            Read::Buffer => {
                self.pending_buffer_reads = self.pending_buffer_reads.saturating_sub(1);
                let text = output.trim_end_matches(['\r', '\n']);
                // A pane's program can fill the buffer with anything, so it
                // gets the OSC 52 cap here, where every host (the in-browser
                // engine included) sees it.
                if success && !text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES {
                    return ProcessEventResult {
                        clipboard_writes: vec![(None, text.to_string())],
                        ..Default::default()
                    };
                }
                ProcessEventResult::default()
            }
            Read::List(_) if !success => ProcessEventResult::default(),
            Read::List(list) => {
                let resized_panes = match list {
                    TmuxList::Panes => self.apply_pane_list(output),
                    TmuxList::Windows => {
                        self.apply_window_list(output);
                        Vec::new()
                    }
                    TmuxList::Stash => {
                        self.rebuild_stash_members(output);
                        Vec::new()
                    }
                };
                let mut commands = self.collapsible_layout_commands(None);
                commands.extend(self.held_status_commands(Instant::now()));
                commands.extend(
                    self.view_mode_opened
                        .drain(..)
                        .map(|pane_id| self.markers.clients_read_command(&pane_id)),
                );
                ProcessEventResult {
                    state_changed: true,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::Other,
                    commands,
                    ..Default::default()
                }
            }
        }
    }

    /// The `list-clients` answer asked for when `pane_id`'s row reported
    /// view mode (`LIST_CLIENTS_FORMAT`, one client per line). The mode is
    /// closed unless a terminal client of this session, or of one grouped
    /// with it, is attached: that person sees the pager and can read and
    /// close it; this client draws none and would only lose its keys to it.
    /// `copy-mode -q` resets every mode on the pane without a client of its
    /// own, so it is safe from control mode on every version.
    fn on_clients_listed(
        &mut self,
        pane_id: &PaneId,
        output: &str,
        success: bool,
    ) -> ProcessEventResult {
        if !success {
            return ProcessEventResult::default();
        }
        let clients: Vec<(bool, &str, &str)> = output
            .lines()
            .filter_map(|line| {
                let mut fields = line.trim_end_matches('\r').splitn(3, ',');
                let control = fields.next()? == "1";
                let group = fields.next()?;
                let name = fields.next()?;
                Some((control, group, name))
            })
            .collect();
        let own_group = clients
            .iter()
            .find(|(_, _, name)| *name == self.session_name)
            .map(|(_, group, _)| *group)
            .filter(|group| !group.is_empty());
        let watched = clients.iter().any(|(control, group, name)| {
            !control && (*name == self.session_name || own_group == Some(*group))
        });
        if watched {
            debug!(pane = %pane_id, "view mode left open: a terminal client is attached");
            return ProcessEventResult::default();
        }
        ProcessEventResult {
            commands: vec![format!("copy-mode -q -t {pane_id}")],
            messages: vec![format!("tmux opened a view in pane {pane_id}; closed it")],
            ..Default::default()
        }
    }

    fn on_capture(
        &mut self,
        pane_id: PaneId,
        cursor: Option<(u32, u32)>,
        output: &str,
        success: bool,
    ) -> ProcessEventResult {
        // Whatever the outcome: a wedged entry would block every later
        // capture of the pane and hold the first state back
        // (`initial_state_ready`), and a moved pane left in
        // `panes_moved_window` would drop every `%output` it prints.
        self.pending_captures.retain(|id| *id != pane_id);
        self.panes_moved_window.remove(&pane_id);
        // A capture asked for while this one was in flight (a second resize
        // of a divider drag) was dropped as a duplicate, yet this reply
        // shows the pane as it was when the capture was issued: ask again,
        // now that the pane is free, if it is still here to capture. Not
        // for a pane in copy mode: the copy-mode poll captures it on its
        // next tick anyway, and a follow-up per tick that found a capture
        // in flight would keep one on the wire at all times.
        let asked_again = self.recapture.remove(&pane_id);
        let panes_needing_refresh = match self.panes.get(&pane_id) {
            Some(pane) if asked_again && !pane.in_mode => vec![pane_id.clone()],
            _ => Vec::new(),
        };
        if !success {
            warn!(?pane_id, "capture command failed");
            return ProcessEventResult {
                panes_needing_refresh,
                ..Default::default()
            };
        }
        let Some(pane) = self.panes.get_mut(&pane_id) else {
            return ProcessEventResult::default();
        };
        if let Some((x, y)) = cursor {
            pane.tmux_cursor_x = x;
            pane.tmux_cursor_y = y;
        }
        if pane.in_mode {
            pane.process_copy_mode_capture(output.as_bytes());
        } else {
            debug!(
                pane = %pane_id,
                lines = output.lines().filter(|l| !l.trim().is_empty()).count(),
                "pane captured"
            );
            pane.apply_capture(output.as_bytes());
        }
        ProcessEventResult {
            state_changed: true,
            change_type: ChangeType::Output,
            panes_needing_refresh,
            ..Default::default()
        }
    }

    /// The status writes that were held back for coming too soon after the
    /// last one (`program_status::MIN_WRITE_INTERVAL`) and are due at `now`.
    pub(super) fn held_status_commands(&mut self, now: Instant) -> Vec<String> {
        let mut panes: Vec<&mut PaneState> = self.panes.values_mut().collect();
        panes.sort_by_key(|pane| pane.id.number());
        panes
            .into_iter()
            .flat_map(|pane| pane.status_commands(now))
            .collect()
    }

    /// Apply a `list-panes` answer and return the panes that need a capture
    /// (new, resized, or just out of copy mode).
    pub(super) fn apply_pane_list(&mut self, output: &str) -> Vec<PaneId> {
        let mut seen_panes: HashSet<PaneId> = HashSet::new();
        let mut resized_panes: Vec<PaneId> = Vec::new();
        for line in output.lines() {
            if let Some((pane_id, was_resized)) = self.parse_list_panes_line(line) {
                seen_panes.insert(pane_id.clone());
                if was_resized {
                    resized_panes.push(pane_id);
                }
            }
        }
        if seen_panes.is_empty() {
            return resized_panes;
        }
        self.pane_reports = self.pane_reports.wrapping_add(1);
        self.panes_synced = true;

        self.panes.retain(|pane_id, _| {
            let listed = seen_panes.contains(pane_id);
            if !listed {
                debug!(pane = %pane_id, "pane gone");
            }
            listed
        });
        self.prune_capture_bookkeeping();
        resized_panes
    }

    pub(super) fn apply_window_list(&mut self, output: &str) {
        let seen_windows: HashSet<WindowId> = output
            .lines()
            .filter_map(|line| self.parse_list_windows_line(line))
            .collect();
        if seen_windows.is_empty() {
            return;
        }
        self.windows
            .retain(|window_id, _| seen_windows.contains(window_id));
        self.windows_synced = true;
    }
}
