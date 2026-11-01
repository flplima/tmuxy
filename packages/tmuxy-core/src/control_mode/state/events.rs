use super::*;

/// Whether `name` is a buffer tmuxy stages a paste in: the client's
/// (`PASTE_BUFFER` in `tmuxy-ui/src/domain/commandHelpers.ts`) or the CLI's
/// (`tmuxy pane paste`, per-PID `tmuxy-cli-paste-<pid>` in
/// `tmuxy-cli/bin/tmuxy/send`). Never a yank, so never mirrored.
fn is_paste_staging_buffer(name: &str) -> bool {
    name == "tmuxy-paste" || name.starts_with("tmuxy-cli-paste-")
}

impl StateAggregator {
    /// Process a control mode event.
    /// Returns information about state changes and any panes that need content refresh.
    pub(crate) fn process_event(&mut self, event: ControlModeEvent) -> ProcessEventResult {
        match event {
            // %output and %extended-output differ only in the extra metadata
            // the parser already discarded — one handler serves both.
            ControlModeEvent::Output { pane_id, content }
            | ControlModeEvent::ExtendedOutput {
                pane_id, content, ..
            } => self.output_result(pane_id, &content),

            ControlModeEvent::LayoutChange {
                window_id,
                layout,
                visible_layout,
                flags,
            } => {
                // Use full layout for pane existence (includes hidden panes during zoom).
                // Use visible_layout for rendered geometry (zoom adjusts sizes).
                let zoomed = flags.contains('Z');

                // Parse the full layout to track pane existence and membership
                let resized_panes = self.handle_layout_change(&window_id, &layout);

                // When zoomed, also parse visible_layout to update rendered geometry
                if zoomed {
                    // visible_layout shows only the zoomed pane at full window dimensions
                    self.update_pane_geometry_from_layout(&window_id, &visible_layout);
                }

                // Track zoom state on window
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.zoomed = zoomed;
                }

                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::PaneLayout,
                    commands: self.collapsible_layout_commands(Some(&window_id)),
                    ..Default::default()
                }
            }

            // Unlinked window add: from other sessions — ignore.
            ControlModeEvent::UnlinkedWindowAdd { .. } => ProcessEventResult::default(),

            // Unlinked window close: fires for non-current windows in ANY session.
            // If the window exists in our state, it belongs to our session — remove it.
            // If not, it's from another session — ignore.
            ControlModeEvent::UnlinkedWindowClose { window_id } => {
                if self.windows.contains_key(&window_id) {
                    self.windows.remove(&window_id);
                    self.panes.retain(|_, p| !p.in_window(&window_id));
                    self.pending_captures
                        .retain(|id| self.panes.contains_key(id));
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
                self.windows
                    .entry(window_id.clone())
                    .or_insert_with(|| WindowState::new(window_id.clone(), provisional_index));
                // Don't emit state yet - wait for WindowRenamed or list-windows
                // to populate the window name. This prevents brief flashes of
                // windows appearing with empty names (which breaks stack detection).
                ProcessEventResult::default()
            }

            ControlModeEvent::WindowClose { window_id } => {
                self.windows.remove(&window_id);
                self.border_enforced.remove(&window_id);
                self.sidebar_border_cleared.remove(&window_id);
                self.panes.retain(|_, p| !p.in_window(&window_id));
                self.pending_captures
                    .retain(|id| self.panes.contains_key(id));
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowRenamed { window_id, name } => {
                // Create window if it doesn't exist yet (rename can arrive before
                // add), with a provisional positional index (see
                // next_window_index).
                let provisional_index = self.next_window_index();
                let window = self
                    .windows
                    .entry(window_id.clone())
                    .or_insert_with(|| WindowState::new(window_id.clone(), provisional_index));
                window.name = name;
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowPaneChanged { window_id, pane_id } => {
                // Track active pane in window state (survives pane creation/deletion)
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.active_pane_id = Some(pane_id.clone());
                }
                // Update active pane flag on existing panes
                for pane in self.panes.values_mut() {
                    if pane.in_window(&window_id) {
                        pane.active = pane.id == pane_id;
                    }
                }
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::PaneFocus,
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

            ControlModeEvent::PaneModeChanged { pane_id } => {
                // Toggle in_mode for the pane. %pane-mode-changed fires on both
                // entering and exiting copy mode, so toggling is correct.
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    pane.in_mode = !pane.in_mode;
                }
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::PaneFocus,
                    ..Default::default()
                }
            }

            ControlModeEvent::PasteBufferChanged { buffer_name } => {
                // tmux does not forward OSC 52 to control-mode clients, so a
                // copy-mode yank only surfaces as %paste-buffer-changed. The
                // buffer is read in-band over the control channel, wrapped in
                // sentinel lines that make the response unambiguously
                // identifiable among interleaved capture-pane replies; the
                // reply becomes a clipboard write on the same path as OSC 52.
                //
                // SEC-13: paste buffers are global to the tmux SERVER, and the
                // event names no origin — so a `load-buffer secret.txt` or a
                // yank in someone else's session would otherwise be mirrored
                // to every client of this one. The only available signal for
                // "did this come from here?" is a pane of THIS session being
                // in copy mode, which is what a yank leaves behind.
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
                self.pending_buffer_reads.push_back(buffer_name.clone());
                ProcessEventResult {
                    commands: vec![self.markers.buffer_read_command(&buffer_name)],
                    ..Default::default()
                }
            }

            ControlModeEvent::SessionWindowChanged { window_id, .. } => {
                // Update active window
                for (id, window) in self.windows.iter_mut() {
                    window.active = *id == window_id;
                }
                self.active_window_id = Some(window_id.clone());
                // Refresh capture for every pane in the newly active window so
                // long-idle tabs don't show stale content after a switch. The
                // monitor batches these into a single capture-pane round-trip.
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
                // %sessions-changed is a GLOBAL event sent to ALL control mode
                // clients when ANY session is created/destroyed. It does NOT mean
                // the current session's state changed. Suppress state emission to
                // prevent cross-session interference (e.g., E2E test sessions
                // causing spurious updates in the user's UI).
                ProcessEventResult::default()
            }
            ControlModeEvent::SessionChanged {
                session_id,
                session_name,
            } => {
                self.session_id = Some(session_id);
                self.session_name = session_name;
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Session,
                    ..Default::default()
                }
            }
            ControlModeEvent::SessionRenamed { session_id, name } => {
                if self
                    .session_id
                    .as_ref()
                    .is_some_and(|ours| *ours != session_id)
                {
                    return ProcessEventResult::default();
                }
                self.session_name = name;
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Session,
                    ..Default::default()
                }
            }
            ControlModeEvent::Exit { .. } => ProcessEventResult {
                state_changed: true,
                change_type: ChangeType::Session,
                ..Default::default()
            },

            // A message is for the person, not the tree; the monitor hands it
            // to the emitter before a step is taken.
            ControlModeEvent::Message { .. } => ProcessEventResult::default(),

            // ============================================
            // Flow Control Events (tmux 3.2+ pause-after)
            // ============================================
            ControlModeEvent::Pause { pane_id } => {
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    pane.paused = true;
                    return ProcessEventResult {
                        state_changed: true,
                        change_type: ChangeType::FlowPause { pane_id },
                        ..Default::default()
                    };
                }
                ProcessEventResult::default()
            }

            ControlModeEvent::Continue { pane_id } => {
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    pane.paused = false;
                    return ProcessEventResult {
                        state_changed: true,
                        change_type: ChangeType::FlowContinue { pane_id },
                        ..Default::default()
                    };
                }
                ProcessEventResult::default()
            }
        }
    }
}
