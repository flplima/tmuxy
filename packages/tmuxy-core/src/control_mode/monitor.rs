//! TmuxMonitor - High-level API with adapter pattern
//!
//! This module provides the main interface for tmux control mode monitoring.
//! It uses an adapter pattern (like the frontend) to support different backends:
//! - SSE (tmuxy-server)
//! - Tauri events (tauri-app)

use super::connection::{ControlModeConnection, INITIAL_PTY_COLS, INITIAL_PTY_ROWS};
use super::parser::ControlModeEvent;
use super::state::{ChangeType, StateAggregator};
use crate::{StateUpdate, TmuxState};
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
}

impl TmuxMonitor {
    /// Connect to a tmux session in control mode.
    /// Returns the monitor and a sender for sending commands to it.
    ///
    /// `log` receives streaming progress entries (each tmux invocation, its
    /// output, and any retry decisions). Pass `None` if the caller doesn't
    /// surface these to a UI.
    #[instrument(skip(log), fields(session = %config.session))]
    pub async fn connect(
        config: MonitorConfig,
        log: Option<&std::sync::Arc<dyn super::log::LogSink>>,
    ) -> Result<(Self, MonitorCommandSender), String> {
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
            },
            command_tx,
        ))
    }

    /// Synchronize initial state by querying tmux.
    #[instrument(skip(self), fields(session = %self.config.session))]
    pub async fn sync_initial_state(&mut self) -> Result<(), String> {
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
            .send_command("list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active},#{@tmuxy-window-type},#{@tmuxy-float-parent},#{@tmuxy-float-width},#{@tmuxy-float-height},#{@tmuxy-float-drawer},#{@tmuxy-float-bg},#{@tmuxy-float-noheader},#{@tmuxy-group-panes}'")
            .await?;

        // Get list of panes with all details (for current session only)
        self.connection
            .send_command(concat!(
                "list-panes -s -F '",
                "#{pane_id},#{pane_index},",
                "#{pane_left},#{pane_top},",
                "#{pane_width},#{pane_height},",
                "#{cursor_x},#{cursor_y},",
                "#{pane_active},#{pane_current_command},#{pane_title},",
                "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                "#{scroll_position},",
                "#{window_id},#{T:pane-border-format},",
                "#{alternate_on},#{mouse_any_flag},",
                "#{selection_present},",
                "#{selection_start_x},#{selection_start_y},#{history_size}'"
            ))
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
    async fn enforce_settings(&mut self) -> Result<(), String> {
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

        // Event-driven sync: only poll when idle (no events in 10s) or in copy mode.
        // Copy mode needs fast polling (50ms) for cursor position updates.
        // Heartbeat runs every 15s during idle to catch external changes.
        let copy_mode_sync_interval = Duration::from_millis(50);
        let heartbeat_interval = Duration::from_secs(15);
        let idle_threshold = Duration::from_secs(10);
        let mut last_event_at = tokio::time::Instant::now();
        // Initial delay before first sync to let captures complete
        let mut next_sync_at =
            tokio::time::Instant::now() + self.config.sync_interval + Duration::from_secs(1);

        // Adaptive throttling state for output events
        // - Track event rate over 100ms window
        // - If high throughput (>20 events/100ms), throttle at throttle_interval
        // - Otherwise, true trailing-edge debounce (16ms) coalesces clear+redraw
        //   bursts from TUI apps (Ink-based UIs like Gemini) so the cleared
        //   intermediate state never reaches the renderer between %output events.
        let mut last_output_emit = Instant::now() - self.config.throttle_interval;
        let mut pending_output_emit = false;
        // Trailing-edge debounce trackers (low-throughput mode):
        // - last_output_event_at resets on every new event, so the timer fires
        //   only after events stop for `low_throughput_debounce`.
        // - pending_output_first_at bounds the total wait via `pending_output_max`,
        //   so a steady drip of events still produces a visible update.
        let mut last_output_event_at: Option<Instant> = None;
        let mut pending_output_first_at: Option<Instant> = None;
        let low_throughput_debounce = Duration::from_millis(16);
        let pending_output_max = Duration::from_millis(100);
        let mut rate_window_start = Instant::now();
        let mut rate_event_count: u32 = 0;
        let throttle_enabled = !self.config.throttle_interval.is_zero();
        // Hysteresis: enter throttle at threshold, exit at threshold/2
        let mut in_throttle_mode = false;

        // Deferred metadata sync: after output events settle, query list-panes
        // to refresh pane_current_command (e.g., when a program exits and the
        // shell takes over, the group tab label should update promptly).
        let mut metadata_sync_at: Option<tokio::time::Instant> = None;
        let metadata_sync_delay = Duration::from_millis(500);

        // Layout change debounce: coalesce rapid %layout-change events
        // (e.g., zoom-out fires 6+ layout changes in quick succession).
        // First layout event emits immediately; subsequent ones within
        // the debounce window are deferred until events settle.
        let mut pending_layout_emit = false;
        let layout_debounce = Duration::from_millis(16);

        // Command-aware settling state
        // When a compound command (containing ";") is sent, we wait for the first
        // window/layout event, then debounce until events settle before emitting
        // a single consolidated state update.
        let mut settling_until: Option<tokio::time::Instant> = None;
        let mut settling_started: Option<tokio::time::Instant> = None;
        // Whether we're waiting for the first event from a compound command.
        // After sending a compound command, we suppress window emissions but
        // don't start the timer until the first window event arrives.
        let mut settling_awaiting_first_event = false;
        let settling_debounce = Duration::from_millis(100);
        let settling_max = Duration::from_millis(500);
        // Safety timeout: if no events arrive within this time after sending
        // a compound command, clear the settling state
        let _settling_await_timeout = Duration::from_millis(2000);

        loop {
            // Calculate throttle timeout.
            // High throughput: rate-limit at throttle_interval (e.g. 32ms).
            // Low throughput: trailing-edge debounce — fire only when no new
            // %output events arrive for `low_throughput_debounce`, capped by
            // `pending_output_max` so a steady drip still emits. This is what
            // prevents Ink-based TUIs (Gemini CLI) from rendering the cleared
            // intermediate state when they do ESC[2J + cursor home + redraw
            // across multiple %output events.
            let throttle_sleep = if pending_output_emit && throttle_enabled {
                if in_throttle_mode {
                    let elapsed = last_output_emit.elapsed();
                    if elapsed >= self.config.throttle_interval {
                        Duration::ZERO
                    } else {
                        self.config.throttle_interval - elapsed
                    }
                } else {
                    let now = Instant::now();
                    let since_last_event = last_output_event_at
                        .map(|t| now.duration_since(t))
                        .unwrap_or(Duration::ZERO);
                    let since_first_pending = pending_output_first_at
                        .map(|t| now.duration_since(t))
                        .unwrap_or(Duration::ZERO);
                    let remaining_debounce =
                        low_throughput_debounce.saturating_sub(since_last_event);
                    let remaining_max = pending_output_max.saturating_sub(since_first_pending);
                    remaining_debounce.min(remaining_max)
                }
            } else {
                Duration::from_secs(3600) // Effectively infinite
            };

            tokio::select! {
                // Process control mode events
                event = self.connection.recv() => {
                    match event {
                        Some(ControlModeEvent::Exit { reason }) => {
                            let msg = reason.unwrap_or_else(|| "disconnected".to_string());
                            warn!(reason = %msg, "control mode exit event");
                            emitter.emit_error(format!("Control mode exited: {}", msg));
                            break;
                        }
                        Some(event) => {
                            // Track last event time for idle-based heartbeat
                            last_event_at = tokio::time::Instant::now();

                            // Guard: suppress %session-changed events for other
                            // sessions. Creating a new tmux session (even from a
                            // separate process) fires %session-changed on ALL control
                            // mode clients. Suppress these to prevent the aggregator
                            // from updating session_name and emitting cross-session state.
                            if let ControlModeEvent::SessionChanged { ref session_name, .. } = event {
                                if !self.config.session.is_empty() && *session_name != self.config.session {
                                    debug!(
                                        actual = %session_name,
                                        expected = %self.config.session,
                                        "suppressing SessionChanged for foreign session"
                                    );
                                    continue;
                                }
                            }

                            // Detect events that need follow-up commands.
                            // UnlinkedWindowAdd must also trigger refresh because break-pane
                            // (used as new-window workaround for tmux 3.5a) emits
                            // %unlinked-window-add for windows created in the current session.
                            // The list-windows response will include the window if it belongs
                            // to our session, and ignore it otherwise.
                            let is_window_add = matches!(
                                &event,
                                ControlModeEvent::WindowAdd { .. }
                                    | ControlModeEvent::UnlinkedWindowAdd { .. }
                            );

                            // Log structural events (skip high-frequency %output)
                            match &event {
                                ControlModeEvent::Output { .. } | ControlModeEvent::CommandResponse { .. } => {}
                                other => {
                                    trace!(event = ?other, "control mode event");
                                }
                            }

                            let result = self.aggregator.process_event(event);

                            // Forward newly decoded images to the emitter for HTTP retrieval
                            for (pane_id, images) in &result.new_images {
                                if !images.is_empty() {
                                    emitter.store_images(pane_id, images.clone());
                                }
                            }

                            // Forward OSC 52 clipboard writes so the frontend can mirror
                            // them into the system clipboard via navigator.clipboard.
                            for (pane_id, text) in result.clipboard_writes.iter().cloned() {
                                emitter.write_clipboard(&pane_id, text);
                            }

                            // Auto-adopt every untagged window we see. Idempotent —
                            // collect_window_tag_commands skips windows that already
                            // have @tmuxy-window-type set AND eagerly mutates the
                            // local WindowState so subsequent emissions don't show a
                            // foreign-window flicker while the set-option round-trip
                            // is in flight. Tracks `window_tags_migrated` only as a
                            // log-noise gate so we don't print the message every tick.
                            let tag_cmds = self.aggregator.collect_window_tag_commands();
                            if !tag_cmds.is_empty() {
                                if !self.window_tags_migrated {
                                    info!(count = tag_cmds.len(), "auto-adopting untagged windows");
                                    self.window_tags_migrated = true;
                                }
                                if let Err(e) = self.connection.send_commands_batch(&tag_cmds).await {
                                    emitter.emit_error(format!("Failed to auto-adopt windows: {}", e));
                                }
                            }

                            // After WindowAdd, refresh panes first then windows.
                            // When break-pane creates a float window, LayoutChange on the
                            // source window removes the pane from self.panes via reconciliation.
                            // No LayoutChange fires for the new float window, so list-panes
                            // must be sent first to restore the pane before list-windows
                            // triggers state emission (where buildFloatPanesFromWindows runs).
                            if is_window_add {
                                let cmds = vec![
                                    concat!(
                                        "list-panes -s -F '",
                                        "#{pane_id},#{pane_index},",
                                        "#{pane_left},#{pane_top},",
                                        "#{pane_width},#{pane_height},",
                                        "#{cursor_x},#{cursor_y},",
                                        "#{pane_active},#{pane_current_command},#{pane_title},",
                                        "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                                        "#{scroll_position},",
                                        "#{window_id},#{T:pane-border-format},",
                                        "#{alternate_on},#{mouse_any_flag},",
                                        "#{selection_present},",
                                        "#{selection_start_x},#{selection_start_y},#{history_size}'"
                                    ).to_string(),
                                    "list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active},#{@tmuxy-window-type},#{@tmuxy-float-parent},#{@tmuxy-float-width},#{@tmuxy-float-height},#{@tmuxy-float-drawer},#{@tmuxy-float-bg},#{@tmuxy-float-noheader},#{@tmuxy-group-panes}'".to_string(),
                                ];
                                if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                                    emitter.emit_error(format!("Failed to refresh state after window add: {}", e));
                                }
                            }

                            // Request content refresh for resized panes (batched for efficiency)
                            if !result.panes_needing_refresh.is_empty() {
                                // Send list-panes FIRST to get updated cursor positions.
                                // After a layout change, tmux adjusts cursor positions for
                                // reflowed content but our tmux_cursor_x/y still holds stale
                                // pre-resize values. The list-panes response will update them
                                // before capture-pane responses arrive (tmux processes commands
                                // in order), so the cursor repositioning after capture uses
                                // the correct coordinates.
                                // Queue pane IDs first (before sending commands)
                                // so they're ready when responses arrive.
                                // Only queue panes that don't already have pending captures —
                                // this prevents the queue from growing unboundedly during rapid
                                // resize/layout changes and keeps queue entries in sync with
                                // the capture commands actually sent.
                                let queued_panes = if self.pending_resize_count > 0 && matches!(result.change_type, super::ChangeType::PaneLayout) {
                                    self.pending_resize_count -= 1;
                                    self.aggregator.queue_resize_captures(&result.panes_needing_refresh)
                                } else {
                                    self.aggregator.queue_captures(&result.panes_needing_refresh)
                                };

                                let mut commands: Vec<String> = vec![
                                    concat!(
                                        "list-panes -s -F '",
                                        "#{pane_id},#{pane_index},",
                                        "#{pane_left},#{pane_top},",
                                        "#{pane_width},#{pane_height},",
                                        "#{cursor_x},#{cursor_y},",
                                        "#{pane_active},#{pane_current_command},#{pane_title},",
                                        "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                                        "#{scroll_position},",
                                        "#{window_id},#{T:pane-border-format},",
                                        "#{alternate_on},#{mouse_any_flag},",
                                        "#{selection_present},",
                                        "#{selection_start_x},#{selection_start_y},#{history_size}'"
                                    ).to_string(),
                                ];
                                // Only send capture commands for panes that were actually queued
                                commands.extend(
                                    queued_panes
                                        .iter()
                                        .map(|pane_id| format!("capture-pane -t {} -p -e", pane_id))
                                );

                                // Send all commands with single flush
                                if let Err(e) = self.connection.send_commands_batch(&commands).await {
                                    emitter.emit_error(format!("Failed to batch capture panes: {}", e));
                                }
                            }

                            // Handle flow control: send continue after pause
                            // This resumes output for the paused pane after we've processed the backlog
                            if let ChangeType::FlowPause { ref pane_id } = result.change_type {
                                // Small delay to let the UI process the pause notification,
                                // then immediately resume output
                                let continue_cmd = format!("refresh-client -A '{}:continue'", pane_id);
                                if let Err(e) = self.connection.send_command(&continue_cmd).await {
                                    emitter.emit_error(format!("Failed to resume pane {}: {}", pane_id, e));
                                }
                            }

                            // During settling: manage debounce timer on window/layout events
                            if settling_until.is_some() {
                                let is_window_event = matches!(
                                    result.change_type,
                                    ChangeType::Window | ChangeType::PaneLayout | ChangeType::PaneFocus
                                );
                                if is_window_event {
                                    let now = tokio::time::Instant::now();
                                    if settling_awaiting_first_event {
                                        // First window event after compound command — start real timer
                                        settling_awaiting_first_event = false;
                                        settling_started = Some(now);
                                        debug!("settling: first event received, starting debounce timer");
                                    }
                                    let max_deadline = settling_started.unwrap() + settling_max;
                                    let debounced = now + settling_debounce;
                                    // Extend but don't exceed the safety timeout
                                    settling_until = Some(debounced.min(max_deadline));
                                }
                            }

                            if result.state_changed {
                                // Adaptive throttling for output events:
                                // - Track event rate in a sliding window
                                // - Low throughput (typing): emit immediately
                                // - High throughput (cat large_file): throttle at 16ms
                                let is_output_event = matches!(result.change_type, ChangeType::PaneOutput { .. });

                                // Schedule deferred metadata sync on output events
                                // to refresh pane_current_command after programs exit
                                if is_output_event {
                                    metadata_sync_at = Some(tokio::time::Instant::now() + metadata_sync_delay);
                                }

                                if is_output_event && throttle_enabled {
                                    // Update rate tracking
                                    let now = Instant::now();
                                    if now.duration_since(rate_window_start) > self.config.rate_window {
                                        // Reset window — apply hysteresis on exit
                                        let exit_threshold = self.config.throttle_threshold / 2;
                                        if in_throttle_mode && rate_event_count <= exit_threshold {
                                            in_throttle_mode = false;
                                        } else if !in_throttle_mode && rate_event_count > self.config.throttle_threshold {
                                            in_throttle_mode = true;
                                        }
                                        rate_window_start = now;
                                        rate_event_count = 1;
                                    } else {
                                        rate_event_count += 1;
                                        // Enter throttle mode immediately when threshold exceeded
                                        if !in_throttle_mode && rate_event_count > self.config.throttle_threshold {
                                            in_throttle_mode = true;
                                        }
                                    }

                                    if in_throttle_mode {
                                        // High throughput: throttle at 16ms interval
                                        pending_output_emit = true;
                                        if last_output_emit.elapsed() >= self.config.throttle_interval {
                                            if let Some(update) = self.aggregator.to_state_update() {
                                                emitter.emit_state(update);
                                            }
                                            last_output_emit = Instant::now();
                                            pending_output_emit = false;
                                            pending_output_first_at = None;
                                            last_output_event_at = None;
                                        }
                                    } else {
                                        // Low throughput: trailing-edge debounce.
                                        // Reset last_output_event_at on every event so a
                                        // burst (clear + redraw) coalesces into one emit.
                                        let now = Instant::now();
                                        if pending_output_first_at.is_none() {
                                            pending_output_first_at = Some(now);
                                        }
                                        last_output_event_at = Some(now);
                                        pending_output_emit = true;
                                    }
                                } else if matches!(result.change_type, ChangeType::PaneLayout) {
                                    // Layout changes (e.g., zoom-out) can fire in rapid
                                    // succession. Debounce to emit only the final state.
                                    pending_layout_emit = true;
                                } else {
                                    // Non-output, non-layout changes always emit immediately
                                    if let Some(update) = self.aggregator.to_state_update() {
                                        emitter.emit_state(update);
                                    }
                                    last_output_emit = Instant::now();
                                    pending_output_emit = false;
                                    pending_output_first_at = None;
                                    last_output_event_at = None;
                                    pending_layout_emit = false;
                                }
                            }
                        }
                        None => {
                            warn!("control mode recv() returned None - connection closed");
                            emitter.emit_error("Control mode connection closed".to_string());
                            break;
                        }
                    }
                }

                // Throttle timer - emit pending output when in high-throughput mode
                _ = tokio::time::sleep(throttle_sleep), if pending_output_emit => {
                    if let Some(update) = self.aggregator.to_state_update() {
                        emitter.emit_state(update);
                    }
                    last_output_emit = Instant::now();
                    pending_output_emit = false;
                    pending_output_first_at = None;
                    last_output_event_at = None;
                }

                // Layout debounce timer - coalesce rapid layout changes (zoom-out)
                _ = tokio::time::sleep(layout_debounce), if pending_layout_emit => {
                    if let Some(update) = self.aggregator.to_state_update() {
                        emitter.emit_state(update);
                    }
                    last_output_emit = Instant::now();
                    pending_layout_emit = false;
                }

                // Settling timer - emit consolidated state after compound command events settle
                _ = tokio::time::sleep_until(settling_until.unwrap_or(tokio::time::Instant::now() + Duration::from_secs(3600))), if settling_until.is_some() => {
                    if settling_awaiting_first_event {
                        // Safety timeout: no window events arrived after compound command
                        // Clear settling and let future events through normally
                        warn!("settling: safety timeout, no events received from compound command");
                        self.aggregator.set_suppress_window_emissions(false);
                    } else {
                        let window_count = self.aggregator.window_count();
                        debug!(windows = window_count, "settling complete, emitting consolidated state");
                        match self.aggregator.force_emit() {
                            Some(update) => {
                                emitter.emit_state(update);
                                trace!("settling: emitted state update");
                            }
                            None => {
                                trace!("settling: force_emit returned None (no delta vs prev_state)");
                            }
                        }
                    }
                    settling_until = None;
                    settling_started = None;
                    settling_awaiting_first_event = false;
                }

                // Deferred metadata sync: refresh pane commands after output settles
                _ = tokio::time::sleep_until(metadata_sync_at.unwrap_or(tokio::time::Instant::now() + Duration::from_secs(3600))), if metadata_sync_at.is_some() => {
                    metadata_sync_at = None;
                    let cmd = concat!(
                        "list-panes -s -F '",
                        "#{pane_id},#{pane_index},",
                        "#{pane_left},#{pane_top},",
                        "#{pane_width},#{pane_height},",
                        "#{cursor_x},#{cursor_y},",
                        "#{pane_active},#{pane_current_command},#{pane_title},",
                        "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                        "#{scroll_position},",
                        "#{window_id},#{T:pane-border-format},",
                        "#{alternate_on},#{mouse_any_flag},",
                        "#{selection_present},",
                        "#{selection_start_x},#{selection_start_y},#{history_size}'"
                    );
                    if let Err(e) = self.connection.send_command(cmd).await {
                        emitter.emit_error(format!("Failed to sync metadata: {}", e));
                    }
                }

                // Event-driven sync: fast polling in copy mode, heartbeat when idle
                _ = tokio::time::sleep_until(next_sync_at) => {
                    let in_copy_mode = self.aggregator.has_pane_in_copy_mode();
                    let is_idle = last_event_at.elapsed() > idle_threshold;

                    // Copy mode: fast poll for cursor position
                    if in_copy_mode {
                        let copy_pane_info = self.aggregator.get_copy_mode_pane_info();
                        let copy_pane_ids: Vec<String> = copy_pane_info.iter().map(|(id, _, _)| id.clone()).collect();
                        let mut cmds = vec![
                            concat!(
                                "list-panes -s -F '",
                                "#{pane_id},#{pane_index},",
                                "#{pane_left},#{pane_top},",
                                "#{pane_width},#{pane_height},",
                                "#{cursor_x},#{cursor_y},",
                                "#{pane_active},#{pane_current_command},#{pane_title},",
                                "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                                "#{scroll_position},",
                                "#{window_id},#{T:pane-border-format},",
                                "#{alternate_on},#{mouse_any_flag},",
                                "#{selection_present},",
                                "#{selection_start_x},#{selection_start_y},#{history_size}'"
                            ).to_string(),
                        ];
                        // Capture content for each pane in copy mode with scroll offset
                        for (pane_id, scroll_pos, height) in &copy_pane_info {
                            if *scroll_pos > 0 {
                                let start = -(*scroll_pos as i64) - (*height as i64) + 1;
                                let end = -(*scroll_pos as i64);
                                cmds.push(format!("capture-pane -t {} -p -e -S {} -E {}", pane_id, start, end));
                            } else {
                                cmds.push(format!("capture-pane -t {} -p -e", pane_id));
                            }
                        }
                        let _ = self.aggregator.queue_captures(&copy_pane_ids);
                        if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                            emitter.emit_error(format!("Failed to sync copy mode: {}", e));
                        }
                        next_sync_at = tokio::time::Instant::now() + copy_mode_sync_interval;
                    } else if is_idle {
                        // Heartbeat: full consistency check when no events for 10s
                        // Catches external changes (e.g., someone running `tmux kill-window` from another terminal)
                        let cmds = vec![
                            "list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active},#{@tmuxy-window-type},#{@tmuxy-float-parent},#{@tmuxy-float-width},#{@tmuxy-float-height},#{@tmuxy-float-drawer},#{@tmuxy-float-bg},#{@tmuxy-float-noheader},#{@tmuxy-group-panes}'".to_string(),
                            concat!(
                                "list-panes -s -F '",
                                "#{pane_id},#{pane_index},",
                                "#{pane_left},#{pane_top},",
                                "#{pane_width},#{pane_height},",
                                "#{cursor_x},#{cursor_y},",
                                "#{pane_active},#{pane_current_command},#{pane_title},",
                                "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                                "#{scroll_position},",
                                "#{window_id},#{T:pane-border-format},",
                                "#{alternate_on},#{mouse_any_flag},",
                                "#{selection_present},",
                                "#{selection_start_x},#{selection_start_y},#{history_size}'"
                            ).to_string(),
                        ];
                        if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                            emitter.emit_error(format!("Failed to heartbeat sync: {}", e));
                        }
                        next_sync_at = tokio::time::Instant::now() + heartbeat_interval;
                    } else {
                        // Not idle, not in copy mode: schedule next check at idle threshold
                        let time_until_idle = idle_threshold.saturating_sub(last_event_at.elapsed());
                        next_sync_at = tokio::time::Instant::now() + time_until_idle;
                    }
                }

                // Handle external commands (resize, etc.)
                cmd = self.command_rx.recv() => {
                    trace!(?cmd, "received monitor command");
                    match cmd {
                        Some(MonitorCommand::ResizeWindow { cols, rows }) => {
                            debug!(cols, rows, "processing ResizeWindow");
                            // Resize ALL windows in the session. With window-size manual,
                            // each window tracks its own size independently. Without
                            // resizing all windows, pre-existing or background windows
                            // retain their old dimensions and don't fill the viewport.
                            let window_ids = self.aggregator.window_ids();
                            if window_ids.is_empty() {
                                // No windows known yet (initial sync), resize current window
                                let resize_cmd = format!("resizew -x {} -y {}", cols, rows);
                                if let Err(e) = self.connection.send_command(&resize_cmd).await {
                                    emitter.emit_error(format!("Failed to resize window: {}", e));
                                } else {
                                    self.pending_resize_count += 1;
                                    trace!(cmd = %resize_cmd, "sent resize command");
                                }
                            } else {
                                let cmds: Vec<String> = window_ids.iter()
                                    .map(|wid| format!("resizew -t {} -x {} -y {}", wid, cols, rows))
                                    .collect();
                                debug!(count = cmds.len(), "resizing windows");
                                if let Err(e) = self.connection.send_commands_batch(&cmds).await {
                                    emitter.emit_error(format!("Failed to resize windows: {}", e));
                                } else {
                                    self.pending_resize_count += 1;
                                }
                            }
                        }
                        Some(MonitorCommand::RunCommand { command }) => {
                            debug!(%command, "processing RunCommand");
                            // Control mode expects raw tmux commands without shell escaping
                            // Frontend sends \; for shell compatibility, convert to ; for control mode
                            let unescaped = command.replace(" \\; ", " ; ");

                            // run-shell scripts that do multiple tmux mutations in
                            // sequence (pane-group-add, pane-group-close, etc.)
                            // produce intermediate window/layout events the frontend
                            // would render as a brief split before settling on the
                            // group layout. Activate the aggregator's settling
                            // mechanism so window emissions stay suppressed until
                            // the script finishes and the consolidated state can
                            // be emitted in one pass.
                            let is_compound = is_multi_step_run_shell(&unescaped);
                            if is_compound {
                                let now = tokio::time::Instant::now();
                                settling_started = Some(now);
                                settling_awaiting_first_event = true;
                                settling_until = Some(now + settling_max);
                                self.aggregator.set_suppress_window_emissions(true);
                                debug!("settling armed for multi-step run-shell");
                            }

                            if let Err(e) = self.connection.send_command(&unescaped).await {
                                emitter.emit_error(format!("Failed to run command: {}", e));
                                // Clear settling on error
                                if is_compound {
                                    settling_until = None;
                                    settling_started = None;
                                    settling_awaiting_first_event = false;
                                    self.aggregator.set_suppress_window_emissions(false);
                                }
                            } else {
                                trace!(cmd = %unescaped, "sent command via control mode");
                            }
                        }
                        Some(MonitorCommand::Shutdown) => {
                            info!("received shutdown command, gracefully closing");
                            self.connection.graceful_close().await;
                            break;
                        }
                        None => {
                            // Command channel closed, stop monitoring
                            warn!("command channel closed, stopping");
                            break;
                        }
                    }
                }
            }
        }
        info!("run() exiting");
    }

    /// Send a tmux command through control mode.
    ///
    /// Returns the command number for tracking the response.
    pub async fn send_command(&mut self, cmd: &str) -> Result<u32, String> {
        self.connection.send_command(cmd).await
    }

    /// Get current state without waiting for events.
    pub fn current_state(&mut self) -> TmuxState {
        self.aggregator.to_tmux_state()
    }

    /// Check if the connection is still alive.
    pub fn is_alive(&mut self) -> bool {
        self.connection.is_alive()
    }

    /// Kill the monitor connection.
    pub async fn kill(&mut self) -> Result<(), String> {
        self.connection.kill().await
    }

    /// Get the configuration.
    pub fn config(&self) -> &MonitorConfig {
        &self.config
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
}
