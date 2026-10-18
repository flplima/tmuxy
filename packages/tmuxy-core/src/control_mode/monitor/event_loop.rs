use super::*;

/// Interval for the periodic state sync (list-panes for cursor position).
pub(super) const SYNC_INTERVAL: Duration = Duration::from_millis(500);
/// Idle threshold: heartbeats fire only after this much silence.
pub(super) const IDLE_THRESHOLD: Duration = Duration::from_secs(10);
/// Copy-mode poll interval (cursor needs sub-100ms updates).
pub(super) const COPY_MODE_SYNC_INTERVAL: Duration = Duration::from_millis(50);
/// Heartbeat interval when fully idle.
pub(super) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// Below the throttle threshold, output is debounced by this much silence...
pub(super) const LOW_THROUGHPUT_DEBOUNCE: Duration = Duration::from_millis(16);
/// ...but never held back longer than this after the first pending byte.
pub(super) const PENDING_OUTPUT_MAX: Duration = Duration::from_millis(100);
/// How long after output or a window change the metadata re-sync runs.
pub(super) const METADATA_SYNC_DELAY: Duration = Duration::from_millis(500);
/// Rapid layout changes (a zoom-out cascade) coalesce over this window.
pub(super) const LAYOUT_DEBOUNCE: Duration = Duration::from_millis(16);

/// Events within one [`RATE_WINDOW`] above which output is throttled. Below
/// it, events emit immediately for low latency.
pub(super) const THROTTLE_THRESHOLD: u32 = 20;

/// Window for counting events to detect high-frequency output.
pub(super) const RATE_WINDOW: Duration = Duration::from_millis(100);

/// The per-invocation runtime state of `TmuxMonitor::run`. Keeping it in one
/// struct lets `run`'s body stay a dispatch over `tokio::select!`, with each
/// branch delegating to a small method that mutates `RunState` through a
/// `&mut`, and lets the throttling/debounce logic be tested without tmux.
pub(super) struct RunState {
    /// Timestamp of the last control-mode event (for idle classification).
    pub(super) last_event_at: tokio::time::Instant,
    /// Next scheduled sync tick.
    pub(super) next_sync_at: tokio::time::Instant,

    // Output throttling / debouncing
    pub(super) last_output_emit: Instant,
    pub(super) pending_output_emit: bool,
    pub(super) last_output_event_at: Option<Instant>,
    pub(super) pending_output_first_at: Option<Instant>,
    pub(super) rate_window_start: Instant,
    pub(super) rate_event_count: u32,
    pub(super) in_throttle_mode: bool,

    // Metadata sync after output settles
    pub(super) metadata_sync_at: Option<tokio::time::Instant>,

    // Layout debouncing
    pub(super) pending_layout_emit: bool,
}

impl RunState {
    /// Ask for a metadata re-sync `METADATA_SYNC_DELAY` from now — unless one
    /// is already due, which stands. Pushing it back on every event made it a
    /// debounce, and a pane that never stops printing (an agent's spinner)
    /// starved it: titles and `@tmuxy-pane-state` froze for as long as the
    /// program kept drawing, which is exactly while it was working.
    pub(super) fn schedule_metadata_sync(&mut self, now: tokio::time::Instant) {
        self.metadata_sync_at
            .get_or_insert(now + METADATA_SYNC_DELAY);
    }

    /// `now_std` is the std clock the throttle/debounce deadlines are computed
    /// from (the tests pass explicit instants); `now_async` is the tokio
    /// reactor's monotonic clock the sync and heartbeat timers sleep against.
    pub(super) fn new(config: &MonitorConfig, now_std: Instant) -> Self {
        let now_async = tokio::time::Instant::now();
        Self {
            last_event_at: now_async,
            next_sync_at: now_async + SYNC_INTERVAL + Duration::from_secs(1),

            last_output_emit: now_std - config.throttle_interval,
            pending_output_emit: false,
            last_output_event_at: None,
            pending_output_first_at: None,
            rate_window_start: now_std,
            rate_event_count: 0,
            in_throttle_mode: false,

            metadata_sync_at: None,

            pending_layout_emit: false,
        }
    }

    /// Compute the sleep duration for the throttle-tick branch.
    /// `Duration::from_secs(3600)` is the "effectively infinite" sentinel; the
    /// `if pending_output_emit` guard on the branch is what actually parks us.
    pub(super) fn compute_throttle_sleep(&self, config: &MonitorConfig, now: Instant) -> Duration {
        if !self.pending_output_emit {
            return LONG_SLEEP;
        }
        if self.in_throttle_mode {
            let elapsed = now.saturating_duration_since(self.last_output_emit);
            if elapsed >= config.throttle_interval {
                Duration::ZERO
            } else {
                config.throttle_interval - elapsed
            }
        } else {
            let since_last_event = self
                .last_output_event_at
                .map(|t| now.duration_since(t))
                .unwrap_or(Duration::ZERO);
            let since_first_pending = self
                .pending_output_first_at
                .map(|t| now.duration_since(t))
                .unwrap_or(Duration::ZERO);
            let remaining_debounce = LOW_THROUGHPUT_DEBOUNCE.saturating_sub(since_last_event);
            let remaining_max = PENDING_OUTPUT_MAX.saturating_sub(since_first_pending);
            remaining_debounce.min(remaining_max)
        }
    }

    /// Mark a fresh output emission — reset the debounce / rate-tracking trackers.
    pub(super) fn mark_emitted(&mut self, now: Instant) {
        self.last_output_emit = now;
        self.pending_output_emit = false;
        self.pending_output_first_at = None;
        self.last_output_event_at = None;
    }

    /// Slide the rate-tracking window and toggle high/low throughput mode based
    /// on the hysteresis threshold.
    pub(super) fn update_rate(&mut self, now: Instant) {
        if now.duration_since(self.rate_window_start) > RATE_WINDOW {
            let exit_threshold = THROTTLE_THRESHOLD / 2;
            if self.in_throttle_mode && self.rate_event_count <= exit_threshold {
                self.in_throttle_mode = false;
            } else if !self.in_throttle_mode && self.rate_event_count > THROTTLE_THRESHOLD {
                self.in_throttle_mode = true;
            }
            self.rate_window_start = now;
            self.rate_event_count = 1;
        } else {
            self.rate_event_count += 1;
            if !self.in_throttle_mode && self.rate_event_count > THROTTLE_THRESHOLD {
                self.in_throttle_mode = true;
            }
        }
    }
}

impl<C: ControlLink> TmuxMonitor<C> {
    /// Run the monitor event loop.
    ///
    /// This is the main loop that processes control mode events and emits state changes.
    /// It runs until the connection is closed or an error occurs.
    #[instrument(skip(self, emitter), fields(session = %self.config.session))]
    pub async fn run<E: StateEmitter>(&mut self, emitter: &E) {
        // Sync initial state
        if let Err(e) = self.sync_initial_state().await {
            emitter.emit_error(format!("Failed to sync initial state: {}", e));
            return;
        }

        // Notify emitter that initial sync (including config sourcing) is done.
        // SseEmitter uses this to broadcast keybindings with correct prefix key.
        emitter.on_initial_sync_complete();

        let mut rs = RunState::new(&self.config, Instant::now());

        loop {
            let throttle_sleep = rs.compute_throttle_sleep(&self.config, Instant::now());
            let settling_sleep = self
                .aggregator
                .settling_deadline()
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(LONG_SLEEP);
            let metadata_deadline = rs
                .metadata_sync_at
                .unwrap_or_else(|| tokio::time::Instant::now() + LONG_SLEEP);
            let reply_deadline = self
                .pending_replies
                .values()
                .map(|(_, sent_at)| *sent_at + REPLY_TIMEOUT)
                .min()
                .unwrap_or_else(|| tokio::time::Instant::now() + LONG_SLEEP);

            tokio::select! {
                // Process control mode events
                event = self.connection.recv() => {
                    if !self.on_control_event(emitter, &mut rs, event).await {
                        break;
                    }
                }

                // Throttle timer - emit pending output when in high-throughput mode
                _ = tokio::time::sleep(throttle_sleep), if rs.pending_output_emit => {
                    self.on_throttle_tick(emitter, &mut rs);
                }

                // Layout debounce timer - coalesce rapid layout changes (zoom-out)
                _ = tokio::time::sleep(LAYOUT_DEBOUNCE), if rs.pending_layout_emit => {
                    self.on_layout_debounce(emitter, &mut rs);
                }

                // Settling timer — `aggregator.tick(now)` drains the consolidated
                // emit after compound-command events settle.
                _ = tokio::time::sleep(settling_sleep), if self.aggregator.is_settling() => {
                    self.on_settling_tick(emitter, &mut rs);
                }

                // Deferred metadata sync: refresh pane commands after output settles
                _ = tokio::time::sleep_until(metadata_deadline), if rs.metadata_sync_at.is_some() => {
                    self.on_metadata_sync(emitter, &mut rs).await;
                }

                // Event-driven sync: fast polling in copy mode, heartbeat when idle
                _ = tokio::time::sleep_until(rs.next_sync_at) => {
                    self.on_sync_tick(emitter, &mut rs).await;
                }

                // Handle external commands (resize, etc.)
                cmd = self.command_rx.recv() => {
                    if !self.on_command(emitter, cmd).await {
                        break;
                    }
                }

                // A reply whose closing marker never came: fail it so the
                // caller is not left waiting on a connection that has gone
                // quiet, rather than for ever.
                _ = tokio::time::sleep_until(reply_deadline), if !self.pending_replies.is_empty() => {
                    self.expire_replies();
                }
            }
        }
        info!("run() exiting");
    }

    /// Dispatch a single control-mode event. Returns `false` to stop the loop.
    ///
    /// Drives the sans-IO aggregator via `step(event) -> StepResult` and runs
    /// every typed `SideEffect` the result describes. The aggregator emits
    /// effects in the load-bearing order documented on `state::SideEffect`
    /// (A1 in `docs/INVARIANTS.md`); the dispatcher below is one `for` over
    /// that list, each effect awaited before the next, which is what keeps
    /// the order 1:1 (M1), so:
    ///   1. Foreign `%session-changed` events are filtered before mutation.
    ///   2. `AdoptUntaggedWindows` runs first so emissions reflect tagged state.
    ///   3. Images / clipboard fire before list-pane refreshes.
    ///   4. `RefreshAfterWindowAdd` issues list-panes BEFORE list-windows.
    ///   5. `RefreshPanes` issues list-panes before per-pane capture-pane.
    ///   6. `EmitState` arrives last and triggers the throttle/debounce policy.
    pub(super) async fn on_control_event<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        event: Option<ControlModeEvent>,
    ) -> bool {
        let event = match event {
            Some(ControlModeEvent::Exit { reason }) => {
                // Carry tmux's own reason before it is collapsed: `%exit
                // detached` means the user detached, and a client that cannot
                // tell that from a dropped link has to present a deliberate
                // detach as a failure to retry.
                emitter.emit_disconnected(reason.clone());
                let msg = reason.unwrap_or_else(|| "disconnected".to_string());
                warn!(reason = %msg, "control mode exit event");
                emitter.emit_error(format!("Control mode exited: {}", msg));
                return false;
            }
            None => {
                warn!("control mode recv() returned None - connection closed");
                emitter.emit_error("Control mode connection closed".to_string());
                return false;
            }
            Some(ev) => ev,
        };

        rs.last_event_at = tokio::time::Instant::now();

        // Guard: suppress %session-changed events for other sessions. Creating
        // a new tmux session (even from a separate process) fires
        // %session-changed on ALL control mode clients. Suppress these to
        // prevent the aggregator from updating session_name and emitting
        // cross-session state.
        if let ControlModeEvent::SessionChanged {
            ref session_name, ..
        } = event
        {
            if !self.config.session.is_empty() && *session_name != self.config.session {
                debug!(
                    actual = %session_name,
                    expected = %self.config.session,
                    "suppressing SessionChanged for foreign session"
                );
                return true;
            }
        }

        match &event {
            ControlModeEvent::Output { .. } | ControlModeEvent::CommandResponse { .. } => {}
            other => {
                trace!(event = ?other, "control mode event");
            }
        }

        // A message is for the person, not the tree: it goes straight to the
        // emitter and the aggregator never sees it.
        if let ControlModeEvent::Message { text } = event {
            if !text.is_empty() {
                emitter.show_message(text);
            }
            return true;
        }

        let step = self.aggregator.step_at(event, Instant::now());

        for effect in step.effects {
            match effect {
                SideEffect::AdoptUntaggedWindows(cmds) => {
                    if !self.logged_adoption {
                        info!(count = cmds.len(), "auto-adopting untagged windows");
                        self.logged_adoption = true;
                    }
                    if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                        emitter.emit_error(format!("Failed to auto-adopt windows: {}", e));
                    }
                }
                SideEffect::StoreImages { pane_id, images } => {
                    if !images.is_empty() {
                        emitter.store_images(&pane_id, images);
                    }
                }
                SideEffect::WriteClipboard { pane_id, text } => {
                    emitter.write_clipboard(pane_id.as_ref(), text);
                }
                SideEffect::RefreshAfterWindowAdd => {
                    self.refresh_after_window_add(emitter).await;
                }
                SideEffect::RefreshPanes { pane_ids } => {
                    self.refresh_panes(emitter, &pane_ids).await;
                }
                SideEffect::ResumePane(pane_id) => {
                    let cmd = format!("refresh-client -A '{}:continue'", pane_id);
                    if let Err(e) = self.connection.send_command(&cmd).await {
                        emitter.emit_error(format!("Failed to resume pane {}: {}", pane_id, e));
                    }
                }
                SideEffect::EmitState { change } => {
                    self.handle_state_change(emitter, rs, &change);
                }
                // The aggregator's own in-band reads — the marker-wrapped
                // `show-buffer` that mirrors a copy-mode yank to the clipboard
                // — go over the same connection as everything else.
                SideEffect::SendTmuxCommand(cmd) => {
                    if let Err(e) = self.connection.send_command(&cmd).await {
                        emitter.emit_error(format!("Failed to send command: {}", e));
                    }
                }
                SideEffect::CommandReply { id, output, error } => {
                    match self.pending_replies.remove(&id) {
                        Some((ReplyWaiter::Caller(reply), _)) => {
                            // A caller that stopped waiting is not an error.
                            let _ = reply.send(CommandReply { output, error });
                        }
                        Some((ReplyWaiter::ReportFailure, _)) => {
                            // A `display-message` this client ran is answered
                            // inside its own block, so it is here as output,
                            // not as a notification. Nothing else reads this
                            // output; a caller's reply is left as tmux sent it.
                            for text in output.lines().filter_map(super::parser::message_line) {
                                if !text.is_empty() {
                                    emitter.show_message(text);
                                }
                            }
                            if let Some(error) = error {
                                emitter.emit_error(error);
                            }
                        }
                        None => debug!(id, "reply for an expired or unknown request"),
                    }
                }
            }
        }

        // Size any windows the client's viewport has not reached yet. This runs
        // AFTER the step's own effects: injecting commands before them jumps the
        // queue ahead of this step's EmitState, and the window payload that
        // carries @tmuxy-window-type gets dropped — leaving the frontend with
        // untagged windows and an empty tab strip.
        if self.client_size.is_some() {
            self.apply_client_size(emitter).await;
        }

        // After this event's refreshes were queued, so a snapshot never slips
        // in between a list-panes and the captures it asked for.
        self.answer_state_requests();

        true
    }
}
