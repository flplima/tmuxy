//! Connection manager for tmux control mode
//!
//! Handles spawning the `tmux -CC` process and communicating with it.

use super::parser::{ControlModeEvent, Parser};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

/// Connection to tmux control mode
pub struct ControlModeConnection {
    /// The tmux -CC child process
    child: Child,

    /// Stdin for sending commands
    stdin: ChildStdin,

    /// Receiver for parsed events
    event_rx: mpsc::Receiver<ControlModeEvent>,

    /// Command counter for tracking responses
    command_counter: u32,
}

impl ControlModeConnection {
    /// Connect to a tmux session in control mode.
    ///
    /// This spawns `tmux -CC attach-session -t <session>` wrapped in `script`
    /// to provide a PTY (required for tmux control mode).
    pub async fn connect(session_name: &str) -> Result<Self, String> {
        // Use `script` to provide a PTY for tmux -CC
        // Without a PTY, tmux fails with "tcgetattr failed: Inappropriate ioctl for device"
        let tmux_cmd = format!("tmux -CC attach-session -t {}", session_name);
        let mut child = Command::new("script")
            .args(["-q", "/dev/null", "-c", &tmux_cmd])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start tmux control mode: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to get stdin handle")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to get stdout handle")?;

        // Channel for parsed events
        let (tx, rx) = mpsc::channel(1000);

        // Spawn stdout parser task
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let mut parser = Parser::new();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(event) = parser.parse_line(&line) {
                    // If send fails, the receiver is dropped - exit the loop
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            event_rx: rx,
            command_counter: 0,
        })
    }

    /// Create a new control mode session.
    ///
    /// This spawns `tmux -CC new-session -s <session>` wrapped in `script`
    /// to provide a PTY (required for tmux control mode).
    pub async fn new_session(session_name: &str) -> Result<Self, String> {
        // Use `script` to provide a PTY for tmux -CC
        let tmux_cmd = format!("tmux -CC new-session -s {}", session_name);
        let mut child = Command::new("script")
            .args(["-q", "/dev/null", "-c", &tmux_cmd])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start tmux control mode: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to get stdin handle")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to get stdout handle")?;

        let (tx, rx) = mpsc::channel(1000);

        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let mut parser = Parser::new();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(event) = parser.parse_line(&line) {
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            event_rx: rx,
            command_counter: 0,
        })
    }

    /// Send a tmux command through control mode.
    ///
    /// Commands are sent as plain text followed by newline.
    /// The response will come as a `CommandResponse` event.
    pub async fn send_command(&mut self, cmd: &str) -> Result<u32, String> {
        self.command_counter += 1;
        let cmd_num = self.command_counter;

        self.stdin
            .write_all(format!("{}\n", cmd).as_bytes())
            .await
            .map_err(|e| format!("Failed to send command: {}", e))?;

        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        Ok(cmd_num)
    }

    /// Receive the next event from control mode.
    ///
    /// Returns `None` if the connection is closed.
    pub async fn recv(&mut self) -> Option<ControlModeEvent> {
        self.event_rx.recv().await
    }

    /// Try to receive an event without blocking.
    pub fn try_recv(&mut self) -> Option<ControlModeEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Check if the connection is still alive.
    pub fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,  // Still running
            _ => false,        // Exited or error
        }
    }

    /// Kill the control mode connection.
    pub async fn kill(&mut self) -> Result<(), String> {
        self.child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill tmux control mode: {}", e))
    }

    /// Get the current command counter value.
    pub fn command_counter(&self) -> u32 {
        self.command_counter
    }
}

impl Drop for ControlModeConnection {
    fn drop(&mut self) {
        // kill_on_drop is set, so this is handled automatically
    }
}
