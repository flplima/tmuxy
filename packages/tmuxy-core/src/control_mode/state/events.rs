use super::*;

fn is_paste_staging_buffer(name: &str) -> bool {
    use crate::constants::{CLI_PASTE_BUFFER_PREFIX, PASTE_BUFFER};
    name == PASTE_BUFFER || name.starts_with(CLI_PASTE_BUFFER_PREFIX)
}

impl StateAggregator {
    /// Whether a session event is about the session this aggregator follows:
    /// by the id `%session-changed` gave it once it has one (tmux tells every
    /// control client of every session's rename), by the name it was made for
    /// until then. An aggregator made for no name follows any.
    fn names_our_session(&self, id: &str, name: &str) -> bool {
        match &self.session_id {
            Some(ours) => ours == id,
            None => self.session_name.is_empty() || self.session_name == name,
        }
    }

    pub(crate) fn process_event(&mut self, event: ControlModeEvent) -> ProcessEventResult {
        match event {
            ControlModeEvent::Output { pane_id, content } => self.output_result(pane_id, &content),

            ControlModeEvent::LayoutChange {
                window_id,
                layout,
                visible_layout,
                flags,
            } => {
                // The full layout lists every pane, the ones a zoom hides
                // included; the visible one holds only the zoomed pane, at
                // the window's size, and is what gets drawn.
                let zoomed = flags.contains('Z');
                let resized_panes = self.handle_layout_change(
                    &window_id,
                    &layout,
                    zoomed.then_some(visible_layout.as_str()),
                );

                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.zoomed = zoomed;
                }

                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::Layout,
                    commands: self.collapsible_layout_commands(Some(&window_id)),
                    ..Default::default()
                }
            }

            // `%unlinked-window-add` is about another session's window.
            ControlModeEvent::UnlinkedWindowAdd { .. } => ProcessEventResult::default(),

            // `%unlinked-window-close` fires for non-current windows of ANY
            // session: one we know is ours.
            ControlModeEvent::UnlinkedWindowClose { window_id } => {
                if self.windows.contains_key(&window_id) {
                    self.windows.remove(&window_id);
                    self.window_setup.remove(&window_id);
                    self.panes.retain(|_, p| !p.in_window(&window_id));
                    self.prune_capture_bookkeeping();
                    ProcessEventResult {
                        state_changed: !self.suppress_window_emissions,
                        change_type: ChangeType::Window,
                        ..Default::default()
                    }
                } else {
                    ProcessEventResult::default()
                }
            }

            ControlModeEvent::WindowAdd { window_id } => {
                // Assign a provisional positional index now (see
                // next_window_index) — `%window-add` carries only the id, and
                // an index read out of the id is wrong once ids and indices
                // diverge (e.g. `tmuxy tab create` makes @1 at index 2).
                let provisional_index = self.next_window_index();
                self.windows.entry(window_id.clone()).or_insert_with(|| {
                    WindowState::announced(window_id.clone(), provisional_index)
                });
                ProcessEventResult::default()
            }

            ControlModeEvent::WindowClose { window_id } => {
                self.windows.remove(&window_id);
                self.window_setup.remove(&window_id);
                self.panes.retain(|_, p| !p.in_window(&window_id));
                self.prune_capture_bookkeeping();
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowRenamed { window_id, name } => {
                // A rename can arrive before the add.
                let provisional_index = self.next_window_index();
                let window = self.windows.entry(window_id.clone()).or_insert_with(|| {
                    WindowState::announced(window_id.clone(), provisional_index)
                });
                window.name = name;
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowPaneChanged { window_id, pane_id } => {
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.active_pane_id = Some(pane_id.clone());
                }
                for pane in self.panes.values_mut() {
                    if pane.in_window(&window_id) {
                        pane.active = pane.id == pane_id;
                    }
                }
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Focus,
                    commands: self.collapsible_layout_commands(Some(&window_id)),
                    ..Default::default()
                }
            }

            // A title changed with no notification of its own: re-list the
            // panes (the title rides list-panes) for the pane named.
            ControlModeEvent::SubscriptionChanged { name, pane_id }
                if name == crate::constants::tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME =>
            {
                ProcessEventResult {
                    panes_needing_refresh: vec![pane_id],
                    ..Default::default()
                }
            }
            ControlModeEvent::SubscriptionChanged { .. } => ProcessEventResult::default(),

            // The theme or its mode changed, whichever client set it: the
            // value is the new `<theme>:<mode>`, and the delta that carries
            // it has every client read the theme settings again.
            ControlModeEvent::SessionSubscriptionChanged { name, value }
                if name == crate::constants::tmux_formats::THEME_SUBSCRIPTION_NAME =>
            {
                if self.theme_rev.as_deref() == Some(value.as_str()) {
                    return ProcessEventResult::default();
                }
                self.theme_rev = Some(value);
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Other,
                    ..Default::default()
                }
            }
            ControlModeEvent::SessionSubscriptionChanged { .. } => ProcessEventResult::default(),

            // %pane-mode-changed says only that a mode came or went, for
            // any mode (copy-, view-, tree-mode alike), and tmux answers a
            // control client's queued commands before it delivers its
            // notifications: a `list-panes` batched with the `copy-mode`
            // that caused this reports the pane already in copy mode, so a
            // toggle here flipped it back out. The list-panes poll's
            // copy-mode column is the one source of `in_mode`; this only
            // asks for it again. Leaving copy mode already captures the pane
            // (`exited_copy_mode` in parse_list_panes_line).
            ControlModeEvent::PaneModeChanged { pane_id } => ProcessEventResult {
                panes_needing_refresh: vec![pane_id],
                ..Default::default()
            },

            ControlModeEvent::PasteBufferChanged { buffer_name } => {
                // tmux does not forward OSC 52 to control-mode clients, so a
                // copy-mode yank only surfaces as %paste-buffer-changed; the
                // buffer is read back and becomes a clipboard write like an
                // OSC 52 one.
                //
                // Paste buffers are global to the tmux SERVER and the event
                // names no origin, so a `load-buffer secret.txt` or a yank in
                // someone else's session would be mirrored to every client of
                // this one. A pane of THIS session in copy mode, which a yank
                // leaves behind, is the only sign it came from here.
                if !self.has_pane_in_copy_mode() {
                    debug!(
                        buffer = %buffer_name,
                        "paste buffer changed with no pane of this session in copy mode; not mirrored"
                    );
                    return ProcessEventResult::default();
                }
                // tmuxy's own paste is staged in a buffer too, a chunk at a
                // time: mirrored, each chunk of a paste into one pane while
                // another sits in copy mode would overwrite the clipboard.
                if is_paste_staging_buffer(&buffer_name) {
                    return ProcessEventResult::default();
                }
                self.pending_buffer_reads += 1;
                ProcessEventResult {
                    commands: vec![self.markers.buffer_read_command(&buffer_name)],
                    ..Default::default()
                }
            }

            ControlModeEvent::SessionWindowChanged { window_id, .. } => {
                for (id, window) in self.windows.iter_mut() {
                    window.active = *id == window_id;
                }
                self.active_window_id = Some(window_id.clone());
                // Captured again so a long-idle tab shows current content.
                let refresh: Vec<PaneId> = self
                    .panes
                    .values()
                    .filter(|p| p.in_window(&window_id))
                    .map(|p| p.id.clone())
                    .collect();

                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    panes_needing_refresh: refresh,
                    ..Default::default()
                }
            }

            ControlModeEvent::CommandResponse {
                output, success, ..
            } => self.on_command_response_event(output, success),

            ControlModeEvent::SessionsChanged => {
                // %sessions-changed goes to EVERY control client when ANY
                // session is created or destroyed: it says nothing about this
                // one (an E2E session would otherwise update the user's UI).
                ProcessEventResult::default()
            }
            // Creating a tmux session, even from another process, fires
            // `%session-changed` on every control client: one about another
            // session changes nothing here.
            ControlModeEvent::SessionChanged {
                session_id,
                session_name,
            } => {
                if !self.names_our_session(&session_id, &session_name) {
                    debug!(session = %session_name, "a session-changed for another session");
                    return ProcessEventResult::default();
                }
                self.session_id = Some(session_id);
                self.session_name = session_name;
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Other,
                    ..Default::default()
                }
            }
            ControlModeEvent::SessionRenamed { session_id, name } => {
                if !self.names_our_session(&session_id, &self.session_name.clone()) {
                    return ProcessEventResult::default();
                }
                self.session_name = name;
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Other,
                    ..Default::default()
                }
            }
            // The end of the connection is the host's to act on
            // (`MonitorCore::step`); the tree it leaves is as it was.
            ControlModeEvent::Exit { .. } => ProcessEventResult::default(),

            ControlModeEvent::Message { text } => ProcessEventResult {
                messages: if text.is_empty() {
                    Vec::new()
                } else {
                    vec![text]
                },
                ..Default::default()
            },

            // Flow control (tmux 3.2+ `pause-after`): a paused pane is resumed
            // at once (`Batch::Resume`), so nothing in the state says it was
            // ever paused.
            ControlModeEvent::Pause { pane_id } if self.panes.contains_key(&pane_id) => {
                ProcessEventResult {
                    resume: Some(pane_id),
                    ..Default::default()
                }
            }
            ControlModeEvent::Pause { .. } | ControlModeEvent::Continue { .. } => {
                ProcessEventResult::default()
            }
        }
    }
}
