//! TmuxMonitor - High-level API with adapter pattern
//!
//! This module provides the main interface for tmux control mode monitoring.
//! It uses an adapter pattern (like the frontend) to support different backends:
//! - SSE (tmuxy-server)
//! - Tauri events (tauri-app)

use super::connection::{ControlModeConnection, INITIAL_PTY_COLS, INITIAL_PTY_ROWS};
use super::parser::ControlModeEvent;
use super::state::{
    capture_command, capture_command_range, ChangeType, SideEffect, StateAggregator,
};
use crate::constants::tmux_formats;
use crate::ctx::Ctx;
use crate::error::TmuxError;
use crate::StateUpdate;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, info, instrument, trace, warn};

/// Commands that can be sent to the monitor from external code
#[derive(Debug)]
pub enum MonitorCommand {
    /// Resize all windows in the session to the given dimensions
    ResizeWindow { cols: u32, rows: u32 },
    /// Run an arbitrary tmux command through control mode
    /// Use this for commands that crash when run externally with control mode attached (e.g., new-window)
    RunCommand { command: String },
    /// Gracefully shutdown the monitor
    /// Sends detach-client and waits for the connection to close cleanly
    Shutdown,
}

/// Trait for emitting state changes (adapter pattern).
///
/// Implement this trait in tmuxy-server (SseEmitter) and tauri-app (TauriEmitter)
/// to receive state updates from the monitor.
///
/// `StateEmitter: LogSink` — emitters may also override [`LogSink::log`] to
/// surface connection-time command/output progress to the UI.
pub trait StateEmitter: super::log::LogSink {
    /// Called when tmux state changes (full or delta update)
    fn emit_state(&self, update: StateUpdate);

    /// Called when an error occurs
    fn emit_error(&self, error: String);

    /// Called when new images are decoded from terminal output.
    /// Default implementation discards images (for emitters that don't need them).
    fn store_images(&self, _pane_id: &str, _images: Vec<(u32, super::images::StoredImage)>) {}

    /// Called when an OSC 52 clipboard request is decoded from terminal output.
    /// `text` is the UTF-8 string the application asked to place on the system
    /// clipboard. Default implementation discards the request.
    fn write_clipboard(&self, _pane_id: &str, _text: String) {}

    /// Called after initial state sync completes (config sourced, settings enforced).
    /// Default implementation does nothing.
    fn on_initial_sync_complete(&self) {}
}

/// Configuration for TmuxMonitor
#[derive(Debug, Clone)]
pub struct MonitorConfig {
    /// Session name to connect to
    pub session: String,

    /// Interval for periodic state sync (e.g., list-panes for cursor position)
    pub sync_interval: Duration,

    /// Whether to create the session if it doesn't exist
    pub create_session: bool,

    /// Minimum interval between throttled state emissions.
    /// Used when high-frequency output is detected.
    /// Recommended: 16ms (60fps) for smooth updates during bulk output.
    pub throttle_interval: Duration,

    /// Number of events in rate window that triggers throttle mode.
    /// Below this threshold, events emit immediately for low latency.
    pub throttle_threshold: u32,

    /// Window for counting events to detect high-frequency output.
    pub rate_window: Duration,

    /// Working directory for the tmux control mode process.
    /// run-shell commands resolve relative paths from this directory.
    pub working_dir: Option<std::path::PathBuf>,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            session: String::new(),
            sync_interval: Duration::from_millis(500),
            create_session: false,
            throttle_interval: Duration::from_millis(32), // ~30fps during high throughput
            throttle_threshold: 20,                       // >20 events/100ms triggers throttle
            rate_window: Duration::from_millis(100),
            working_dir: None,
        }
    }
}

/// Handle for sending commands to a running TmuxMonitor
pub type MonitorCommandSender = mpsc::Sender<MonitorCommand>;

/// "Effectively infinite" sleep used by `tokio::select!` branches that need a
/// `sleep_until` ceiling for branches gated behind an `Option<Instant>`. The
/// real deadline is the `if` guard on the branch; this constant only exists
/// so the future has *some* await point when the guard is false.
const LONG_SLEEP: Duration = Duration::from_secs(3600);

/// All the per-invocation runtime state that used to live as locals in
/// `TmuxMonitor::run`. Extracting it lets `run`'s body shrink to a ~50-line
/// dispatch over `tokio::select!`, with each branch delegating to a small
/// method that mutates `RunState` through a `&mut`.
///
/// The split is purely organisational — semantics are preserved 1:1, and the
/// pre-existing tests cover the throttling/debounce/settling behaviour.
struct RunState {
    /// Idle threshold: heartbeats fire only after this much silence.
    idle_threshold: Duration,
    /// Copy-mode poll interval (cursor needs sub-100ms updates).
    copy_mode_sync_interval: Duration,
    /// Heartbeat interval when fully idle.
    heartbeat_interval: Duration,
    /// Timestamp of the last control-mode event (for idle classification).
    last_event_at: tokio::time::Instant,
    /// Next scheduled sync tick.
    next_sync_at: tokio::time::Instant,

    // Output throttling / debouncing
    last_output_emit: Instant,
    pending_output_emit: bool,
    last_output_event_at: Option<Instant>,
    pending_output_first_at: Option<Instant>,
    low_throughput_debounce: Duration,
    pending_output_max: Duration,
    rate_window_start: Instant,
    rate_event_count: u32,
    throttle_enabled: bool,
    in_throttle_mode: bool,

    // Metadata sync after output settles
    metadata_sync_at: Option<tokio::time::Instant>,
    metadata_sync_delay: Duration,

    // Layout debouncing
    pending_layout_emit: bool,
    layout_debounce: Duration,
}

impl RunState {
    /// `now_std` comes from the injected `Ctx::clock` so tests can advance time
    /// deterministically. `now_async` is the tokio reactor's monotonic clock,
    /// which is fixed to the real reactor — fakes for it would need
    /// `tokio::time::pause`, which is a higher-cost test-hook than the std
    /// clock and is left to follow-up work.
    fn new(config: &MonitorConfig, now_std: Instant) -> Self {
        let now_async = tokio::time::Instant::now();
        Self {
            idle_threshold: Duration::from_secs(10),
            copy_mode_sync_interval: Duration::from_millis(50),
            heartbeat_interval: Duration::from_secs(15),
            last_event_at: now_async,
            next_sync_at: now_async + config.sync_interval + Duration::from_secs(1),

            last_output_emit: now_std - config.throttle_interval,
            pending_output_emit: false,
            last_output_event_at: None,
            pending_output_first_at: None,
            low_throughput_debounce: Duration::from_millis(16),
            pending_output_max: Duration::from_millis(100),
            rate_window_start: now_std,
            rate_event_count: 0,
            throttle_enabled: !config.throttle_interval.is_zero(),
            in_throttle_mode: false,

            metadata_sync_at: None,
            metadata_sync_delay: Duration::from_millis(500),

            pending_layout_emit: false,
            layout_debounce: Duration::from_millis(16),
        }
    }

    /// Compute the sleep duration for the throttle-tick branch.
    /// `Duration::from_secs(3600)` is the "effectively infinite" sentinel; the
    /// `if pending_output_emit` guard on the branch is what actually parks us.
    /// `now` comes from `Ctx::clock` so tests can drive the deadline math.
    fn compute_throttle_sleep(&self, config: &MonitorConfig, now: Instant) -> Duration {
        if !(self.pending_output_emit && self.throttle_enabled) {
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
            let remaining_debounce = self
                .low_throughput_debounce
                .saturating_sub(since_last_event);
            let remaining_max = self.pending_output_max.saturating_sub(since_first_pending);
            remaining_debounce.min(remaining_max)
        }
    }

    /// Mark a fresh output emission — reset the debounce / rate-tracking trackers.
    fn mark_emitted(&mut self, now: Instant) {
        self.last_output_emit = now;
        self.pending_output_emit = false;
        self.pending_output_first_at = None;
        self.last_output_event_at = None;
    }

    /// Slide the rate-tracking window and toggle high/low throughput mode based
    /// on the hysteresis threshold.
    fn update_rate(&mut self, config: &MonitorConfig, now: Instant) {
        if now.duration_since(self.rate_window_start) > config.rate_window {
            let exit_threshold = config.throttle_threshold / 2;
            if self.in_throttle_mode && self.rate_event_count <= exit_threshold {
                self.in_throttle_mode = false;
            } else if !self.in_throttle_mode && self.rate_event_count > config.throttle_threshold {
                self.in_throttle_mode = true;
            }
            self.rate_window_start = now;
            self.rate_event_count = 1;
        } else {
            self.rate_event_count += 1;
            if !self.in_throttle_mode && self.rate_event_count > config.throttle_threshold {
                self.in_throttle_mode = true;
            }
        }
    }
}

/// The main tmux control mode monitor.
///
/// This struct handles:
/// - Connecting to tmux in control mode
/// - Processing events and aggregating state
/// - Emitting state changes via the StateEmitter trait
pub struct TmuxMonitor {
    /// Connection to tmux control mode
    connection: ControlModeConnection,

    /// State aggregator
    aggregator: StateAggregator,

    /// Configuration
    config: MonitorConfig,

    /// Channel for receiving commands from external code
    command_rx: mpsc::Receiver<MonitorCommand>,

    /// Count of pending resize commands sent. When >0, the next PaneLayout
    /// changes are resize-triggered (SIGWINCH may produce stale %output).
    pending_resize_count: u32,

    /// True once we've tagged every untagged window with @tmuxy-window-type.
    /// Reset every connect; the first list-windows response triggers the
    /// one-time auto-adopt of pre-existing windows.
    window_tags_migrated: bool,

    /// Execution context — `ctx.clock.now()` replaces every `Instant::now()`
    /// inside the loop so tests can advance time with `FakeClock`.
    ctx: Arc<Ctx>,
}

impl TmuxMonitor {
    /// Connect to a tmux session in control mode.
    /// Returns the monitor and a sender for sending commands to it.
    ///
    /// `log` receives streaming progress entries (each tmux invocation, its
    /// output, and any retry decisions). Pass `None` if the caller doesn't
    /// surface these to a UI.
    #[instrument(skip(log, ctx), fields(session = %config.session))]
    pub async fn connect(
        config: MonitorConfig,
        log: Option<&std::sync::Arc<dyn super::log::LogSink>>,
        ctx: Arc<Ctx>,
    ) -> Result<(Self, MonitorCommandSender), TmuxError> {
        // Serialize control mode attachment to prevent concurrent operations
        // that crash tmux 3.5a (multiple CC clients racing to attach).
        // `tmux -CC new-session -A` (when create_session is true) handles
        // both create and attach atomically — no clientless gap for the
        // macOS launchd reaper to hit.
        let connection = {
            let _lock = super::connection::session_creation_lock().await;
            ControlModeConnection::connect(
                &config.session,
                config.working_dir.as_deref(),
                log,
                config.create_session,
            )
            .await?
        };

        let (command_tx, command_rx) = mpsc::channel(32);

        Ok((
            Self {
                connection,
                aggregator: StateAggregator::new(),
                config,
                command_rx,
                pending_resize_count: 0,
                window_tags_migrated: false,
                ctx,
            },
            command_tx,
        ))
    }

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
        // When running in a background process (pm2), the PTY may start small.
        // The browser will send a proper resize once it connects.
        self.connection
            .send_command(&format!(
                "resizew -t {} -x {} -y {}",
                self.config.session, INITIAL_PTY_COLS, INITIAL_PTY_ROWS
            ))
            .await?;

        // Source tmuxy config to ensure pane-border-status and other settings are applied
        if let Some(config_path) = crate::session::get_config_path() {
            let cmd = format!("source-file {}", config_path.to_string_lossy());
            self.connection.send_command(&cmd).await?;
        }

        // Enforce critical settings on the current session regardless of config.
        // These are invariants the frontend depends on — if any are wrong, layout
        // breaks (missing rows), input fails, or content is corrupted.
        self.enforce_settings().await?;

        // Enable flow control (tmux 3.2+)
        // pause-after=5 means pause output if client is 5+ seconds behind
        // This prevents unbounded memory growth during heavy output
        self.connection
            .send_command("refresh-client -f pause-after=5")
            .await?;

        // Get list of windows (including float window options)
        self.connection
            .send_command(tmux_formats::LIST_WINDOWS_CMD)
            .await?;

        // Get list of panes with all details (for current session only)
        self.connection
            .send_command(tmux_formats::LIST_PANES_CMD)
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
    async fn enforce_settings(&mut self) -> Result<(), TmuxError> {
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
            // Allow OSC passthrough for hyperlinks, images, and other sequences.
            ("allow-passthrough", "on"),
            // Allow applications to set pane title via OSC 0/2.
            ("allow-rename", "on"),
            ("set-titles", "on"),
        ];

        for (key, value) in &settings {
            // Session-level (not -g) to avoid a tmux 3.5a bug where global
            // settings + control mode + new-session -d crashes the server.
            // Each session's monitor enforces its own settings on connect.
            let cmd = format!("set {} '{}'", key, value);
            self.connection.send_command(&cmd).await?;
        }

        // window-size manual is set earlier in sync_initial_state() before resizew,
        // so that the resize doesn't trigger SIGWINCH prompt redraws.

        // Window-level settings (setw -g)
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

        let mut rs = RunState::new(&self.config, self.ctx.clock.now());

        loop {
            let throttle_sleep = rs.compute_throttle_sleep(&self.config, self.ctx.clock.now());
            let settling_sleep = self
                .aggregator
                .settling_deadline()
                .map(|d| d.saturating_duration_since(self.ctx.clock.now()))
                .unwrap_or(LONG_SLEEP);
            let metadata_deadline = rs
                .metadata_sync_at
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
                _ = tokio::time::sleep(rs.layout_debounce), if rs.pending_layout_emit => {
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
            }
        }
        info!("run() exiting");
    }

    /// Dispatch a single control-mode event. Returns `false` to stop the loop.
    ///
    /// Drives the sans-IO aggregator via `step(event) -> StepResult` and runs
    /// every typed `SideEffect` the result describes. The aggregator emits
    /// effects in the load-bearing order documented on `state::SideEffect`;
    /// the dispatcher below preserves that ordering 1:1, so:
    ///   1. Foreign `%session-changed` events are filtered before mutation.
    ///   2. `AdoptUntaggedWindows` runs first so emissions reflect tagged state.
    ///   3. Images / clipboard fire before list-pane refreshes.
    ///   4. `RefreshAfterWindowAdd` issues list-panes BEFORE list-windows.
    ///   5. `RefreshPanes` issues list-panes before per-pane capture-pane.
    ///   6. `EmitState` arrives last and triggers the throttle/debounce policy.
    async fn on_control_event<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        event: Option<ControlModeEvent>,
    ) -> bool {
        let event = match event {
            Some(ControlModeEvent::Exit { reason }) => {
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

        // tmux does not forward OSC 52 to a control-mode client, so a copy-mode
        // yank never reaches the per-pane OSC parser. Instead tmux fires
        // %paste-buffer-changed; read the buffer (read-only) and mirror it to the
        // web clipboard through the same emitter path as application OSC 52.
        if let ControlModeEvent::PasteBufferChanged { buffer_name } = &event {
            match crate::executor::show_buffer_named(buffer_name) {
                Ok(text) if !text.is_empty() => emitter.write_clipboard("", text),
                Ok(_) => {}
                Err(e) => debug!(buffer = %buffer_name, error = %e, "show-buffer failed"),
            }
            return true;
        }

        match &event {
            ControlModeEvent::Output { .. } | ControlModeEvent::CommandResponse { .. } => {}
            other => {
                trace!(event = ?other, "control mode event");
            }
        }

        let step = self.aggregator.step_at(event, self.ctx.clock.now());

        for effect in step.effects {
            match effect {
                SideEffect::AdoptUntaggedWindows(cmds) => {
                    if !self.window_tags_migrated {
                        info!(count = cmds.len(), "auto-adopting untagged windows");
                        self.window_tags_migrated = true;
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
                    emitter.write_clipboard(&pane_id, text);
                }
                SideEffect::RefreshAfterWindowAdd => {
                    self.refresh_after_window_add(emitter).await;
                }
                SideEffect::RefreshPanes { pane_ids } => {
                    self.refresh_panes(emitter, &step.change_type, &pane_ids)
                        .await;
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
                // Variants reserved for future migrations — the current monitor
                // routes raw commands through dedicated paths, so these are
                // unreachable today. They stay in the enum so the API is
                // stable as more I/O migrates onto effects.
                SideEffect::SendTmuxCommand(cmd) => {
                    if let Err(e) = self.connection.send_command(&cmd).await {
                        emitter.emit_error(format!("Failed to send command: {}", e));
                    }
                }
                SideEffect::SendTmuxBatch(cmds) => {
                    if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                        emitter.emit_error(format!("Failed to batch send: {}", e));
                    }
                }
            }
        }

        true
    }

    /// After WindowAdd: list-panes BEFORE list-windows. break-pane creating a float
    /// window leaves the new pane absent from `self.panes` until list-panes restores
    /// it; list-windows would otherwise emit state with the pane missing.
    async fn refresh_after_window_add<E: StateEmitter>(&mut self, emitter: &E) {
        let cmds = vec![
            tmux_formats::LIST_PANES_CMD.to_string(),
            tmux_formats::LIST_WINDOWS_CMD.to_string(),
        ];
        if let Err(e) = self.connection.send_commands_batch(&cmds).await {
            emitter.emit_error(format!("Failed to refresh state after window add: {}", e));
        }
    }

    /// Send list-panes (for fresh cursor positions) followed by capture-pane for
    /// each pane that flagged itself as needing refresh. Ordering is load-bearing:
    /// list-panes must precede capture-pane so the cursor repositioning logic uses
    /// the updated `tmux_cursor_x/y` when capture responses arrive.
    async fn refresh_panes<E: StateEmitter>(
        &mut self,
        emitter: &E,
        change: &ChangeType,
        pane_ids: &[String],
    ) {
        let queued_panes =
            if self.pending_resize_count > 0 && matches!(change, ChangeType::PaneLayout) {
                self.pending_resize_count -= 1;
                self.aggregator.queue_resize_captures(pane_ids)
            } else {
                self.aggregator.queue_captures(pane_ids)
            };

        let mut commands: Vec<String> = vec![tmux_formats::LIST_PANES_CMD.to_string()];
        commands.extend(queued_panes.iter().map(|pane_id| capture_command(pane_id)));

        if let Err(e) = self.connection.send_commands_batch(&commands).await {
            emitter.emit_error(format!("Failed to batch capture panes: {}", e));
        }
    }

    /// Apply the throttle / debounce / immediate-emit policy for a state change.
    fn handle_state_change<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        change: &ChangeType,
    ) {
        let is_output_event = matches!(change, ChangeType::PaneOutput { .. });
        let now = self.ctx.clock.now();

        if is_output_event {
            rs.metadata_sync_at = Some(tokio::time::Instant::now() + rs.metadata_sync_delay);
        }

        if is_output_event && rs.throttle_enabled {
            rs.update_rate(&self.config, now);
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
    fn on_throttle_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        if let Some(update) = self.aggregator.to_state_update() {
            emitter.emit_state(update);
        }
        rs.mark_emitted(self.ctx.clock.now());
    }

    /// Layout debounce window expired — flush the coalesced layout state.
    fn on_layout_debounce<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        if let Some(update) = self.aggregator.to_state_update() {
            emitter.emit_state(update);
        }
        rs.last_output_emit = self.ctx.clock.now();
        rs.pending_layout_emit = false;
    }

    /// Settling deadline reached — drain `aggregator.tick(now)`. The aggregator
    /// owns settling state now, so the only thing the monitor does is dispatch
    /// the effects (today: at most one immediate `EmitState`).
    fn on_settling_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        let effects = self.aggregator.tick(self.ctx.clock.now());
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
    /// `pane_current_command` reflects the post-exit shell prompt.
    async fn on_metadata_sync<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        rs.metadata_sync_at = None;
        if let Err(e) = self
            .connection
            .send_command(tmux_formats::LIST_PANES_CMD)
            .await
        {
            emitter.emit_error(format!("Failed to sync metadata: {}", e));
        }
    }

    /// Idle / copy-mode sync tick. Fast-polls copy mode (50ms) for cursor updates,
    /// otherwise heartbeats (15s) to catch out-of-band tmux mutations.
    async fn on_sync_tick<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        let in_copy_mode = self.aggregator.has_pane_in_copy_mode();
        let is_idle = rs.last_event_at.elapsed() > rs.idle_threshold;

        if in_copy_mode {
            let copy_pane_info = self.aggregator.get_copy_mode_pane_info();
            let copy_pane_ids: Vec<String> =
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
            rs.next_sync_at = tokio::time::Instant::now() + rs.copy_mode_sync_interval;
        } else if is_idle {
            let cmds = vec![
                tmux_formats::LIST_WINDOWS_CMD.to_string(),
                tmux_formats::LIST_PANES_CMD.to_string(),
            ];
            if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                emitter.emit_error(format!("Failed to heartbeat sync: {}", e));
            }
            rs.next_sync_at = tokio::time::Instant::now() + rs.heartbeat_interval;
        } else {
            let time_until_idle = rs.idle_threshold.saturating_sub(rs.last_event_at.elapsed());
            rs.next_sync_at = tokio::time::Instant::now() + time_until_idle;
        }
    }

    /// Handle a `MonitorCommand` from external code. Returns false to stop the loop.
    async fn on_command<E: StateEmitter>(
        &mut self,
        emitter: &E,
        cmd: Option<MonitorCommand>,
    ) -> bool {
        trace!(?cmd, "received monitor command");
        match cmd {
            Some(MonitorCommand::ResizeWindow { cols, rows }) => {
                debug!(cols, rows, "processing ResizeWindow");
                let window_ids = self.aggregator.window_ids();
                if window_ids.is_empty() {
                    let resize_cmd = format!("resizew -x {} -y {}", cols, rows);
                    if let Err(e) = self.connection.send_command(&resize_cmd).await {
                        emitter.emit_error(format!("Failed to resize window: {}", e));
                    } else {
                        self.pending_resize_count += 1;
                        trace!(cmd = %resize_cmd, "sent resize command");
                    }
                } else {
                    let cmds: Vec<String> = window_ids
                        .iter()
                        .map(|wid| format!("resizew -t {} -x {} -y {}", wid, cols, rows))
                        .collect();
                    debug!(count = cmds.len(), "resizing windows");
                    if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                        emitter.emit_error(format!("Failed to resize windows: {}", e));
                    } else {
                        self.pending_resize_count += 1;
                    }
                }
                true
            }
            Some(MonitorCommand::RunCommand { command }) => {
                debug!(%command, "processing RunCommand");
                let unescaped = command.replace(" \\; ", " ; ");
                let is_compound = is_multi_step_run_shell(&unescaped);
                if is_compound {
                    self.aggregator.arm_settling(self.ctx.clock.now());
                    debug!("settling armed for multi-step run-shell");
                }

                if let Err(e) = self.connection.send_command(&unescaped).await {
                    emitter.emit_error(format!("Failed to run command: {}", e));
                    if is_compound {
                        self.aggregator.clear_settling();
                    }
                } else {
                    trace!(cmd = %unescaped, "sent command via control mode");
                }
                true
            }
            Some(MonitorCommand::Shutdown) => {
                info!("received shutdown command, gracefully closing");
                self.connection.graceful_close().await;
                false
            }
            None => {
                warn!("command channel closed, stopping");
                false
            }
        }
    }
}

/// True when a control-mode command will run a tmuxy bash script that mutates
/// tmux state across multiple separate tmux calls (split → break → set-option
/// → swap → resize, etc.). Each step fires its own %layout-change / %window-add
/// event; without settling, the frontend renders the intermediate split before
/// the script lands on the final group layout. Matching by script name (not by
/// "run-shell" alone) avoids false positives on harmless one-shot scripts like
/// event-emit or list-* helpers.
fn is_multi_step_run_shell(command: &str) -> bool {
    if !command.contains("run-shell") {
        return false;
    }
    const MULTI_STEP_SCRIPTS: &[&str] = &[
        "pane-group-add",
        "pane-group-close",
        "pane-group-switch",
        "pane-group-next",
        "pane-group-prev",
        "float-create",
    ];
    MULTI_STEP_SCRIPTS.iter().any(|s| command.contains(s))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // Reusable test fixture — kept for future StateEmitter tests even though
    // none of the current tests instantiate it.
    #[allow(dead_code)]
    struct TestEmitter {
        updates: Arc<Mutex<Vec<StateUpdate>>>,
        errors: Arc<Mutex<Vec<String>>>,
    }

    impl super::super::log::LogSink for TestEmitter {}

    impl StateEmitter for TestEmitter {
        fn emit_state(&self, update: StateUpdate) {
            self.updates.lock().unwrap().push(update);
        }

        fn emit_error(&self, error: String) {
            self.errors.lock().unwrap().push(error);
        }
    }

    #[test]
    fn test_config_default() {
        let config = MonitorConfig::default();
        assert_eq!(config.sync_interval, Duration::from_millis(500));
        assert!(!config.create_session);
    }

    #[test]
    fn test_is_multi_step_run_shell_matches_pane_group_scripts() {
        // Real-world commands the frontend sends through SEND_TMUX_COMMAND.
        assert!(is_multi_step_run_shell(
            "run-shell \"$HOME/.config/tmuxy/bin/tmuxy/pane-group-add %3 80 24\""
        ));
        assert!(is_multi_step_run_shell(
            "run-shell \"$HOME/.config/tmuxy/bin/tmuxy/pane-group-close %3\""
        ));
        assert!(is_multi_step_run_shell(
            "run-shell \"$HOME/.config/tmuxy/bin/tmuxy/float-create lazygit\""
        ));
    }

    #[test]
    fn test_is_multi_step_run_shell_skips_one_shot_commands() {
        // Plain run-shell to one-shot helpers shouldn't arm settling.
        assert!(!is_multi_step_run_shell("run-shell \"echo hello\""));
        assert!(!is_multi_step_run_shell(
            "run-shell \"tmuxy/bin/tmuxy/event-emit foo\""
        ));
        // Non-run-shell commands never arm.
        assert!(!is_multi_step_run_shell("splitw -h"));
        assert!(!is_multi_step_run_shell(
            "splitw ; breakp ; set-option -w @tmuxy-window-type tab"
        ));
    }

    // =========================================================================
    // RunState helper tests (Phase 3.6 follow-up).
    //
    // These exercise the pure functions extracted from `run()` directly,
    // without spinning a tmux process. Time advancement is simulated by
    // passing explicit `Instant` values — no tokio, no sleeps.
    // =========================================================================

    fn run_state_with_now(now: Instant) -> (MonitorConfig, RunState) {
        let cfg = MonitorConfig {
            throttle_interval: Duration::from_millis(32),
            throttle_threshold: 20,
            rate_window: Duration::from_millis(100),
            ..MonitorConfig::default()
        };
        let rs = RunState::new(&cfg, now);
        (cfg, rs)
    }

    #[test]
    fn compute_throttle_sleep_returns_long_sleep_when_nothing_pending() {
        let now = Instant::now();
        let (cfg, rs) = run_state_with_now(now);
        assert_eq!(rs.compute_throttle_sleep(&cfg, now), LONG_SLEEP);
    }

    #[test]
    fn compute_throttle_sleep_zero_when_throttle_interval_already_passed() {
        let now = Instant::now();
        let (cfg, mut rs) = run_state_with_now(now);
        rs.pending_output_emit = true;
        rs.in_throttle_mode = true;
        // Pretend we last emitted >>throttle_interval ago.
        rs.last_output_emit = now - cfg.throttle_interval - Duration::from_millis(10);
        assert_eq!(
            rs.compute_throttle_sleep(&cfg, now),
            Duration::ZERO,
            "if the throttle window has elapsed, sleep should be zero"
        );
    }

    #[test]
    fn compute_throttle_sleep_remaining_interval_when_recent_emit() {
        let now = Instant::now();
        let (cfg, mut rs) = run_state_with_now(now);
        rs.pending_output_emit = true;
        rs.in_throttle_mode = true;
        rs.last_output_emit = now - Duration::from_millis(10);
        let remaining = rs.compute_throttle_sleep(&cfg, now);
        assert!(remaining > Duration::ZERO);
        assert!(remaining <= cfg.throttle_interval);
    }

    #[test]
    fn mark_emitted_resets_pending_trackers() {
        let now = Instant::now();
        let (_cfg, mut rs) = run_state_with_now(now);
        rs.pending_output_emit = true;
        rs.pending_output_first_at = Some(now);
        rs.last_output_event_at = Some(now);
        let later = now + Duration::from_millis(50);
        rs.mark_emitted(later);
        assert_eq!(rs.last_output_emit, later);
        assert!(!rs.pending_output_emit);
        assert_eq!(rs.pending_output_first_at, None);
        assert_eq!(rs.last_output_event_at, None);
    }

    #[test]
    fn update_rate_enters_throttle_above_threshold() {
        let now = Instant::now();
        let (cfg, mut rs) = run_state_with_now(now);
        assert!(!rs.in_throttle_mode);
        // Push the counter past `throttle_threshold` within the same window.
        // The first call resets `rate_window_start` to `now`, so subsequent
        // calls accumulate. We loop one past the threshold to cross it.
        for _ in 0..=cfg.throttle_threshold {
            rs.update_rate(&cfg, now);
        }
        assert!(
            rs.in_throttle_mode,
            "exceeding throttle_threshold should flip the mode"
        );
    }

    #[test]
    fn update_rate_exits_throttle_when_rate_drops() {
        let now = Instant::now();
        let (cfg, mut rs) = run_state_with_now(now);
        rs.in_throttle_mode = true;
        rs.rate_event_count = 0;
        rs.rate_window_start = now;
        // Advance the clock past the rate window so update_rate evaluates
        // the hysteresis on the previous window's count (zero) and exits.
        let after_window = now + cfg.rate_window + Duration::from_millis(10);
        rs.update_rate(&cfg, after_window);
        assert!(
            !rs.in_throttle_mode,
            "a fully-quiet rate window should exit throttle mode"
        );
    }
}
