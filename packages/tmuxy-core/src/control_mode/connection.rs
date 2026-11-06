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

fn log_to(sink: Option<&Arc<dyn LogSink>>, kind: LogKind, msg: impl Into<String>) {
    if let Some(s) = sink {
        s.log(kind, msg.into());
    }
}

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

/// Concurrent session creation and control-mode attaches crash tmux 3.5a, so
/// they are serialized.
static SESSION_CREATION_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

/// Acquire the session creation lock.
/// Hold this across the entire connect/new_session + CC attachment sequence.
pub async fn session_creation_lock() -> tokio::sync::MutexGuard<'static, ()> {
    SESSION_CREATION_LOCK.lock().await
}

async fn drain_recent_output(recent: &Arc<Mutex<Vec<String>>>) -> String {
    let guard = recent.lock().await;
    guard.join("\n")
}

/// Initial PTY size. Large enough to avoid tiny panes that crash vt100; the
/// browser sends a real resize once it knows its viewport.
pub const INITIAL_PTY_COLS: u32 = 200;
pub const INITIAL_PTY_ROWS: u32 = 50;

pub struct ControlModeConnection {
    child: Child,

    pty_writer: pty_process::OwnedWritePty,

    event_rx: mpsc::Receiver<ControlModeEvent>,

    /// Bounded buffer of recent raw lines from the PTY master, for error
    /// messages: tmux's stderr comes through the same merged PTY stream.
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

        if !create_if_missing {
            Self::preflight_session(session_name, log)?;
        }

        let (pty, pts) = Self::allocate_pty(log)?;

        // The .app launched from Finder gets a different `PATH` than the same
        // binary in a terminal, so the log shows exactly what was spawned.
        let (tmux_args, shell_desc) =
            build_tmux_args(session_name, create_if_missing, group_target, first_window);
        tracing::info!("connect(): pty spawn: {}", shell_desc);
        log_to(log, LogKind::Command, shell_desc.clone());

        let child = Self::spawn_tmux(&tmux_args, pts, working_dir, &shell_desc, log)?;
        let (pty_reader, pty_writer) = pty.into_split();

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

    /// Append the subprocess's recent output to an io::Error message, so the
    /// user sees *why* the pipe broke, not a bare "Broken pipe (os error 32)".
    async fn enrich_io_error(&self, prefix: &str, e: &std::io::Error) -> TmuxError {
        let stderr = drain_recent_output(&self.recent_output).await;
        let msg = if stderr.is_empty() {
            format!("{}: {}", prefix, e)
        } else {
            format!("{}: {} | subprocess stderr: {}", prefix, e, stderr)
        };
        TmuxError::other(msg)
    }

    /// Send tmux commands through control mode, a line each, with a single
    /// flush.
    ///
    /// Each answer comes back as a `CommandResponse` event. Response
    /// correlation happens via the aggregator's marker lines (`Markers`),
    /// not command numbers, so nothing is returned on success.
    pub async fn send_commands<S: AsRef<str>>(&mut self, commands: &[S]) -> Result<(), TmuxError> {
        if commands.is_empty() {
            return Ok(());
        }
        for cmd in commands {
            one_control_mode_line(cmd.as_ref())?;
        }

        for cmd in commands {
            if let Err(e) = self
                .pty_writer
                .write_all(format!("{}\n", cmd.as_ref()).as_bytes())
                .await
            {
                return Err(self.enrich_io_error("Failed to send command", &e).await);
            }
        }

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
        // The connection might already be closing.
        let _ = self.send_commands(&["detach-client"]).await;

        // detach-client exits almost at once; 3s leaves room for slow systems.
        let timeout = tokio::time::Duration::from_millis(3000);
        match tokio::time::timeout(timeout, self.child.wait()).await {
            Ok(Ok(_)) => {
                info!("graceful detach successful");
            }
            Ok(Err(e)) => {
                error!(error = %e, "error waiting for exit");
            }
            Err(_) => {
                // No kill: the process is reaped later or when the server exits.
                warn!("graceful detach timed out (process may linger)");
            }
        }
    }
}

// Dropping a connection drops the PTY master, which sends SIGHUP to the tmux
// client and detaches it; the child is not `kill_on_drop` (tokio's default).

/// Refuse a write that is not exactly one control-mode line. Control mode
/// reads a command per line: a newline inside one starts a command nobody
/// built (quoting does not stop it), and an empty line detaches the client.
/// A multi-line command is split first (`control_mode_lines`).
fn one_control_mode_line(cmd: &str) -> Result<(), TmuxError> {
    if cmd.contains('\n') || cmd.trim().is_empty() {
        return Err(TmuxError::other(
            "refused to write a control-mode command that is not exactly one line",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
