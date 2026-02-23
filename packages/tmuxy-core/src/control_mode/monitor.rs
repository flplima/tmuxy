//! TmuxMonitor - High-level API with adapter pattern
//!
//! This module provides the main interface for tmux control mode monitoring.
//! It uses an adapter pattern (like the frontend) to support different backends:
//! - WebSocket (web-server)
//! - Tauri events (tauri-app)

use super::connection::{ControlModeConnection, INITIAL_PTY_COLS, INITIAL_PTY_ROWS};
use super::parser::ControlModeEvent;
use super::state::{ChangeType, StateAggregator};
use crate::{StateUpdate, TmuxState};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

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
/// Implement this trait in web-server (WebSocketEmitter) and tauri-app (TauriEmitter)
/// to receive state updates from the monitor.
pub trait StateEmitter: Send + Sync {
    /// Called when tmux state changes (full or delta update)
    fn emit_state(&self, update: StateUpdate);

    /// Called when an error occurs
    fn emit_error(&self, error: String);
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
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            session: String::new(),
            sync_interval: Duration::from_millis(500),
            create_session: false,
            throttle_interval: Duration::from_millis(16), // ~60fps when throttling
            throttle_threshold: 20,                       // >20 events/100ms triggers throttle
            rate_window: Duration::from_millis(100),
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
}

impl TmuxMonitor {
    /// Connect to a tmux session in control mode.
    /// Returns the monitor and a sender for sending commands to it.
    pub async fn connect(config: MonitorConfig) -> Result<(Self, MonitorCommandSender), String> {
        // First try to attach to existing session
        // If that fails and create_session is true, create a new session
        let connection = match ControlModeConnection::connect(&config.session).await {
            Ok(conn) => conn,
            Err(e) if config.create_session && e.contains("does not exist") => {
                // Session doesn't exist, try to create it
                ControlModeConnection::new_session(&config.session).await?
            }
            Err(e) => return Err(e),
        };

        let (command_tx, command_rx) = mpsc::channel(32);

        Ok((
            Self {
                connection,
                aggregator: StateAggregator::new(),
                config,
                command_rx,
            },
            command_tx,
        ))
    }

    /// Synchronize initial state by querying tmux.
    pub async fn sync_initial_state(&mut self) -> Result<(), String> {
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

        // Enable flow control (tmux 3.2+)
        // pause-after=5 means pause output if client is 5+ seconds behind
        // This prevents unbounded memory growth during heavy output
        self.connection
            .send_command("refresh-client -f pause-after=5")
            .await?;

        // Get list of windows (including float window options)
        self.connection
            .send_command("list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active},#{@float_parent},#{@float_width},#{@float_height}'")
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

    /// Run the monitor event loop.
    ///
    /// This is the main loop that processes control mode events and emits state changes.
    /// It runs until the connection is closed or an error occurs.
    pub async fn run<E: StateEmitter>(&mut self, emitter: &E) {
        // Sync initial state
        if let Err(e) = self.sync_initial_state().await {
            emitter.emit_error(format!("Failed to sync initial state: {}", e));
            return;
        }

        // Dynamic sync interval: 500ms normally, 50ms when a pane is in copy mode
        // (copy mode cursor position is only available via list-panes, so faster polling is needed)
        let copy_mode_sync_interval = Duration::from_millis(50);
        let mut last_sync = tokio::time::Instant::now();
        // Initial delay before first sync to let captures complete
        let mut next_sync_at =
            tokio::time::Instant::now() + self.config.sync_interval + Duration::from_secs(1);

        // Adaptive throttling state for output events
        // - First event always emits immediately
        // - Track event rate over 100ms window
        // - If high throughput (>20 events/100ms), throttle at 16ms
        // - Otherwise, emit immediately for low latency typing
        let mut last_output_emit = Instant::now() - self.config.throttle_interval;
        let mut pending_output_emit = false;
        let mut rate_window_start = Instant::now();
        let mut rate_event_count: u32 = 0;
        let throttle_enabled = !self.config.throttle_interval.is_zero();

        loop {
            // Calculate throttle timeout (only used when in high-throughput mode)
            let throttle_sleep = if pending_output_emit && throttle_enabled {
                // Check if we're in high-throughput mode
                let in_throttle_mode = rate_event_count > self.config.throttle_threshold;
                if in_throttle_mode {
                    let elapsed = last_output_emit.elapsed();
                    if elapsed >= self.config.throttle_interval {
                        Duration::ZERO
                    } else {
                        self.config.throttle_interval - elapsed
                    }
                } else {
                    // Low throughput - emit immediately
                    Duration::ZERO
                }
            } else {
                Duration::from_secs(3600) // Effectively infinite
            };

            // eprintln!("[monitor] Entering select!");
            tokio::select! {
                // Process control mode events
                event = self.connection.recv() => {
                    eprintln!("[monitor] recv() returned: {:?}", event.as_ref().map(|e| std::mem::discriminant(e)));
                    match event {
                        Some(ControlModeEvent::Exit { reason }) => {
                            let msg = reason.unwrap_or_else(|| "disconnected".to_string());
                            emitter.emit_error(format!("Control mode exited: {}", msg));
                            break;
                        }
                        Some(event) => {
                            let result = self.aggregator.process_event(event);

                            // Request content refresh for resized panes (batched for efficiency)
                            if !result.panes_needing_refresh.is_empty() {
                                // Build batch of capture-pane commands
                                let commands: Vec<String> = result
                                    .panes_needing_refresh
                                    .iter()
                                    .map(|pane_id| format!("capture-pane -t {} -p -e", pane_id))
                                    .collect();

                                // Queue the pane IDs first (before sending commands)
                                // so they're ready when responses arrive
                                self.aggregator.queue_captures(&result.panes_needing_refresh);

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

                            if result.state_changed {
                                // Adaptive throttling for output events:
                                // - Track event rate in a sliding window
                                // - Low throughput (typing): emit immediately
                                // - High throughput (cat large_file): throttle at 16ms
                                let is_output_event = matches!(result.change_type, ChangeType::PaneOutput { .. });

                                if is_output_event && throttle_enabled {
                                    // Update rate tracking
                                    let now = Instant::now();
                                    if now.duration_since(rate_window_start) > self.config.rate_window {
                                        // Reset window
                                        rate_window_start = now;
                                        rate_event_count = 1;
                                    } else {
                                        rate_event_count += 1;
                                    }

                                    // Determine if we're in high-throughput mode
                                    let in_throttle_mode = rate_event_count > self.config.throttle_threshold;

                                    if in_throttle_mode {
                                        // High throughput: throttle at 16ms interval
                                        pending_output_emit = true;
                                        if last_output_emit.elapsed() >= self.config.throttle_interval {
                                            if let Some(update) = self.aggregator.to_state_update() {
                                                emitter.emit_state(update);
                                            }
                                            last_output_emit = Instant::now();
                                            pending_output_emit = false;
                                        }
                                    } else {
                                        // Low throughput (typing): emit immediately for low latency
                                        if let Some(update) = self.aggregator.to_state_update() {
                                            emitter.emit_state(update);
                                        }
                                        last_output_emit = Instant::now();
                                        pending_output_emit = false;
                                    }
                                } else {
                                    // Non-output changes always emit immediately
                                    if let Some(update) = self.aggregator.to_state_update() {
                                        emitter.emit_state(update);
                                    }
                                    last_output_emit = Instant::now();
                                    pending_output_emit = false;
                                }
                            }
                        }
                        None => {
                            eprintln!("[monitor] Control mode recv() returned None - connection closed");
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
                }

                // Periodic state sync (dynamic interval based on copy mode)
                _ = tokio::time::sleep_until(next_sync_at) => {
                    let in_copy_mode = self.aggregator.has_pane_in_copy_mode();

                    // In copy mode, only query pane info (for cursor position)
                    // to minimize latency. Full sync (with list-windows) runs at normal interval.
                    let sync_commands = if in_copy_mode && last_sync.elapsed() < self.config.sync_interval {
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
                                // Capture the scrolled-back region: -S is start line (negative = from end of history)
                                // -E is end line. We want `height` lines starting from scroll_pos lines back.
                                let start = -(*scroll_pos as i64) - (*height as i64) + 1;
                                let end = -(*scroll_pos as i64);
                                cmds.push(format!("capture-pane -t {} -p -e -S {} -E {}", pane_id, start, end));
                            } else {
                                cmds.push(format!("capture-pane -t {} -p -e", pane_id));
                            }
                        }
                        self.aggregator.queue_captures(&copy_pane_ids);
                        cmds
                    } else {
                        last_sync = tokio::time::Instant::now();
                        vec![
                            "list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active},#{@float_parent},#{@float_width},#{@float_height}'".to_string(),
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
                        ]
                    };

                    if let Err(e) = self.connection.send_commands_batch(&sync_commands).await {
                        emitter.emit_error(format!("Failed to sync state: {}", e));
                    }

                    // Schedule next sync: fast in copy mode, normal otherwise
                    let interval = if in_copy_mode { copy_mode_sync_interval } else { self.config.sync_interval };
                    next_sync_at = tokio::time::Instant::now() + interval;
                }

                // Handle external commands (resize, etc.)
                cmd = self.command_rx.recv() => {
                    eprintln!("[monitor] Received command: {:?}", cmd);
                    match cmd {
                        Some(MonitorCommand::ResizeWindow { cols, rows }) => {
                            eprintln!("[monitor] Processing ResizeWindow: {}x{}", cols, rows);
                            // Resize the active window (window-size manual means only
                            // resize-window changes size, no client size interference)
                            let resize_cmd = format!("resizew -x {} -y {}", cols, rows);
                            if let Err(e) = self.connection.send_command(&resize_cmd).await {
                                emitter.emit_error(format!("Failed to resize window: {}", e));
                            } else {
                                eprintln!("[monitor] Sent resize command: {}", resize_cmd);
                            }
                        }
                        Some(MonitorCommand::RunCommand { command }) => {
                            eprintln!("[monitor] Processing RunCommand: {}", command);
                            // Control mode expects raw tmux commands without shell escaping
                            // Frontend sends \; for shell compatibility, convert to ; for control mode
                            let unescaped = command.replace(" \\; ", " ; ");
                            if let Err(e) = self.connection.send_command(&unescaped).await {
                                emitter.emit_error(format!("Failed to run command: {}", e));
                            } else {
                                eprintln!("[monitor] Sent command via control mode: {}", unescaped);
                            }
                        }
                        Some(MonitorCommand::Shutdown) => {
                            eprintln!("[monitor] Received shutdown command, gracefully closing");
                            self.connection.graceful_close().await;
                            break;
                        }
                        None => {
                            // Command channel closed, stop monitoring
                            eprintln!("[monitor] Command channel closed, stopping");
                            break;
                        }
                    }
                }
            }
        }
        eprintln!("[monitor] run() exiting");
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct TestEmitter {
        updates: Arc<Mutex<Vec<StateUpdate>>>,
        errors: Arc<Mutex<Vec<String>>>,
    }

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
}
