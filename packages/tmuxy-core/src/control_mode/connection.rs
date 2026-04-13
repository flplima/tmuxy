//! Connection manager for tmux control mode
//!
//! Handles spawning the `tmux -CC` process and communicating with it.

use super::parser::{ControlModeEvent, Parser};
use crate::session;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

/// Global mutex to serialize tmux session creation and control mode attachment.
/// Prevents concurrent `new-session -d` + CC attach operations that crash tmux 3.5a.
static SESSION_CREATION_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

/// Acquire the session creation lock.
/// Hold this across the entire connect/new_session + CC attachment sequence.
pub async fn session_creation_lock() -> tokio::sync::MutexGuard<'static, ()> {
    SESSION_CREATION_LOCK.lock().await
}

/// Default initial PTY size (cols x rows) for the `script` wrapper.
/// Large enough to avoid tiny panes that crash vt100, but will be resized
/// by the browser once it connects and sends its viewport dimensions.
pub const INITIAL_PTY_COLS: u32 = 200;
pub const INITIAL_PTY_ROWS: u32 = 50;

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

/// Spawn the stdout parser task that reads raw bytes, converts to UTF-8 lossily,
/// and feeds parsed events into the channel.
///
/// Uses `read_until(b'\n')` instead of `lines()` to avoid failing on non-UTF-8
/// bytes that the `script` PTY wrapper may introduce into the stream.
///
/// Signals readiness via `ready_tx` after the first successfully parsed event,
/// ensuring the caller knows the tmux control mode connection is alive.
fn spawn_parser_task(
    stdout: tokio::process::ChildStdout,
    tx: mpsc::Sender<ControlModeEvent>,
    ready_tx: tokio::sync::oneshot::Sender<()>,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut parser = Parser::new();
        let mut buf = Vec::with_capacity(4096);
        let mut ready_tx = Some(ready_tx);

        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => {
                    // EOF - tmux process exited
                    break;
                }
                Ok(_) => {
                    // Strip trailing \n and \r
                    while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                        buf.pop();
                    }

                    // Convert to string lossily (replaces invalid UTF-8 with U+FFFD)
                    let line = String::from_utf8_lossy(&buf);

                    if let Some(event) = parser.parse_line(&line) {
                        // Signal readiness on first parsed event
                        if let Some(rtx) = ready_tx.take() {
                            let _ = rtx.send(());
                        }
                        if tx.send(event).await.is_err() {
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[tmuxy] parser task: read error: {}", e);
                    break;
                }
            }
        }
    });
}

impl ControlModeConnection {
    /// Connect to a tmux session in control mode.
    ///
    /// This spawns `tmux -CC attach-session -t <session>` wrapped in `script`
    /// to provide a PTY (required for tmux control mode).
    pub async fn connect(
        session_name: &str,
        working_dir: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        // First check if the session exists to avoid spawning control mode processes
        // that wait indefinitely for a non-existent session. This prevents a race condition
        // in tmux 3.3a where multiple waiting control mode clients crash the server.
        let check = crate::session::tmux_command()
            .args(["has-session", "-t", session_name])
            .output()
            .map_err(|e| format!("Failed to check session: {}", e))?;

        if !check.status.success() {
            return Err(format!("Session '{}' does not exist", session_name));
        }

        // Use `script` to provide a PTY for tmux -CC
        // Without a PTY, tmux fails with "tcgetattr failed: Inappropriate ioctl for device"
        // Set PTY size via stty before starting tmux to avoid tiny default dimensions
        // when running in a background process (e.g., pm2) with no real terminal.
        //
        // macOS BSD `script` and Linux GNU `script` have different syntax:
        //   Linux: script -q /dev/null -c "command"
        //   macOS: script -q /dev/null bash -c "command"
        let tmux_bin = crate::session::tmux_bin();
        let tmux_cmd = format!(
            "stty cols {} rows {} 2>/dev/null; {} -CC attach-session -t {}",
            INITIAL_PTY_COLS, INITIAL_PTY_ROWS, tmux_bin, session_name
        );
        let mut cmd = Command::new("script");
        if cfg!(target_os = "macos") {
            cmd.args(["-q", "/dev/null", "bash", "-c", &tmux_cmd]);
        } else {
            cmd.args(["-q", "/dev/null", "-c", &tmux_cmd]);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = working_dir {
            cmd.current_dir(dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start tmux control mode: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin handle")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout handle")?;

        let (tx, rx) = mpsc::channel(1000);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        spawn_parser_task(stdout, tx, ready_tx);

        // Wait for the parser to receive the first event from tmux, confirming
        // the control mode connection is alive. Without this gate, the caller
        // may start sending commands before tmux has initialized, or worse,
        // not notice that the script/tmux process exited immediately.
        match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
            Ok(Ok(())) => {} // Parser received first event
            Ok(Err(_)) => {
                // ready_tx was dropped without sending — parser hit EOF immediately
                let _ = child.kill().await;
                return Err(format!(
                    "Control mode connection died immediately for session '{}'",
                    session_name
                ));
            }
            Err(_) => {
                // Timeout waiting for first event
                let _ = child.kill().await;
                return Err(format!(
                    "Control mode connection timed out waiting for first event for session '{}'",
                    session_name
                ));
            }
        }

        Ok(Self {
            child,
            stdin,
            event_rx: rx,
            command_counter: 0,
        })
    }

    /// Create a new control mode session.
    ///
    /// First creates the session via regular `tmux new-session -d`, then
    /// attaches in control mode via `connect()`. This two-step approach
    /// avoids a tmux 3.5a bug where `tmux -CC new-session` crashes the
    /// server when another control mode client is already attached.
    pub async fn new_session(
        session_name: &str,
        working_dir: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        // Step 1: Create the session as a detached regular session.
        // WARNING: On tmux 3.5a, this crashes the server if another CC client
        // is attached. The server (sse.rs) routes creation through an existing
        // CC client when possible. This path is the fallback when no CC client
        // is running (e.g., first session creation).
        let mut create_cmd = session::tmux_command();
        if let Some(ref config_path) = session::get_config_path() {
            let config = config_path.to_string_lossy();
            create_cmd.args(["-f", config.as_ref()]);
        }
        create_cmd.args([
            "new-session",
            "-d",
            "-s",
            session_name,
            "-x",
            &INITIAL_PTY_COLS.to_string(),
            "-y",
            &INITIAL_PTY_ROWS.to_string(),
        ]);
        if let Some(dir) = working_dir {
            create_cmd.arg("-c").arg(dir);
        }
        let output = create_cmd
            .output()
            .map_err(|e| format!("Failed to create tmux session: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Failed to create tmux session '{}': {}",
                session_name,
                stderr.trim()
            ));
        }

        // Step 2: Attach in control mode
        Self::connect(session_name, working_dir).await
    }

    /// Send a tmux command through control mode.
    ///
    /// Commands are sent as plain text followed by newline.
    /// The response will come as a `CommandResponse` event.
    /// Returns the command number that tmux will use in the response.
    pub async fn send_command(&mut self, cmd: &str) -> Result<u32, String> {
        // Note: tmux command numbers start at 0, and we track them in sync.
        // We capture the current counter value BEFORE incrementing so it matches
        // what tmux will report in the %begin/%end response.
        let cmd_num = self.command_counter;
        self.command_counter += 1;

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

    /// Send multiple tmux commands in a batch with a single flush.
    ///
    /// More efficient than calling send_command multiple times because
    /// it reduces system calls by batching writes and flushing once.
    /// Returns the command number of the first command (what tmux will report).
    pub async fn send_commands_batch(&mut self, commands: &[String]) -> Result<u32, String> {
        if commands.is_empty() {
            return Ok(self.command_counter);
        }

        // Capture first command number BEFORE incrementing (to match tmux's numbering)
        let first_cmd_num = self.command_counter;

        // Write all commands without flushing
        for cmd in commands {
            self.stdin
                .write_all(format!("{}\n", cmd).as_bytes())
                .await
                .map_err(|e| format!("Failed to send command: {}", e))?;
            self.command_counter += 1;
        }

        // Single flush for all commands
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        Ok(first_cmd_num)
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
            Ok(None) => true, // Still running
            _ => false,       // Exited or error
        }
    }

    /// Kill the control mode connection.
    pub async fn kill(&mut self) -> Result<(), String> {
        self.child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill tmux control mode: {}", e))
    }

    /// Gracefully close the control mode connection.
    ///
    /// Sends a detach-client command to cleanly disconnect from the session,
    /// then waits for the connection to close. Never sends SIGKILL — tmux 3.5a
    /// crashes if the control mode client is killed abruptly.
    pub async fn graceful_close(&mut self) {
        // Send detach-client to cleanly disconnect
        // Ignore errors - the connection might already be closing
        let _ = self.send_command("detach-client").await;

        // Wait for the process to exit (up to 3s).
        // detach-client should cause an almost-immediate exit, but give plenty
        // of time for slow systems. Never fall back to SIGKILL — that crashes
        // tmux 3.5a.
        let timeout = tokio::time::Duration::from_millis(3000);
        match tokio::time::timeout(timeout, self.child.wait()).await {
            Ok(Ok(_)) => {
                eprintln!("[control_mode] Graceful detach successful");
            }
            Ok(Err(e)) => {
                eprintln!("[control_mode] Error waiting for exit: {}", e);
            }
            Err(_) => {
                // Timeout — do NOT kill. The process will be reaped eventually
                // or cleaned up when the server process exits.
                eprintln!("[control_mode] Graceful detach timed out (process may linger)");
            }
        }
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
