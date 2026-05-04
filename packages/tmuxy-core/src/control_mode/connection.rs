//! Connection manager for tmux control mode
//!
//! Handles spawning the `tmux -CC` process and communicating with it.

use super::log::{LogKind, LogSink};
use super::parser::{ControlModeEvent, Parser};
use crate::session;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex};

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

    /// Command counter for tracking responses
    command_counter: u32,

    /// Bounded buffer of recent raw lines from the PTY master (parsed or
    /// otherwise). Consulted when send_command fails so the error message
    /// can include whatever tmux said on its way out — e.g. an error
    /// message printed to stderr that came through the merged PTY stream.
    recent_output: Arc<Mutex<Vec<String>>>,
}

/// Spawn the PTY-master parser task. Reads raw bytes from the master end of
/// the pty, converts each line to UTF-8 lossily, parses control-mode events,
/// forwards them to `tx`, and signals readiness via `ready_tx` after the
/// first successfully parsed event.
///
/// Every line — parsed or not — is also pushed into `recent_output`, capped
/// to the last 200 entries, so a later send error can include tmux's final
/// words. With pty-process the child's stdout AND stderr are merged into
/// the same PTY stream, so any error tmux writes on its way out lands here
/// for capture.
fn spawn_parser_task(
    reader: pty_process::OwnedReadPty,
    tx: mpsc::Sender<ControlModeEvent>,
    ready_tx: tokio::sync::oneshot::Sender<()>,
    recent_output: Arc<Mutex<Vec<String>>>,
) {
    tokio::spawn(async move {
        let mut buf_reader = BufReader::new(reader);
        let mut parser = Parser::new();
        let mut buf = Vec::with_capacity(4096);
        let mut ready_tx = Some(ready_tx);

        loop {
            buf.clear();
            match buf_reader.read_until(b'\n', &mut buf).await {
                Ok(0) => {
                    // EOF — tmux process exited (or PTY was closed)
                    break;
                }
                Ok(_) => {
                    while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                        buf.pop();
                    }

                    let line = String::from_utf8_lossy(&buf).to_string();

                    if !line.is_empty() {
                        let mut guard = recent_output.lock().await;
                        guard.push(line.clone());
                        if guard.len() > 200 {
                            let drain_count = guard.len() - 200;
                            guard.drain(0..drain_count);
                        }
                    }

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
    /// Spawns `tmux -CC attach-session -t <session>` directly attached to a
    /// freshly-allocated PTY (via openpty(3) + setsid + TIOCSCTTY). tmux's
    /// `-CC` mode requires a real controlling terminal on stdin; pipes don't
    /// work. We previously wrapped the spawn in `script(1)` for this, but
    /// `script` was unreliable under macOS launchd (no controlling TTY in
    /// the parent) — pty-process makes the spawn portable and robust.
    ///
    /// `log` receives streaming entries for each tmux invocation and its
    /// output. The final `Err(_)` value still summarizes the failure for
    /// callers that don't surface the log.
    pub async fn connect(
        session_name: &str,
        working_dir: Option<&std::path::Path>,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<Self, String> {
        // First check if the session exists to avoid spawning control mode processes
        // that wait indefinitely for a non-existent session. This prevents a race condition
        // in tmux 3.3a where multiple waiting control mode clients crash the server.
        let tmux_path = crate::session::tmux_path();
        crate::debug_log::log(&format!("connect(): checking session '{}'", session_name));
        log_to(log, LogKind::Info, format!("tmux binary: {}", tmux_path));
        let has_session_cmd = format!("{} has-session -t {}", tmux_path, session_name);
        log_to(log, LogKind::Command, has_session_cmd.clone());
        let check = crate::session::tmux_command()
            .args(["has-session", "-t", session_name])
            .output()
            .map_err(|e| {
                let msg = format!(
                    "Failed to check session: {}\n  command: {}\n  tmux binary: {}",
                    e, has_session_cmd, tmux_path
                );
                log_to(log, LogKind::Error, msg.clone());
                msg
            })?;
        log_to(log, LogKind::Output, format_output(&check));

        if !check.status.success() {
            let stderr = String::from_utf8_lossy(&check.stderr);
            // List existing sessions for diagnostics
            let list_cmd = format!("{} list-sessions -F '#{{session_name}}'", tmux_path);
            log_to(log, LogKind::Command, list_cmd);
            let list_output = crate::session::tmux_command()
                .args(["list-sessions", "-F", "#{session_name}"])
                .output();
            let sessions = match &list_output {
                Ok(o) => {
                    log_to(log, LogKind::Output, format_output(o));
                    String::from_utf8_lossy(&o.stdout).trim().to_string()
                }
                Err(e) => {
                    log_to(log, LogKind::Error, format!("list-sessions failed: {}", e));
                    "(failed to list)".to_string()
                }
            };
            return Err(format!(
                "Session '{}' does not exist\n\
                  command: {}\n\
                  tmux binary: {}\n\
                  stderr: {}\n\
                  existing sessions: {}",
                session_name,
                has_session_cmd,
                tmux_path,
                if stderr.is_empty() {
                    "(empty)"
                } else {
                    stderr.trim()
                },
                if sessions.is_empty() {
                    "(none)"
                } else {
                    &sessions
                },
            ));
        }

        // Spawn tmux in control mode (-CC) attached to a PTY allocated
        // directly via openpty(3). Replaces the previous `script(1)` wrapper
        // — script's behavior under macOS launchd (no controlling TTY in the
        // parent) was unreliable and caused the server to die ~50ms after
        // sending %begin when the .app was launched from Finder.
        //
        // pty-process makes the spawned tmux a session leader of a fresh
        // session and sets the new pty as its controlling terminal, which is
        // exactly what `tmux -CC` requires (it calls tcgetattr(STDIN_FILENO)
        // and refuses to run without a real TTY). Same code path for both
        // platforms; no `script`, no `/bin/sh -c`, no shell quoting.
        let tmux_bin_str = crate::session::tmux_bin();

        let (pty, pts) = pty_process::open().map_err(|e| {
            let msg = format!("Failed to open pty: {}", e);
            log_to(log, LogKind::Error, msg.clone());
            msg
        })?;
        pty.resize(pty_process::Size::new(
            INITIAL_PTY_ROWS as u16,
            INITIAL_PTY_COLS as u16,
        ))
        .map_err(|e| {
            let msg = format!("Failed to set pty size: {}", e);
            log_to(log, LogKind::Error, msg.clone());
            msg
        })?;

        let mut tmux_args: Vec<String> = Vec::new();
        if let Ok(socket) = std::env::var("TMUX_SOCKET") {
            if !socket.is_empty() {
                tmux_args.push("-L".to_string());
                tmux_args.push(socket);
            }
        }
        tmux_args.extend([
            "-CC".to_string(),
            "attach-session".to_string(),
            "-t".to_string(),
            session_name.to_string(),
        ]);

        let shell_desc = format!("{} {}", tmux_bin_str, tmux_args.join(" "));
        crate::debug_log::log(&format!("connect(): pty spawn: {}", shell_desc));
        log_to(log, LogKind::Command, shell_desc.clone());

        // Force a usable env for tmux. macOS Finder/Applications launches go
        // through launchd with a sparse environment (no TERM, no LANG); tmux
        // is sensitive to both. Set sensible defaults regardless of how the
        // parent app was started.
        let mut cmd = pty_process::Command::new(tmux_bin_str);
        cmd = cmd.args(&tmux_args);
        if std::env::var_os("TERM").is_none() {
            cmd = cmd.env("TERM", "xterm-256color");
        }
        if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
            cmd = cmd.env("LANG", "en_US.UTF-8");
        }
        if let Some(dir) = working_dir {
            cmd = cmd.current_dir(dir);
        }

        let child = cmd.spawn(pts).map_err(|e| {
            let msg = format!(
                "Failed to spawn tmux on pty: {}\n  command: {}",
                e, shell_desc
            );
            log_to(log, LogKind::Error, msg.clone());
            msg
        })?;

        let (pty_reader, pty_writer) = pty.into_split();

        let recent_output: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel(1000);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        spawn_parser_task(pty_reader, tx, ready_tx, recent_output.clone());

        // Wait for the parser to receive the first event from tmux,
        // confirming the control mode connection is alive. Without this
        // gate, the caller may start sending commands before tmux has
        // initialized, or worse, not notice that tmux exited immediately.
        crate::debug_log::log("connect(): waiting for first control mode event (10s timeout)");
        log_to(
            log,
            LogKind::Info,
            "waiting for first control mode event (10s timeout)",
        );

        let mut child = child;
        match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
            Ok(Ok(())) => {
                crate::debug_log::log("connect(): control mode connected successfully");
                log_to(log, LogKind::Info, "control mode connected successfully");
            }
            Ok(Err(_)) => {
                // Parser hit EOF before sending readiness — tmux exited.
                let _ = child.kill().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                let tail = drain_recent_output(&recent_output).await;
                log_to(
                    log,
                    LogKind::Output,
                    format!(
                        "control mode died immediately, output: {}",
                        if tail.is_empty() { "(empty)" } else { &tail }
                    ),
                );
                return Err(format!(
                    "Control mode connection died immediately for session '{}'\n\
                      command: {}\n\
                      output: {}",
                    session_name,
                    shell_desc,
                    if tail.is_empty() { "(empty)" } else { &tail },
                ));
            }
            Err(_) => {
                let _ = child.kill().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                let tail = drain_recent_output(&recent_output).await;
                log_to(
                    log,
                    LogKind::Output,
                    format!(
                        "control mode timed out after 10s, output: {}",
                        if tail.is_empty() { "(empty)" } else { &tail }
                    ),
                );
                return Err(format!(
                    "Control mode timed out (10s) for session '{}'\n\
                      command: {}\n\
                      output: {}",
                    session_name,
                    shell_desc,
                    if tail.is_empty() { "(empty)" } else { &tail },
                ));
            }
        }

        Ok(Self {
            child,
            pty_writer,
            event_rx: rx,
            command_counter: 0,
            recent_output,
        })
    }

    /// Create a new control mode session.
    ///
    /// Creates a simple detached session then attaches in control mode.
    /// No config file is passed (-f) — the user's default ~/.tmux.conf is used.
    /// No size flags (-x/-y) — control mode will resize after connecting.
    pub async fn new_session(
        session_name: &str,
        working_dir: Option<&std::path::Path>,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<Self, String> {
        // Create a minimal detached session. Avoid -f (crashes with devcontainer
        // config), -x/-y (can cause issues), and any settings that might
        // conflict with an existing tmux server.
        let tmux_path = session::tmux_path();
        let mut create_cmd = session::tmux_command();
        create_cmd.args(["new-session", "-d", "-s", session_name]);
        if let Some(dir) = working_dir {
            create_cmd.arg("-c").arg(dir);
        }

        let cmd_desc = format!("{} new-session -d -s {}", tmux_path, session_name);
        eprintln!("[tmuxy] creating session: {}", cmd_desc);
        log_to(log, LogKind::Command, cmd_desc.clone());

        let output = create_cmd.output().map_err(|e| {
            let msg = format!(
                "Failed to create tmux session: {}\n  command: {}",
                e, cmd_desc
            );
            log_to(log, LogKind::Error, msg.clone());
            msg
        })?;
        log_to(log, LogKind::Output, format_output(&output));

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr_str = stderr.trim();

            // tmux 3.5a crashes the server when new-session is run while a
            // control mode client is attached (e.g., stale client from a
            // previous tmuxy crash). If the server died, retry once — the
            // fresh server won't have stale CC clients.
            if stderr_str.contains("server exited unexpectedly")
                || stderr_str.contains("no server running")
            {
                eprintln!("[tmuxy] server crashed or missing, retrying session creation");
                log_to(
                    log,
                    LogKind::Info,
                    "tmux server crashed or missing — retrying after 500ms",
                );
                std::thread::sleep(std::time::Duration::from_millis(500));

                let mut retry_cmd = session::tmux_command();
                retry_cmd.args(["new-session", "-d", "-s", session_name]);
                if let Some(dir) = working_dir {
                    retry_cmd.arg("-c").arg(dir);
                }
                log_to(log, LogKind::Command, format!("{} (retry)", cmd_desc));
                let retry_output = retry_cmd.output().map_err(|e| {
                    let msg = format!(
                        "Retry failed to create tmux session: {}\n  command: {}",
                        e, cmd_desc
                    );
                    log_to(log, LogKind::Error, msg.clone());
                    msg
                })?;
                log_to(log, LogKind::Output, format_output(&retry_output));
                if !retry_output.status.success() {
                    let retry_stderr = String::from_utf8_lossy(&retry_output.stderr);
                    return Err(format!(
                        "Failed to create tmux session '{}' (after retry)\n  command: {}\n  stderr: {}",
                        session_name, cmd_desc, retry_stderr.trim()
                    ));
                }
                eprintln!("[tmuxy] session '{}' created on retry", session_name);
                log_to(
                    log,
                    LogKind::Info,
                    format!("session '{}' created on retry", session_name),
                );
            } else {
                return Err(format!(
                    "Failed to create tmux session '{}'\n  command: {}\n  stderr: {}",
                    session_name, cmd_desc, stderr_str
                ));
            }
        } else {
            eprintln!(
                "[tmuxy] session '{}' created, attaching control mode",
                session_name
            );
            log_to(
                log,
                LogKind::Info,
                format!("session '{}' created, attaching control mode", session_name),
            );
        }

        // Attach in control mode
        Self::connect(session_name, working_dir, log).await
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

        Ok(cmd_num)
    }

    /// Append captured subprocess stderr to an io::Error message.
    /// Gives the user concrete evidence of *why* the pipe broke instead of
    /// the generic "Broken pipe (os error 32)".
    async fn enrich_io_error(&self, prefix: &str, e: &std::io::Error) -> String {
        let stderr = drain_recent_output(&self.recent_output).await;
        if stderr.is_empty() {
            format!("{}: {}", prefix, e)
        } else {
            format!("{}: {} | subprocess stderr: {}", prefix, e, stderr)
        }
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
            if let Err(e) = self
                .pty_writer
                .write_all(format!("{}\n", cmd).as_bytes())
                .await
            {
                return Err(self.enrich_io_error("Failed to send command", &e).await);
            }
            self.command_counter += 1;
        }

        // Single flush for all commands
        if let Err(e) = self.pty_writer.flush().await {
            return Err(self.enrich_io_error("Failed to flush stdin", &e).await);
        }

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
