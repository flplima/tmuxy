//! Connection manager for tmux control mode
//!
//! Handles spawning the `tmux -CC` process and communicating with it.

#[cfg(target_os = "linux")]
mod appimage_env;
mod spawn;

use super::log::{LogKind, LogSink};
use super::parser::{ControlModeEvent, Parser};
use crate::error::TmuxError;
use spawn::{build_tmux_args, spawn_parser_task};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

/// Helper to conditionally emit a log entry to an optional sink.
fn log_to(sink: Option<&Arc<dyn LogSink>>, kind: LogKind, msg: impl Into<String>) {
    if let Some(s) = sink {
        s.log(kind, msg.into());
    }
}

/// Format a `std::process::Output` as a single human-readable line for the log.
fn format_output(out: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    let exit = out
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let mut parts = vec![format!("exit={}", exit)];
    if !stdout.is_empty() {
        parts.push(format!("stdout={}", stdout));
    }
    if !stderr.is_empty() {
        parts.push(format!("stderr={}", stderr));
    }
    parts.join(" ")
}

/// Global mutex to serialize tmux session creation and control mode attachment.
/// Prevents concurrent `new-session -d` + CC attach operations that crash tmux 3.5a.
static SESSION_CREATION_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

/// Acquire the session creation lock.
/// Hold this across the entire connect/new_session + CC attachment sequence.
pub async fn session_creation_lock() -> tokio::sync::MutexGuard<'static, ()> {
    SESSION_CREATION_LOCK.lock().await
}

/// Snapshot the recent-output buffer as a single newline-joined string.
/// Used when send_command/connect fails so the error message can include
/// whatever tmux emitted on its way out.
async fn drain_recent_output(recent: &Arc<Mutex<Vec<String>>>) -> String {
    let guard = recent.lock().await;
    guard.join("\n")
}

/// Default initial PTY size (cols x rows). Large enough to avoid tiny
/// panes that crash vt100; the browser sends a real resize once it connects
/// and reports its viewport dimensions.
pub const INITIAL_PTY_COLS: u32 = 200;
pub const INITIAL_PTY_ROWS: u32 = 50;

/// Connection to tmux control mode
pub struct ControlModeConnection {
    /// The tmux -CC child process
    child: Child,

    /// Write half of the PTY master — sends commands to tmux via the
    /// controlling terminal (mimicking what a user types).
    pty_writer: pty_process::OwnedWritePty,

    /// Receiver for parsed events
    event_rx: mpsc::Receiver<ControlModeEvent>,

    /// Bounded buffer of recent raw lines from the PTY master (parsed or
    /// otherwise). Consulted when send_command fails so the error message
    /// can include whatever tmux said on its way out — e.g. an error
    /// message printed to stderr that came through the merged PTY stream.
    recent_output: Arc<Mutex<Vec<String>>>,
}

impl ControlModeConnection {
    /// Connect to a tmux session in control mode.
    ///
    /// When `create_if_missing` is `false`, this spawns
    /// `tmux -CC attach-session -t <session>` and errors if the session
    /// doesn't exist. When `true`, spawns `tmux -CC new-session -A -s <session>`
    /// instead — atomically creating the session if absent, attaching if
    /// present. `group_target` names a session whose group the new session
    /// joins (`-t`), shared windows with an independent current window; it is
    /// ignored on the attach path and when the session already exists.
    /// The combined form avoids a race we hit on macOS where
    /// `new-session -d` followed by a separate attach lets the server die
    /// in the brief clientless window before our PTY attach lands; the CC
    /// client connects in the same call as the create, so the server is
    /// never client-less.
    ///
    /// Spawn uses pty-process (openpty(3) + setsid + TIOCSCTTY) so tmux
    /// gets a real controlling terminal — required by `-CC` mode.
    ///
    /// `log` receives streaming entries for each tmux invocation and its
    /// output.
    pub async fn connect(
        session_name: &str,
        working_dir: Option<&std::path::Path>,
        log: Option<&Arc<dyn LogSink>>,
        create_if_missing: bool,
        group_target: Option<&str>,
        first_window: Option<&(String, String)>,
    ) -> Result<Self, TmuxError> {
        let tmux_path = crate::session::tmux_path();
        log_to(log, LogKind::Info, format!("tmux binary: {}", tmux_path));

        // Preflight that the session exists when the caller doesn't want
        // create-on-attach behavior. Skipped when `create_if_missing` so
        // `tmux -CC new-session -A` can handle the dual semantics atomically.
        if !create_if_missing {
            Self::preflight_session(session_name, log)?;
        }

        // Allocate the PTY pair we'll feed to tmux. `INITIAL_PTY_ROWS/COLS`
        // are intentionally larger than typical terminal viewports so vt100
        // never crashes on tiny grids; the browser sends a real resize once
        // it knows its viewport size.
        let (pty, pts) = Self::allocate_pty(log)?;

        // Build the `tmux -CC …` argv plus a human-readable description for
        // logs. Description matters because the .app launched from Finder
        // gets a different `PATH` than the same binary in a terminal, so
        // operators need to see exactly what we spawned.
        let (tmux_args, shell_desc) =
            build_tmux_args(session_name, create_if_missing, group_target, first_window);
        tracing::info!("connect(): pty spawn: {}", shell_desc);
        log_to(log, LogKind::Command, shell_desc.clone());

        let child = Self::spawn_tmux(&tmux_args, pts, working_dir, &shell_desc, log)?;
        let (pty_reader, pty_writer) = pty.into_split();

        // Wire up the parser task and gate on the first control-mode event.
        let recent_output: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel(1000);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        spawn_parser_task(pty_reader, tx, ready_tx, recent_output.clone());

        let mut child = child;
        Self::wait_for_initial_state(
            &mut child,
            ready_rx,
            session_name,
            &shell_desc,
            &recent_output,
            log,
        )
        .await?;

        Ok(Self {
            child,
            pty_writer,
            event_rx: rx,
            recent_output,
        })
    }

    /// Send a tmux command through control mode.
    ///
    /// Commands are sent as plain text followed by newline.
    /// The response will come as a `CommandResponse` event. Response
    /// correlation happens via the `TMUXY_CAP_BEGIN`/`END` markers, not
    /// command numbers, so nothing is returned on success.
    pub async fn send_command(&mut self, cmd: &str) -> Result<(), TmuxError> {
        if let Err(e) = self
            .pty_writer
            .write_all(format!("{}\n", cmd).as_bytes())
            .await
        {
            return Err(self.enrich_io_error("Failed to send command", &e).await);
        }

        if let Err(e) = self.pty_writer.flush().await {
            return Err(self.enrich_io_error("Failed to flush stdin", &e).await);
        }

        Ok(())
    }

    /// Append captured subprocess stderr to an io::Error message.
    /// Gives the user concrete evidence of *why* the pipe broke instead of
    /// the generic "Broken pipe (os error 32)".
    async fn enrich_io_error(&self, prefix: &str, e: &std::io::Error) -> TmuxError {
        let stderr = drain_recent_output(&self.recent_output).await;
        let msg = if stderr.is_empty() {
            format!("{}: {}", prefix, e)
        } else {
            format!("{}: {} | subprocess stderr: {}", prefix, e, stderr)
        };
        TmuxError::other(msg)
    }

    /// Send multiple tmux commands in a batch with a single flush.
    ///
    /// More efficient than calling send_command multiple times because
    /// it reduces system calls by batching writes and flushing once.
    pub async fn send_commands_batch(&mut self, commands: &[String]) -> Result<(), TmuxError> {
        if commands.is_empty() {
            return Ok(());
        }

        // Write all commands without flushing
        for cmd in commands {
            if let Err(e) = self
                .pty_writer
                .write_all(format!("{}\n", cmd).as_bytes())
                .await
            {
                return Err(self.enrich_io_error("Failed to send command", &e).await);
            }
        }

        // Single flush for all commands
        if let Err(e) = self.pty_writer.flush().await {
            return Err(self.enrich_io_error("Failed to flush stdin", &e).await);
        }

        Ok(())
    }

    /// Receive the next event from control mode.
    ///
    /// Returns `None` if the connection is closed.
    pub async fn recv(&mut self) -> Option<ControlModeEvent> {
        self.event_rx.recv().await
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
                info!("graceful detach successful");
            }
            Ok(Err(e)) => {
                error!(error = %e, "error waiting for exit");
            }
            Err(_) => {
                // Timeout — do NOT kill. The process will be reaped eventually
                // or cleaned up when the server process exits.
                warn!("graceful detach timed out (process may linger)");
            }
        }
    }
}

// No `Drop` impl: `kill_on_drop` is NOT set on the spawned child (pty-process
// requires an explicit `Command::kill_on_drop(true)`, and tokio defaults to
// false). Cleanup relies on the PTY instead — dropping the master sends SIGHUP
// to the tmux client, which detaches it. `graceful_close` is the intended path
// and deliberately avoids SIGKILL so tmux can detach cleanly.

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
