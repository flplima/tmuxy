//! TmuxMonitor - High-level API with adapter pattern
//!
//! This module provides the main interface for tmux control mode monitoring.
//! It uses an adapter pattern (like the frontend) to support different backends:
//! - WebSocket (web-server)
//! - Tauri events (tauri-app)

use super::connection::ControlModeConnection;
use super::parser::ControlModeEvent;
use super::state::{ChangeType, StateAggregator};
use crate::{StateUpdate, TmuxState};
use std::time::{Duration, Instant};

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

    /// Minimum interval between output-triggered state emissions (debounce).
    /// Set to 0 to disable debouncing.
    /// Recommended: 16ms (60fps) for smooth but efficient updates.
    pub output_debounce: Duration,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            session: String::new(),
            sync_interval: Duration::from_millis(500),
            create_session: false,
            output_debounce: Duration::from_millis(16), // ~60fps
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
}

impl TmuxMonitor {
    /// Connect to a tmux session in control mode.
    pub async fn connect(config: MonitorConfig) -> Result<Self, String> {
        let connection = if config.create_session {
            ControlModeConnection::new_session(&config.session).await?
        } else {
            ControlModeConnection::connect(&config.session).await?
        };

        Ok(Self {
            connection,
            aggregator: StateAggregator::new(),
            config,
        })
    }

    /// Synchronize initial state by querying tmux.
    pub async fn sync_initial_state(&mut self) -> Result<(), String> {
        // Get list of windows
        self.connection
            .send_command("list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active}'")
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
                "#{window_id},#{T:pane-border-format},",
                "#{alternate_on},#{mouse_any_flag}'"
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
        let mut next_sync_at = tokio::time::Instant::now() + self.config.sync_interval + Duration::from_secs(1);

        // Debouncing state for output events
        let mut last_output_emit = Instant::now() - self.config.output_debounce;
        let mut pending_output_emit = false;
        let debounce_enabled = !self.config.output_debounce.is_zero();

        loop {
            // Calculate debounce timeout
            let debounce_sleep = if pending_output_emit && debounce_enabled {
                let elapsed = last_output_emit.elapsed();
                if elapsed >= self.config.output_debounce {
                    Duration::ZERO
                } else {
                    self.config.output_debounce - elapsed
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

                            if result.state_changed {
                                // Debounce output events, emit others immediately
                                let should_debounce = debounce_enabled
                                    && matches!(result.change_type, ChangeType::PaneOutput { .. });

                                if should_debounce {
                                    // Mark that we have pending output to emit
                                    pending_output_emit = true;

                                    // If enough time has passed, emit now
                                    if last_output_emit.elapsed() >= self.config.output_debounce {
                                        let update = self.aggregator.to_state_update();
                                        emitter.emit_state(update);
                                        last_output_emit = Instant::now();
                                        pending_output_emit = false;
                                    }
                                } else {
                                    // Non-output changes emit immediately
                                    let update = self.aggregator.to_state_update();
                                    emitter.emit_state(update);
                                    last_output_emit = Instant::now();
                                    pending_output_emit = false;
                                }
                            }
                        }
                        None => {
                            emitter.emit_error("Control mode connection closed".to_string());
                            break;
                        }
                    }
                }

                // Debounce timer - emit pending output
                _ = tokio::time::sleep(debounce_sleep), if pending_output_emit => {
                    let update = self.aggregator.to_state_update();
                    emitter.emit_state(update);
                    last_output_emit = Instant::now();
                    pending_output_emit = false;
                }

                // Periodic state sync (dynamic interval based on copy mode)
                _ = tokio::time::sleep_until(next_sync_at) => {
                    let in_copy_mode = self.aggregator.has_pane_in_copy_mode();

                    // In copy mode, only query pane info (for cursor position)
                    // to minimize latency. Full sync (with list-windows) runs at normal interval.
                    let sync_commands = if in_copy_mode && last_sync.elapsed() < self.config.sync_interval {
                        vec![
                            concat!(
                                "list-panes -s -F '",
                                "#{pane_id},#{pane_index},",
                                "#{pane_left},#{pane_top},",
                                "#{pane_width},#{pane_height},",
                                "#{cursor_x},#{cursor_y},",
                                "#{pane_active},#{pane_current_command},#{pane_title},",
                                "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                                "#{window_id},#{T:pane-border-format},",
                                "#{alternate_on},#{mouse_any_flag}'"
                            ).to_string(),
                        ]
                    } else {
                        last_sync = tokio::time::Instant::now();
                        vec![
                            "list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active}'".to_string(),
                            concat!(
                                "list-panes -s -F '",
                                "#{pane_id},#{pane_index},",
                                "#{pane_left},#{pane_top},",
                                "#{pane_width},#{pane_height},",
                                "#{cursor_x},#{cursor_y},",
                                "#{pane_active},#{pane_current_command},#{pane_title},",
                                "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                                "#{window_id},#{T:pane-border-format},",
                                "#{alternate_on},#{mouse_any_flag}'"
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
            }
        }
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
