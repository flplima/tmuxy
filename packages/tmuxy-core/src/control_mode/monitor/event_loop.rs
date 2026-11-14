use super::*;

/// Below the throttle threshold, output is debounced by this much silence...
pub(super) const LOW_THROUGHPUT_DEBOUNCE: Duration = Duration::from_millis(16);
/// ...but never held back longer than this after the first pending byte.
pub(super) const PENDING_OUTPUT_MAX: Duration = Duration::from_millis(100);
/// Rapid layout changes (a zoom-out cascade) coalesce over this window.
pub(super) const LAYOUT_DEBOUNCE: Duration = Duration::from_millis(16);

/// Events within one [`RATE_WINDOW`] above which output is throttled. Below
/// it, output is debounced ([`LOW_THROUGHPUT_DEBOUNCE`]).
pub(super) const THROTTLE_THRESHOLD: u32 = 20;

/// Window for counting events to detect high-frequency output.
pub(super) const RATE_WINDOW: Duration = Duration::from_millis(100);

/// The native emission policy: output throttled under load and debounced
/// otherwise, layout changes coalesced, everything else at once.
pub(super) struct RunState {
    pub(super) last_output_emit: Instant,
    pub(super) pending_output_emit: bool,
    pub(super) last_output_event_at: Option<Instant>,
    pub(super) pending_output_first_at: Option<Instant>,
    pub(super) rate_window_start: Instant,
    pub(super) rate_event_count: u32,
    pub(super) in_throttle_mode: bool,

    pub(super) layout_emit_at: Option<tokio::time::Instant>,
}

impl RunState {
    /// Emit the coalesced layout `LAYOUT_DEBOUNCE` from now — unless one is
    /// already due, which stands: a sleep rebuilt on every `select!` turn let
    /// any event, a busy pane's output included, push the layout back.
    pub(super) fn schedule_layout_emit(&mut self, now: tokio::time::Instant) {
        self.layout_emit_at.get_or_insert(now + LAYOUT_DEBOUNCE);
    }

    /// `now_std` is the clock the throttle/debounce deadlines are computed
    /// from (the tests pass explicit instants).
    pub(super) fn new(config: &MonitorConfig, now_std: Instant) -> Self {
        Self {
            last_output_emit: now_std - config.throttle_interval,
            pending_output_emit: false,
            last_output_event_at: None,
            pending_output_first_at: None,
            rate_window_start: now_std,
            rate_event_count: 0,
            in_throttle_mode: false,

            layout_emit_at: None,
        }
    }

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
    /// Run the monitor event loop until the connection closes.
    #[instrument(skip(self, emitter), fields(session = %self.config.session))]
    pub async fn run<E: StateEmitter>(&mut self, emitter: &E) {
        if let Err(e) = self.sync_initial_state().await {
            emitter.emit_error(format!("Failed to sync initial state: {}", e));
            return;
        }

        emitter.on_initial_sync_complete();

        let mut rs = RunState::new(&self.config, Instant::now());

        loop {
            let throttle_sleep = rs.compute_throttle_sleep(&self.config, Instant::now());
            let layout_deadline = rs
                .layout_emit_at
                .unwrap_or_else(|| tokio::time::Instant::now() + LONG_SLEEP);
            let core_sleep = self
                .core
                .next_deadline()
                .saturating_duration_since(Instant::now());
            // A hidden pane's last frame, held back (`state::hidden_panes`).
            let hidden_due = self.core.aggregator().hidden_panes_due();
            let hidden_sleep = hidden_due.map_or(LONG_SLEEP, |due| {
                due.saturating_duration_since(Instant::now())
            });

            let running = tokio::select! {
                event = self.connection.recv() => match event {
                    Some(event) => {
                        let actions = self.core.step(event, Instant::now());
                        let running = self.dispatch(emitter, &mut rs, actions).await;
                        // After this event's refreshes were queued, so a
                        // snapshot never slips in between a list-panes and
                        // the captures it asked for.
                        self.answer_state_requests();
                        running
                    }
                    None => {
                        warn!("control mode recv() returned None - connection closed");
                        emitter.emit_error("Control mode connection closed".to_string());
                        false
                    }
                },

                _ = tokio::time::sleep(throttle_sleep), if rs.pending_output_emit => {
                    self.flush(emitter, &mut rs);
                    true
                }

                _ = tokio::time::sleep_until(layout_deadline), if rs.layout_emit_at.is_some() => {
                    self.flush(emitter, &mut rs);
                    true
                }

                _ = tokio::time::sleep(hidden_sleep), if hidden_due.is_some() => {
                    self.flush(emitter, &mut rs);
                    true
                }

                _ = tokio::time::sleep(core_sleep) => {
                    let actions = self.core.tick(Instant::now());
                    self.dispatch(emitter, &mut rs, actions).await
                }

                cmd = self.command_rx.recv() => self.on_command(emitter, &mut rs, cmd).await,
            };
            if !running {
                break;
            }
        }
        info!("run() exiting");
    }

    /// Run what the core asked for, in its order, each before the next (M1).
    /// Returns `false` once the connection has ended.
    pub(super) async fn dispatch<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        actions: Vec<Action<Caller>>,
    ) -> bool {
        for action in actions {
            match action {
                Action::Send(lines) => {
                    if let Err(e) = self.connection.send_commands(&lines).await {
                        emitter.emit_error(format!("Failed to send commands: {e}"));
                    }
                }
                Action::Emit(change) => self.handle_state_change(emitter, rs, change),
                Action::Notify(notice) => notify(emitter, notice),
                // A caller that stopped waiting is not an error.
                Action::Answer(caller, reply) => {
                    let _ = caller.send(reply);
                }
                Action::Ended(reason) => {
                    emitter.emit_disconnected(reason.clone());
                    let msg = reason.unwrap_or_else(|| "disconnected".to_string());
                    warn!(reason = %msg, "control mode exit event");
                    emitter.emit_error(format!("Control mode exited: {}", msg));
                    return false;
                }
            }
        }
        true
    }
}

pub(super) fn notify<E: StateEmitter>(emitter: &E, notice: Notice) {
    match notice {
        Notice::Images { pane_id, images } => emitter.store_images(&pane_id, images),
        Notice::Clipboard { pane_id, text } => emitter.write_clipboard(pane_id.as_ref(), text),
        Notice::Message(text) => emitter.show_message(text),
        Notice::Error(error) => emitter.emit_error(error),
    }
}
