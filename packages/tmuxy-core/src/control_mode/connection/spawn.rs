use super::*;
use tokio::io::{AsyncBufReadExt, BufReader};

/// What makes a session, whichever client asks tmux for it (this
/// connection's `-CC new-session -A`, or another session's control-mode
/// client): its name, the group it joins, and its first window.
///
/// A second GUI window on the same session joins the base session's group
/// (`-t <base>`), sharing every window and pane but keeping its own current
/// window. A session about to be rebuilt from a snapshot gets its first
/// window made here, by name and directory, so the rebuild has a window 0 to
/// build onto. With `-A` tmux ignores all three when the session exists.
pub fn new_session_flags(
    session: &str,
    group_target: Option<&str>,
    first_window: Option<&(String, String)>,
) -> Vec<String> {
    let mut flags = vec!["-s".to_string(), session.to_string()];
    if let Some(base) = group_target {
        flags.extend(["-t".to_string(), crate::session::exact_session_target(base)]);
    }
    if let Some((name, cwd)) = first_window {
        flags.extend([
            "-n".to_string(),
            name.clone(),
            "-c".to_string(),
            cwd.clone(),
        ]);
    }
    flags
}

/// The argv that launches `tmux -CC`, led by its program (the tmux path, or
/// `ssh -tt <dest> tmux`).
pub(super) fn build_tmux_args(
    session_name: &str,
    create_if_missing: bool,
    group_target: Option<&str>,
    first_window: Option<&(String, String)>,
) -> Vec<String> {
    // Over ssh, `-tt` is required for `-CC` control mode's remote pty.
    let mut tmux_args: Vec<String> = crate::session::tmux_argv(true);
    // tmux only reads `-f` when it forks a new server, so this covers the
    // create path; `sync_initial_state` source-files the same config after an
    // attach.
    // Never on the user's own server: `-f` is what a server is configured
    // FROM, so one tmuxy had to start there would come up without their
    // `~/.tmux.conf`.
    if !crate::session::on_users_own_server() {
        if let Some(path) = crate::session::get_config_path() {
            tmux_args.push("-f".to_string());
            tmux_args.push(path.to_string_lossy().into_owned());
        }
    }
    if create_if_missing {
        // `-A` attaches or creates in one step: no clientless gap for the
        // macOS launchd reaper to hit.
        tmux_args.extend(["-CC", "new-session", "-A"].map(String::from));
        tmux_args.extend(new_session_flags(session_name, group_target, first_window));
    } else {
        tmux_args.extend([
            "-CC".to_string(),
            "attach-session".to_string(),
            "-t".to_string(),
            crate::session::exact_session_target(session_name),
        ]);
    }
    tmux_args
}

/// How tmux's first control-mode event settles a connect.
pub(super) enum Opening {
    Connected,
    /// tmux reached control mode but its own command failed (the opening
    /// block closed with `%error`) or it exited: tmux's words, if any.
    Refused(String),
}

/// `-CC` opens control mode with a DCS (`ESC P 1000 p`) written right before
/// the `%begin` of the block answering tmux's own command, on the same line.
const CONTROL_MODE_DCS: &[u8] = b"\x1bP1000p";

/// The verdict tmux's first event gives, and the event itself when it is the
/// monitor's to see. tmux answers its own command (`attach-session`,
/// `new-session`) in the opening block, so `%end` means attached and
/// `%error` carries why not; a notification means attached too, and `%exit`
/// means tmux left. The opening block answers nothing tmuxy sent, so it goes
/// no further.
fn opening_of(event: ControlModeEvent) -> (Opening, Option<ControlModeEvent>) {
    match event {
        ControlModeEvent::CommandResponse { success: true, .. } => (Opening::Connected, None),
        ControlModeEvent::CommandResponse {
            success: false,
            output,
        } => (Opening::Refused(output), None),
        ControlModeEvent::Exit { reason } => (Opening::Refused(reason.unwrap_or_default()), None),
        event => (Opening::Connected, Some(event)),
    }
}

/// Parse the PTY master's lines into events on `tx`, settling `opening` on
/// the first one. A line before control mode opens that is not control mode's
/// (tmux's error on its way out, or ssh's warnings) is no event. Every line
/// also goes to `recent_output` (the last 200): pty-process merges the
/// child's stdout and stderr into the PTY stream, so whatever tmux says on
/// its way out lands there for error messages.
pub(super) fn spawn_parser_task(
    reader: pty_process::OwnedReadPty,
    tx: mpsc::Sender<ControlModeEvent>,
    opening: tokio::sync::oneshot::Sender<Opening>,
    recent_output: Arc<Mutex<Vec<String>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf_reader = BufReader::new(reader);
        let mut parser = Parser::new();
        let mut buf = Vec::with_capacity(4096);
        let mut opening = Some(opening);

        loop {
            buf.clear();
            match read_line_capped(&mut buf_reader, &mut buf, MAX_LINE_BYTES).await {
                Ok(0) => {
                    // tmux's parting words (often a `%error` or `%exit
                    // detached` line) are raw control-mode output, so they are
                    // logged at `trace`, below the action trace's floor
                    // (docs/TRACING.md).
                    let tail: Vec<String> = {
                        let guard = recent_output.lock().await;
                        let n = guard.len();
                        let take_from = n.saturating_sub(20);
                        guard[take_from..].to_vec()
                    };
                    tracing::info!(last_lines = tail.len(), "parser task: EOF on PTY");
                    for line in &tail {
                        tracing::trace!("  | {}", line);
                    }
                    break;
                }
                Ok(_) if buf.is_empty() => {}
                Ok(_) => {
                    while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                        buf.pop();
                    }

                    // Text for the log of recent lines only. The parser takes
                    // the bytes: a pane's output can stop mid-character, and
                    // read as text that character is lost.
                    let line = String::from_utf8_lossy(&buf).to_string();

                    if !line.is_empty() {
                        let mut guard = recent_output.lock().await;
                        guard.push(line.clone());
                        if guard.len() > 200 {
                            let drain_count = guard.len() - 200;
                            guard.drain(0..drain_count);
                        }
                    }

                    let bytes = match opening {
                        Some(_) => buf.strip_prefix(CONTROL_MODE_DCS).unwrap_or(&buf),
                        None => &buf[..],
                    };
                    let Some(mut event) = parser.parse_line(bytes) else {
                        continue;
                    };
                    if let Some(settle) = opening.take() {
                        let (verdict, first) = opening_of(event);
                        let _ = settle.send(verdict);
                        match first {
                            Some(first) => event = first,
                            None => continue,
                        }
                    }
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "parser task: read error on PTY");
                    break;
                }
            }
        }
    })
}

/// The longest control-mode line kept. tmux writes a pane's output a read at
/// a time, so a real line is a few KiB escaped; one past this is dropped
/// whole rather than buffered without bound.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// `read_until(b'\n')` that keeps at most `max` bytes of a line. A longer
/// line is read to its end and left out: `buf` comes back empty for it.
/// Returns the bytes read, `0` only at EOF.
pub(super) async fn read_line_capped<R>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<usize>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut read = 0;
    let mut overflowed = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            break;
        }
        let (chunk, done) = match available.iter().position(|&b| b == b'\n') {
            Some(at) => (&available[..=at], true),
            None => (available, false),
        };
        let len = chunk.len();
        if !overflowed && buf.len() + len <= max {
            buf.extend_from_slice(chunk);
        } else if !overflowed {
            overflowed = true;
            buf.clear();
        }
        reader.consume(len);
        read += len;
        if done {
            break;
        }
    }
    if overflowed {
        tracing::warn!(
            bytes = read,
            "parser task: dropped a control-mode line past the cap"
        );
    }
    Ok(read)
}

impl ControlModeConnection {
    /// `Err(SessionNotFound)` names the sessions that do exist: whoever hits
    /// this almost always needs to see "what *do* you have".
    pub(super) fn preflight_session(
        session_name: &str,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(), TmuxError> {
        let tmux_path = crate::session::tmux_path();
        tracing::debug!(session = session_name, "connect(): checking session");
        let target = crate::session::exact_session_target(session_name);
        let has_session_cmd = format!("{} has-session -t {}", tmux_path, target);
        log_to(log, LogKind::Command, has_session_cmd.clone());
        let check = crate::session::tmux_command()
            .args(["has-session", "-t", &target])
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

    pub(super) fn allocate_pty(
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

    /// Sets `TERM` and `LANG` when absent: launchd hands an `.app` started
    /// from Finder a sparse environment.
    pub(super) fn spawn_tmux(
        tmux_args: &[String],
        pts: pty_process::Pts,
        working_dir: Option<&std::path::Path>,
        shell_desc: &str,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<tokio::process::Child, TmuxError> {
        let program = &tmux_args[0];
        let mut cmd = pty_process::Command::new(program);
        cmd = cmd.args(&tmux_args[1..]);
        // Keep the AppImage's bundled paths, variables, working directory and
        // mount descriptor out of the tmux server (see appimage_env).
        #[cfg(target_os = "linux")]
        if std::env::var_os("APPIMAGE").is_some() {
            for var in super::appimage_env::VARS_TO_REMOVE {
                cmd = cmd.env_remove(var);
            }
            if let Some(appdir) = std::env::var_os("APPDIR") {
                let appdir = std::path::Path::new(&appdir);
                super::appimage_env::close_appdir_fds_on_exec(appdir);
                for var in super::appimage_env::PATH_LIST_VARS {
                    if let Ok(val) = std::env::var(var) {
                        cmd = match super::appimage_env::clean_path_list(var, &val, appdir) {
                            Some(kept) => cmd.env(var, kept),
                            None => cmd.env_remove(var),
                        };
                    }
                }
                if working_dir.is_none() {
                    let owd = std::env::var_os("OWD").map(std::path::PathBuf::from);
                    let home = dirs::home_dir();
                    if let Some(dir) = super::appimage_env::working_dir_outside_appdir(
                        appdir,
                        owd.as_deref(),
                        home.as_deref(),
                    ) {
                        cmd = cmd.current_dir(dir);
                    }
                }
            }
        }
        if std::env::var_os("TERM").is_none() {
            cmd = cmd.env("TERM", "xterm-256color");
        }
        if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
            cmd = cmd.env("LANG", "en_US.UTF-8");
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

    /// Connected once tmux's first control-mode event says so (`Opening`).
    /// The 10s ceiling swallows a slow first-time `default-command` startup
    /// while still surfacing a dead tmux server quickly.
    pub(super) async fn wait_for_control_mode(
        &mut self,
        opening: tokio::sync::oneshot::Receiver<Opening>,
        reader: tokio::task::JoinHandle<()>,
        session_name: &str,
        shell_desc: &str,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(), TmuxError> {
        tracing::debug!("connect(): waiting for control mode to open (10s timeout)");
        log_to(
            log,
            LogKind::Info,
            "waiting for control mode to open (10s timeout)",
        );

        let outcome = tokio::time::timeout(CONNECT_TIMEOUT, opening).await;
        if let Ok(Ok(Opening::Connected)) = outcome {
            tracing::info!("connect(): {CONNECTED_LINE}");
            log_to(log, LogKind::Info, CONNECTED_LINE);
            return Ok(());
        }
        // A tmux that came up late is attached by now, and killing an
        // attached control client crashes tmux 3.5a: it is detached, and one
        // that already exited is only reaped. Its parting words are what the
        // reader has read once the PTY closes.
        self.graceful_close().await;
        if tokio::time::timeout(Duration::from_secs(1), reader)
            .await
            .is_err()
        {
            tracing::debug!("connect(): the PTY reader is still reading");
        }
        let status = match self.child.try_wait() {
            Ok(Some(status)) => status.to_string(),
            _ => "still running".to_string(),
        };
        let tail = drain_recent_output(&self.recent_output).await;
        let output = if tail.is_empty() { "(empty)" } else { &tail };
        let (what, error) = match outcome {
            Ok(Ok(Opening::Refused(said))) => {
                let said = if said.is_empty() { output } else { &said };
                (
                    "refused",
                    TmuxError::ProcessExited {
                        reason: format!(
                            "tmux refused control mode for session '{session_name}': {said} (command: {shell_desc}, {status})"
                        ),
                    },
                )
            }
            Ok(_) => (
                "never opened",
                TmuxError::ProcessExited {
                    reason: format!(
                        "tmux exited before control mode opened for session '{session_name}': {output} (command: {shell_desc}, {status})"
                    ),
                },
            ),
            Err(_) => (
                "timed out after 10s",
                TmuxError::Timeout {
                    operation: format!("control mode connect to session '{session_name}'"),
                    after: CONNECT_TIMEOUT,
                },
            ),
        };
        log_to(
            log,
            LogKind::Output,
            format!("control mode {what}, {status}, output: {output}"),
        );
        Err(error)
    }
}

/// How long tmux has to print its first control-mode line.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Logged once per control-mode connection. `tests/smoke/smoke-test.js` and
/// `tests/smoke/macos-sparse-path-test.js` count it in the desktop app's log
/// file (more than two in a run is a reconnect loop): rewording it blinds them.
const CONNECTED_LINE: &str = "control mode connected successfully";

#[cfg(test)]
mod read_line_tests {
    use super::read_line_capped;

    #[tokio::test]
    async fn a_line_past_the_cap_is_dropped_and_the_next_is_read() {
        let input: &[u8] = b"short\n0123456789abcdef\nnext\n";
        let mut reader = tokio::io::BufReader::with_capacity(4, input);
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        loop {
            buf.clear();
            if read_line_capped(&mut reader, &mut buf, 10).await.unwrap() == 0 {
                break;
            }
            lines.push(String::from_utf8(buf.clone()).unwrap());
        }
        assert_eq!(lines, ["short\n", "", "next\n"]);
    }
}
