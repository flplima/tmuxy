use super::*;

impl<C: ControlLink> TmuxMonitor<C> {
    /// Synchronize initial state by querying tmux.
    #[instrument(skip(self), fields(session = %self.config.session))]
    pub async fn sync_initial_state(&mut self) -> Result<(), TmuxError> {
        // Set window-size to manual BEFORE resizing, so the resize doesn't
        // trigger SIGWINCH to the shell (which causes prompt redraw %output
        // that races with our capture-pane responses).
        self.connection
            .send_command("set window-size manual")
            .await?;

        // Resize the window to the initial size to ensure panes aren't tiny.
        // When running in a background process, the PTY may start small.
        // The browser will send a proper resize once it connects.
        if !self.config.observer {
            self.connection
                .send_command(&initial_resize_command(&self.config.session))
                .await?;
        }

        // Source tmuxy config to ensure pane-border-status and other settings are applied
        if let Some(config_path) = crate::session::get_config_path() {
            let cmd = format!("source-file {}", config_path.to_string_lossy());
            self.connection.send_command(&cmd).await?;
        }

        // Re-apply the choices made through the UI (theme, mode, cursor blink).
        // tmux forgets them when its server exits; tmuxy.state.json does not.
        // After the config so a UI choice wins over a hand-set value there.
        for cmd in crate::session::managed_state_commands(&crate::session::read_managed_state()) {
            self.connection.send_command(&cmd).await?;
        }

        // Enforce critical settings on the current session regardless of config.
        // These are invariants the frontend depends on — if any are wrong, layout
        // breaks (missing rows), input fails, or content is corrupted.
        self.enforce_settings().await?;

        // Tell the helper scripts which binary runs this build's server verbs
        // (see `session::SERVER_BIN_ENV`). A viewer changes nothing on the
        // server it watches.
        if !self.config.observer {
            for cmd in crate::session::server_command_env() {
                self.connection.send_command(&cmd).await?;
            }
        }

        // Enable flow control (tmux 3.2+)
        // pause-after=5 means pause output if client is 5+ seconds behind
        // This prevents unbounded memory growth during heavy output
        self.connection
            .send_command("refresh-client -f pause-after=5")
            .await?;

        // Panes before windows, then the stash session's hidden pane-group
        // members (empty, not an error, when there is no stash session): the
        // one order `window_relist_commands` documents.
        for cmd in window_relist_commands() {
            self.connection.send_command(&cmd).await?;
        }

        // Title changes have no notification of their own; this asks tmux to
        // send one (see SUBSCRIBE_PANE_TITLES_CMD).
        self.connection
            .send_command(tmux_formats::SUBSCRIBE_PANE_TITLES_CMD)
            .await?;

        // Capture current content of each pane
        // We'll do this after we receive the list-panes response
        // to know which panes exist

        Ok(())
    }

    /// Enforce critical tmux settings that the frontend depends on.
    ///
    /// Sends `set` commands directly to the attached tmux session so they take
    /// effect immediately, regardless of what the user's config file contains.
    /// This does NOT modify any config file on disk.
    pub(super) async fn enforce_settings(&mut self) -> Result<(), TmuxError> {
        let settings = [
            // CRITICAL: PaneLayout assumes border-status top — without it,
            // y=0 panes lose 1 row of content (the header steals from terminal area).
            ("pane-border-status", "top"),
            // Blank border format so the row is visually empty behind PaneHeader.
            ("pane-border-format", " "),
            // Mouse support for click-to-focus, scrolling, and selection.
            ("mouse", "on"),
            // Focus events for applications like vim/neovim.
            ("focus-events", "on"),
            // Allow applications to set pane title via OSC 0/2.
            ("allow-rename", "on"),
            ("set-titles", "on"),
            // SEC-01: tmux itself honours OSC 52 by loading the text into a
            // paste buffer, and paste buffers are global to the tmux server —
            // so a background pane's write reached every client through the
            // buffer mirror, past the active-pane gate the aggregator applies
            // to the same sequence. tmuxy carries OSC 52 to the client's own
            // clipboard on its own; tmux need not.
            ("set-clipboard", "off"),
        ];

        for (key, value) in &settings {
            // Session-level (not -g) to avoid a tmux 3.5a bug where global
            // settings + control mode + new-session -d crashes the server.
            // Each session's monitor enforces its own settings on connect.
            let cmd = format!("set {} '{}'", key, value);
            self.connection.send_command(&cmd).await?;
        }

        // Options newer than the oldest tmux tmuxy supports. `-q` lets that
        // tmux skip one it does not know instead of reporting an error.
        let newer_settings = [
            // Allow OSC passthrough for hyperlinks, images, and other
            // sequences. tmux 3.3 added the option; 3.2 passes them through
            // unconditionally.
            ("allow-passthrough", "on"),
        ];

        for (key, value) in &newer_settings {
            let cmd = format!("set -q {} '{}'", key, value);
            self.connection.send_command(&cmd).await?;
        }

        // window-size manual is set earlier in sync_initial_state() before resizew,
        // so that the resize doesn't trigger SIGWINCH prompt redraws.

        // Window-level settings (setw, deliberately WITHOUT -g — see below)
        let window_settings = [
            // Disable aggressive-resize — tmuxy manages sizing.
            ("aggressive-resize", "off"),
        ];

        for (key, value) in &window_settings {
            // Session-level to avoid tmux 3.5a global+CC crash.
            let cmd = format!("setw {} {}", key, value);
            self.connection.send_command(&cmd).await?;
        }

        Ok(())
    }

    /// Apply the throttle / debounce / immediate-emit policy for a state change.
    pub(super) fn handle_state_change<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        change: &ChangeType,
    ) {
        let is_output_event = matches!(change, ChangeType::PaneOutput { .. });
        let now = Instant::now();

        // A window coming or going also renumbers every window after it
        // (`renumber-windows on`), and `%window-close` carries no indices — so
        // schedule the same deferred refresh a window event as for output.
        if is_output_event || matches!(change, ChangeType::Window) {
            rs.schedule_metadata_sync(tokio::time::Instant::now());
        }

        if is_output_event {
            rs.update_rate(now);
            if rs.in_throttle_mode {
                rs.pending_output_emit = true;
                if now.saturating_duration_since(rs.last_output_emit)
                    >= self.config.throttle_interval
                {
                    if let Some(update) = self.aggregator.to_state_update() {
                        emitter.emit_state(update);
                    }
                    rs.mark_emitted(now);
                }
            } else {
                if rs.pending_output_first_at.is_none() {
                    rs.pending_output_first_at = Some(now);
                }
                rs.last_output_event_at = Some(now);
                rs.pending_output_emit = true;
            }
        } else if matches!(change, ChangeType::PaneLayout) {
            rs.pending_layout_emit = true;
        } else {
            if let Some(update) = self.aggregator.to_state_update() {
                emitter.emit_state(update);
            }
            rs.mark_emitted(now);
            rs.pending_layout_emit = false;
        }
    }

    /// High-throughput throttle window expired — flush whatever is pending.
    pub(super) fn on_throttle_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        if let Some(update) = self.aggregator.to_state_update() {
            emitter.emit_state(update);
        }
        rs.mark_emitted(Instant::now());
    }

    /// Layout debounce window expired — flush the coalesced layout state.
    pub(super) fn on_layout_debounce<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        if let Some(update) = self.aggregator.to_state_update() {
            emitter.emit_state(update);
        }
        rs.last_output_emit = Instant::now();
        rs.pending_layout_emit = false;
    }

    /// Settling deadline reached — drain `aggregator.tick(now)`. The aggregator
    /// owns settling state now, so the only thing the monitor does is dispatch
    /// the effects (today: at most one immediate `EmitState`).
    pub(super) fn on_settling_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        let effects = self.aggregator.tick(Instant::now());
        if effects.is_empty() {
            trace!("settling tick: safety timeout or already cleared, no emit");
            return;
        }
        for effect in effects {
            match effect {
                SideEffect::EmitState { change } => {
                    self.handle_state_change(emitter, rs, &change);
                }
                other => {
                    warn!(?other, "unexpected settling tick effect (future expansion)");
                }
            }
        }
    }

    /// Deferred metadata refresh fired — request a fresh `list-panes` so
    /// `pane_current_command` reflects the post-exit shell prompt, and a fresh
    /// `list-windows` so window indices are right after a close renumbers them.
    pub(super) async fn on_metadata_sync<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
    ) {
        rs.metadata_sync_at = None;
        let cmds = vec![
            tmux_formats::LIST_WINDOWS_CMD.to_string(),
            tmux_formats::LIST_PANES_CMD.to_string(),
            tmux_formats::LIST_STASH_PANES_CMD.to_string(),
        ];
        if let Err(e) = self.connection.send_commands_batch(&cmds).await {
            emitter.emit_error(format!("Failed to sync metadata: {}", e));
        }
    }

    /// Idle / copy-mode sync tick. Fast-polls copy mode (50ms) for cursor updates,
    /// otherwise heartbeats (15s) to catch out-of-band tmux mutations.
    pub(super) async fn on_sync_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        let in_copy_mode = self.aggregator.has_pane_in_copy_mode();
        let is_idle = rs.last_event_at.elapsed() > IDLE_THRESHOLD;

        if in_copy_mode {
            let copy_pane_info = self.aggregator.get_copy_mode_pane_info();
            let copy_pane_ids: Vec<PaneId> =
                copy_pane_info.iter().map(|(id, _, _)| id.clone()).collect();
            // Queue first and send only what was newly queued, mirroring
            // refresh_panes. Building a capture for every copy-mode pane and
            // ignoring the queued subset meant that at the 50ms copy-mode
            // cadence a slow response piled duplicate captures onto the
            // connection for panes whose capture was already in flight.
            let queued = self.aggregator.queue_captures(&copy_pane_ids);
            let mut cmds = vec![tmux_formats::LIST_PANES_CMD.to_string()];
            for (pane_id, scroll_pos, height) in &copy_pane_info {
                if !queued.contains(pane_id) {
                    continue;
                }
                if *scroll_pos > 0 {
                    let start = -(*scroll_pos as i64) - (*height as i64) + 1;
                    let end = -(*scroll_pos as i64);
                    cmds.push(capture_command_range(pane_id, start, end));
                } else {
                    cmds.push(capture_command(pane_id));
                }
            }
            if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                emitter.emit_error(format!("Failed to sync copy mode: {}", e));
            }
            rs.next_sync_at = tokio::time::Instant::now() + COPY_MODE_SYNC_INTERVAL;
        } else if is_idle {
            let cmds = vec![
                tmux_formats::LIST_WINDOWS_CMD.to_string(),
                tmux_formats::LIST_PANES_CMD.to_string(),
                tmux_formats::LIST_STASH_PANES_CMD.to_string(),
            ];
            if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                emitter.emit_error(format!("Failed to heartbeat sync: {}", e));
            }
            rs.next_sync_at = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;
        } else {
            let time_until_idle = IDLE_THRESHOLD.saturating_sub(rs.last_event_at.elapsed());
            rs.next_sync_at = tokio::time::Instant::now() + time_until_idle;
        }
    }
}
