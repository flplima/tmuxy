//! TmuxMonitor - High-level API with adapter pattern
//!
//! This module provides the main interface for tmux control mode monitoring.
//! It uses an adapter pattern (like the frontend) to support different backends:
//! - WebSocket (web-server)
//! - Tauri events (tauri-app)

use super::connection::ControlModeConnection;
use super::parser::ControlModeEvent;
use super::state::StateAggregator;
use crate::TmuxState;
use std::time::Duration;
use tokio::time::interval;

/// Trait for emitting state changes (adapter pattern).
///
/// Implement this trait in web-server (WebSocketEmitter) and tauri-app (TauriEmitter)
/// to receive state updates from the monitor.
pub trait StateEmitter: Send + Sync {
    /// Called when tmux state changes
    fn emit_state(&self, state: TmuxState);

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
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            session: String::new(),
            sync_interval: Duration::from_millis(500),
            create_session: false,
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
                "#{pane_active},#{pane_current_command},",
                "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                "#{window_id}'"
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

        // Periodic sync interval for cursor position updates
        let mut sync_timer = interval(self.config.sync_interval);

        loop {
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

                            // Request content refresh for resized panes
                            for pane_id in &result.panes_needing_refresh {
                                // Queue the pane ID first so we can match the response
                                self.aggregator.queue_capture(pane_id.clone());
                                // Use capture-pane -e to include escape sequences
                                let cmd = format!("capture-pane -t {} -p -e", pane_id);
                                if let Err(e) = self.connection.send_command(&cmd).await {
                                    emitter.emit_error(format!("Failed to capture pane {}: {}", pane_id, e));
                                }
                            }

                            if result.state_changed {
                                let state = self.aggregator.to_tmux_state();
                                emitter.emit_state(state);
                            }
                        }
                        None => {
                            emitter.emit_error("Control mode connection closed".to_string());
                            break;
                        }
                    }
                }

                // Periodic state sync
                _ = sync_timer.tick() => {
                    // Query window info (for window names, needed for stack detection)
                    if let Err(e) = self.connection
                        .send_command("list-windows -F '#{window_id},#{window_index},#{window_name},#{window_active}'")
                        .await
                    {
                        emitter.emit_error(format!("Failed to sync window state: {}", e));
                    }

                    // Query pane info for cursor position (current session only)
                    if let Err(e) = self.connection.send_command(concat!(
                        "list-panes -s -F '",
                        "#{pane_id},#{pane_index},",
                        "#{pane_left},#{pane_top},",
                        "#{pane_width},#{pane_height},",
                        "#{cursor_x},#{cursor_y},",
                        "#{pane_active},#{pane_current_command},",
                        "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
                        "#{window_id}'"
                    )).await {
                        emitter.emit_error(format!("Failed to sync pane state: {}", e));
                    }
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
    pub fn current_state(&self) -> TmuxState {
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

/// Helper function to run the monitor with automatic reconnection.
pub async fn run_with_reconnect<E: StateEmitter>(
    config: MonitorConfig,
    emitter: &E,
    max_retries: u32,
) {
    let mut retries = 0;
    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);

    loop {
        match TmuxMonitor::connect(config.clone()).await {
            Ok(mut monitor) => {
                retries = 0;
                backoff = Duration::from_millis(100);

                monitor.run(emitter).await;

                // If we get here, the connection was closed
                // Continue to reconnect
            }
            Err(e) => {
                emitter.emit_error(format!("Failed to connect: {}", e));
            }
        }

        retries += 1;
        if retries > max_retries {
            emitter.emit_error("Max reconnection attempts reached".to_string());
            break;
        }

        // Exponential backoff
        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct TestEmitter {
        states: Arc<Mutex<Vec<TmuxState>>>,
        errors: Arc<Mutex<Vec<String>>>,
    }

    impl StateEmitter for TestEmitter {
        fn emit_state(&self, state: TmuxState) {
            self.states.lock().unwrap().push(state);
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
