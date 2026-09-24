//! Connection manager for tmux control mode
//!
//! Handles spawning the `tmux -CC` process and communicating with it.

use super::log::{LogKind, LogSink};
use super::parser::{ControlModeEvent, Parser};
use crate::error::TmuxError;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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

/// Build the argv passed to `tmux` plus a human-readable description that's
/// safe to log (one socket flag pair only — `tmux_bin()` already includes
/// the socket, so omit it from the args for the log line). `tmux_args`
/// carries the actual argv used by `spawn`.
fn build_tmux_args(
    session_name: &str,
    create_if_missing: bool,
    group_target: Option<&str>,
) -> (Vec<String>, String) {
    // Full argv including the program token: the local tmux path, or
    // `ssh -tt <dest> tmux` when tunneled to a remote host. `-tt` is required
    // for `-CC` control mode's remote pty.
    let mut tmux_args: Vec<String> = crate::session::tmux_argv(true);
    // Apply the user's tmuxy config at server-startup time. tmux only reads
    // `-f` when it forks a new server, so this only affects the create path;
    // the monitor's `sync_initial_state()` source-files the same config after
    // attach to cover the attach path. Skipped over SSH — the local config
    // path doesn't exist on the remote host (the remote server uses its own
    // tmux config, and sync_initial_state's remote source-file is a no-op).
    if crate::session::ssh_target().is_none() {
        if let Some(path) = crate::session::get_config_path() {
            tmux_args.push("-f".to_string());
            tmux_args.push(path.to_string_lossy().into_owned());
        }
    }
    if create_if_missing {
        // -A: attach to existing session if it exists, otherwise create.
        // Atomic from tmux's perspective — no clientless gap for the macOS
        // launchd reaper to hit.
        tmux_args.extend([
            "-CC".to_string(),
            "new-session".to_string(),
            "-A".to_string(),
            "-s".to_string(),
            session_name.to_string(),
        ]);
        // A second GUI window on the same session: `-t <base>` makes the new
        // session a member of the base session's group, so the two share every
        // window and pane but keep their own current window — which is what
        // lets one OS window sit on one tab while another sits on a different
        // one. With `-A` the flag is inert when the session already exists.
        if let Some(base) = group_target {
            tmux_args.extend(["-t".to_string(), base.to_string()]);
        }
    } else {
        tmux_args.extend([
            "-CC".to_string(),
            "attach-session".to_string(),
            "-t".to_string(),
            session_name.to_string(),
        ]);
    }

    // `tmux_args` now leads with the program token (tmux path or `ssh …`), so
    // the joined argv is itself the human-readable, log-safe description.
    let shell_desc = tmux_args.join(" ");

    (tmux_args, shell_desc)
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
                    // EOF — tmux process exited (or PTY was closed). Surface
                    // the last lines we saw to the persistent debug log so a
                    // user-collected log capture includes tmux's parting
                    // words (often a `%error` or `%exit detached` line).
                    let tail: Vec<String> = {
                        let guard = recent_output.lock().await;
                        let n = guard.len();
                        let take_from = n.saturating_sub(20);
                        guard[take_from..].to_vec()
                    };
                    if tail.is_empty() {
                        crate::debug_log::log("parser task: EOF on PTY (no output captured)");
                    } else {
                        crate::debug_log::log(&format!(
                            "parser task: EOF on PTY, last {} line(s):",
                            tail.len()
                        ));
                        for line in &tail {
                            crate::debug_log::log(&format!("  | {}", line));
                        }
                    }
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
                    crate::debug_log::log(&format!("parser task: read error on PTY: {}", e));
                    break;
                }
            }
        }
    });
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
            build_tmux_args(session_name, create_if_missing, group_target);
        crate::debug_log::log(&format!("connect(): pty spawn: {}", shell_desc));
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

    /// Check that `session_name` actually exists before we burn a PTY on it.
    /// Returns `Err(SessionNotFound)` enriched with the running session list
    /// for diagnostics — operators almost always need to see "what *do* you
    /// have" when this fires.
    fn preflight_session(
        session_name: &str,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(), TmuxError> {
        let tmux_path = crate::session::tmux_path();
        crate::debug_log::log(&format!("connect(): checking session '{}'", session_name));
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
                TmuxError::other(msg)
            })?;
        log_to(log, LogKind::Output, format_output(&check));

        if check.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&check.stderr);
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
        Err(TmuxError::SessionNotFound {
            name: format!(
                "{} (command: {}, tmux binary: {}, stderr: {}, existing sessions: {})",
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
            ),
        })
    }

    /// Allocate a fresh PTY sized to `INITIAL_PTY_COLS x INITIAL_PTY_ROWS`.
    fn allocate_pty(
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(pty_process::Pty, pty_process::Pts), TmuxError> {
        let (pty, pts) = pty_process::open().map_err(|e| {
            let msg = format!("Failed to open pty: {}", e);
            log_to(log, LogKind::Error, msg.clone());
            TmuxError::other(msg)
        })?;
        pty.resize(pty_process::Size::new(
            INITIAL_PTY_ROWS as u16,
            INITIAL_PTY_COLS as u16,
        ))
        .map_err(|e| {
            let msg = format!("Failed to set pty size: {}", e);
            log_to(log, LogKind::Error, msg.clone());
            TmuxError::other(msg)
        })?;
        Ok((pty, pts))
    }

    /// Spawn `tmux -CC …` attached to the supplied pty slave.
    ///
    /// Sets `TERM=xterm-256color`, `LANG=en_US.UTF-8` (only if absent), and
    /// prepends the Homebrew bin paths to `PATH` on macOS. These all exist
    /// to keep `.app`-from-Finder launches functional: launchd hands us a
    /// sparse env that breaks `default-command`s using Homebrew binaries.
    fn spawn_tmux(
        tmux_args: &[String],
        pts: pty_process::Pts,
        working_dir: Option<&std::path::Path>,
        shell_desc: &str,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<tokio::process::Child, TmuxError> {
        // `tmux_args[0]` is the program to launch — the local tmux path, or
        // `ssh` when tunneling to a remote host (see `build_tmux_args`).
        let program = &tmux_args[0];
        let mut cmd = pty_process::Command::new(program);
        cmd = cmd.args(&tmux_args[1..]);
        if std::env::var_os("TERM").is_none() {
            cmd = cmd.env("TERM", "xterm-256color");
        }
        if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
            cmd = cmd.env("LANG", "en_US.UTF-8");
        }
        #[cfg(target_os = "macos")]
        {
            // `~/.local/bin` holds the `tmuxy` shorthand the app writes on launch
            // (session::refresh_launcher); without it a pane's `tmuxy widget tree`
            // (the left sidebar) is "command not found" when launched from Finder.
            let local_bin = dirs::home_dir()
                .map(|h| h.join(".local/bin").to_string_lossy().into_owned())
                .unwrap_or_default();
            let extras: Vec<&str> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
                .into_iter()
                .chain((!local_bin.is_empty()).then_some(local_bin.as_str()))
                .collect();
            let current = std::env::var("PATH").unwrap_or_default();
            let missing: Vec<&str> = extras
                .iter()
                .copied()
                .filter(|p| !current.split(':').any(|seg| seg == *p))
                .collect();
            if !missing.is_empty() {
                let prefixed = if current.is_empty() {
                    missing.join(":")
                } else {
                    format!("{}:{}", missing.join(":"), current)
                };
                cmd = cmd.env("PATH", prefixed);
            }
        }
        if let Some(dir) = working_dir {
            cmd = cmd.current_dir(dir);
        }

        cmd.spawn(pts).map_err(|e| {
            let msg = format!(
                "Failed to spawn tmux on pty: {}\n  command: {}",
                e, shell_desc
            );
            log_to(log, LogKind::Error, msg.clone());
            TmuxError::other(msg)
        })
    }

    /// Block until the parser task signals readiness (first parsed event from
    /// tmux), or `Err(TmuxError::Timeout)` after 10 seconds. The 10s ceiling
    /// is long enough to swallow a slow first-time `default-command` startup
    /// while still surfacing a dead tmux server quickly.
    async fn wait_for_initial_state(
        child: &mut tokio::process::Child,
        ready_rx: tokio::sync::oneshot::Receiver<()>,
        session_name: &str,
        shell_desc: &str,
        recent_output: &Arc<Mutex<Vec<String>>>,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(), TmuxError> {
        crate::debug_log::log("connect(): waiting for first control mode event (10s timeout)");
        log_to(
            log,
            LogKind::Info,
            "waiting for first control mode event (10s timeout)",
        );

        match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
            Ok(Ok(())) => {
                crate::debug_log::log("connect(): control mode connected successfully");
                log_to(log, LogKind::Info, "control mode connected successfully");
                Ok(())
            }
            Ok(Err(_)) => {
                // Parser hit EOF before sending readiness — tmux exited.
                let _ = child.kill().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                let tail = drain_recent_output(recent_output).await;
                log_to(
                    log,
                    LogKind::Output,
                    format!(
                        "control mode died immediately, output: {}",
                        if tail.is_empty() { "(empty)" } else { &tail }
                    ),
                );
                Err(TmuxError::ProcessExited {
                    reason: format!(
                        "control mode died immediately for session '{}' (command: {}, output: {})",
                        session_name,
                        shell_desc,
                        if tail.is_empty() { "(empty)" } else { &tail },
                    ),
                })
            }
            Err(_) => {
                let _ = child.kill().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                let tail = drain_recent_output(recent_output).await;
                log_to(
                    log,
                    LogKind::Output,
                    format!(
                        "control mode timed out after 10s, output: {}",
                        if tail.is_empty() { "(empty)" } else { &tail }
                    ),
                );
                Err(TmuxError::Timeout {
                    operation: format!("control mode connect to session '{}'", session_name),
                    after: Duration::from_secs(10),
                })
            }
        }
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

    /// Kill the control mode connection.
    pub async fn kill(&mut self) -> Result<(), TmuxError> {
        self.child.kill().await.map_err(TmuxError::Io)
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
mod tests {
    use super::*;

    /// The tail of the argv is the part that decides what tmux does. The head
    /// (tmux path, `ssh -tt …`, `-f <config>`) varies by machine, so the
    /// assertions are on the suffix only.
    fn tail(args: &[String], n: usize) -> Vec<&str> {
        args[args.len() - n..].iter().map(String::as_str).collect()
    }

    #[test]
    fn creating_a_session_attaches_in_the_same_command() {
        // `new-session -A` attaches to an existing session or creates one, in
        // one step. A create followed by a separate attach leaves a moment
        // with no client, which macOS launchd's reaper kills the server in.
        let (args, desc) = build_tmux_args("tmuxy", true, None);
        assert_eq!(
            tail(&args, 5),
            vec!["-CC", "new-session", "-A", "-s", "tmuxy"]
        );
        // The description is the argv itself, so nothing that reaches the log
        // can claim to have run a command it did not.
        assert_eq!(desc, args.join(" "));
    }

    #[test]
    fn a_grouped_session_names_the_session_it_shares_windows_with() {
        // A second GUI window attaches to its own session in the base
        // session's group: same windows, its own current window.
        let (args, _) = build_tmux_args("tmuxy~2", true, Some("tmuxy"));
        assert_eq!(
            tail(&args, 7),
            vec!["-CC", "new-session", "-A", "-s", "tmuxy~2", "-t", "tmuxy"]
        );
    }

    #[test]
    fn attaching_never_creates_a_session() {
        // The monitor reconnect path must not resurrect a session the user
        // killed — it would come back empty and look like lost work.
        let (args, _) = build_tmux_args("tmuxy", false, None);
        assert_eq!(tail(&args, 4), vec!["-CC", "attach-session", "-t", "tmuxy"]);
        assert!(!args.iter().any(|a| a == "new-session"));
    }

    #[test]
    fn a_session_name_with_spaces_stays_one_argument() {
        // argv, not a shell string: a name is never re-split, so it cannot
        // smuggle a second command in.
        let (args, _) = build_tmux_args("my session; rm -rf ~", true, None);
        assert_eq!(
            args.last().map(String::as_str),
            Some("my session; rm -rf ~")
        );
    }

    /// `format_output` is what a failed tmux invocation shows the user. An
    /// empty stream must not become a dangling `stdout=` with nothing after it.
    #[test]
    fn a_failed_command_reports_its_exit_code_and_whatever_it_printed() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(256), // exit code 1
            stdout: b"  hello  \n".to_vec(),
            stderr: b"\nno server running\n".to_vec(),
        };
        assert_eq!(
            format_output(&output),
            "exit=1 stdout=hello stderr=no server running"
        );

        let quiet = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        assert_eq!(format_output(&quiet), "exit=0");
    }

    #[test]
    fn a_killed_command_reports_a_signal_rather_than_a_missing_code() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(9), // killed by SIGKILL
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        assert_eq!(format_output(&output), "exit=signal");
    }

    /// Invalid UTF-8 is what a pane's own bytes look like when tmux fails
    /// mid-stream; the log line must still be produced.
    #[test]
    fn output_that_is_not_utf8_still_formats() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(256),
            stdout: vec![0xff, 0xfe, b'o', b'k'],
            stderr: Vec::new(),
        };
        assert!(format_output(&output).starts_with("exit=1 stdout="));
    }
}
