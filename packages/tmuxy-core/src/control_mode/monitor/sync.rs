use super::*;

impl<C: ControlLink> TmuxMonitor<C> {
    /// Synchronize initial state by querying tmux.
    #[instrument(skip(self), fields(session = %self.config.session))]
    pub async fn sync_initial_state(&mut self) -> Result<(), TmuxError> {
        // Set window-size to manual BEFORE resizing, so the resize doesn't
        // trigger SIGWINCH to the shell (which causes prompt redraw %output
        // that races with our capture-pane responses). Only the current
        // window, which the attach-time resize below reaches; every window
        // is set up on its own once it is listed (`window_setup_commands`).
        self.connection
            .send_commands(&["set window-size manual"])
            .await?;

        // Resize the window to the initial size to ensure panes aren't tiny.
        // When running in a background process, the PTY may start small.
        // The browser will send a proper resize once it connects.
        self.connection
            .send_commands(&[&initial_resize_command(&self.config.session)])
            .await?;

        // Source the config chain (defaults, the user's tmuxy.conf, the
        // essentials) so pane-border-status and other settings are applied.
        if let Some(config_path) = crate::session::get_config_path() {
            let cmd = format!(
                "source-file {}",
                crate::executor::tmux_quote(&config_path.to_string_lossy())
            );
            self.connection.send_commands(&[&cmd]).await?;
        }

        // Re-apply the choices made through the UI (theme, mode, cursor blink).
        // tmux forgets them when its server exits; tmuxy.state.json does not.
        // After the config, and only for what the user's tmuxy.conf leaves
        // unset: an option it sets is pinned, and config beats menu state.
        for cmd in crate::session::current_managed_state_commands() {
            self.connection.send_commands(&[&cmd]).await?;
        }

        // Enforce critical settings on the current session regardless of config.
        // These are invariants the frontend depends on — if any are wrong, layout
        // breaks (missing rows), input fails, or content is corrupted.
        self.enforce_settings().await?;

        // Tell the helper scripts which binary runs this build's server verbs
        // (see `session::SERVER_BIN_ENV`).
        for cmd in crate::session::server_command_env() {
            self.connection.send_commands(&[&cmd]).await?;
        }

        // The plugins this machine has, for the client's menus (a fresh tmux
        // server has none until something writes them). A server over SSH is
        // another machine's, whose own tmuxy publishes its plugins.
        if crate::session::ssh_target().is_none() {
            match crate::plugins::inventory::commands(&crate::paths::Layout::current()) {
                Ok(commands) => {
                    for cmd in commands {
                        self.connection.send_commands(&[&cmd]).await?;
                    }
                }
                Err(e) => warn!(error = %e, "the plugin inventory is not published"),
            }
            // The plugin keys need the tables read back, which only the
            // running loop answers: the host binds them once this sync is
            // done (`transport::apply_plugin_keys`).
        }

        // Enable flow control (tmux 3.2+)
        // pause-after=5 means pause output if client is 5+ seconds behind
        // This prevents unbounded memory growth during heavy output
        self.connection
            .send_commands(&["refresh-client -f pause-after=5"])
            .await?;

        // Panes before windows, then the stash session's hidden pane-group
        // members (empty, not an error, when there is no stash session): the
        // one order `window_relist_commands` documents.
        let relist = self.aggregator.markers().window_relist_commands();
        self.connection.send_commands(&relist).await?;

        // Title changes have no notification of their own; this asks tmux to
        // send one (see `subscribe_pane_titles_command`). Nor does a theme
        // change (see `subscribe_theme_command`).
        self.connection
            .send_commands(&[
                tmux_formats::subscribe_pane_titles_command(),
                tmux_formats::subscribe_theme_command(),
            ])
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
        // The window options (borders, sizing) are set on each window as the
        // aggregator first sees it (`window_setup_commands`).
        let settings = [
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
            // Session-level (not -g): docs/TMUX-CONFIG.md records a tmux 3.5a
            // crash with global settings under control mode. Each session's
            // monitor enforces its own settings on connect.
            let cmd = format!("set {} '{}'", key, value);
            self.connection.send_commands(&[&cmd]).await?;
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
            self.connection.send_commands(&[&cmd]).await?;
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
            rs.schedule_layout_emit(tokio::time::Instant::now());
        } else {
            if let Some(update) = self.aggregator.to_state_update() {
                emitter.emit_state(update);
            }
            rs.mark_emitted(now);
            rs.layout_emit_at = None;
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
        // The delta carried whatever output was pending too.
        rs.mark_emitted(Instant::now());
        rs.layout_emit_at = None;
    }

    /// Settling deadline reached — drain `aggregator.tick(now)`, which owns
    /// the settling state, and emit the consolidated state it says is due.
    pub(super) fn on_settling_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        match self.aggregator.tick(Instant::now()) {
            Some(change) => self.handle_state_change(emitter, rs, &change),
            None => trace!("settling tick: safety timeout or already cleared, no emit"),
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
        let cmds = [TmuxList::Windows, TmuxList::Panes, TmuxList::Stash]
            .map(|list| self.aggregator.markers().list_command(list));
        if let Err(e) = self.connection.send_commands(&cmds).await {
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
            let mut cmds = vec![self.aggregator.markers().list_command(TmuxList::Panes)];
            for (pane_id, scroll_pos, height) in &copy_pane_info {
                if !queued.contains(pane_id) {
                    continue;
                }
                if *scroll_pos > 0 {
                    let start = -(*scroll_pos as i64) - (*height as i64) + 1;
                    let end = -(*scroll_pos as i64);
                    cmds.push(
                        self.aggregator
                            .markers()
                            .capture_command_range(pane_id, start, end),
                    );
                } else {
                    cmds.push(self.aggregator.markers().capture_command(pane_id));
                }
            }
            if let Err(e) = self.connection.send_commands(&cmds).await {
                emitter.emit_error(format!("Failed to sync copy mode: {}", e));
            }
            rs.next_sync_at = tokio::time::Instant::now() + COPY_MODE_SYNC_INTERVAL;
        } else if is_idle {
            let cmds = [TmuxList::Windows, TmuxList::Panes, TmuxList::Stash]
                .map(|list| self.aggregator.markers().list_command(list));
            if let Err(e) = self.connection.send_commands(&cmds).await {
                emitter.emit_error(format!("Failed to heartbeat sync: {}", e));
            }
            rs.next_sync_at = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;
        } else {
            let time_until_idle = IDLE_THRESHOLD.saturating_sub(rs.last_event_at.elapsed());
            rs.next_sync_at = tokio::time::Instant::now() + time_until_idle;
        }
    }
}
