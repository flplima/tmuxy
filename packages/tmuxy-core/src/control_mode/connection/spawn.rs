use super::*;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Build the argv passed to `tmux` plus a human-readable description that's
/// safe to log (one socket flag pair only — `tmux_bin()` already includes
/// the socket, so omit it from the args for the log line). `tmux_args`
/// carries the actual argv used by `spawn`.
pub(super) fn build_tmux_args(
    session_name: &str,
    create_if_missing: bool,
    group_target: Option<&str>,
    first_window: Option<&(String, String)>,
) -> (Vec<String>, String) {
    // Full argv including the program token: the local tmux path, or
    // `ssh -tt <dest> tmux` when tunneled to a remote host. `-tt` is required
    // for `-CC` control mode's remote pty.
    let mut tmux_args: Vec<String> = crate::session::tmux_argv(true);
    // Apply the tmuxy config chain (session::get_config_path: the defaults,
    // the user's tmuxy.conf, the essentials) at server-startup time. tmux only reads
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
        // A session about to be rebuilt from a snapshot gets its first window
        // made right here, by name and directory, so the rebuild has a
        // window 0 to build onto. tmux ignores both when the session exists.
        if let Some((name, cwd)) = first_window {
            tmux_args.extend([
                "-n".to_string(),
                name.clone(),
                "-c".to_string(),
                cwd.clone(),
            ]);
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
pub(super) fn spawn_parser_task(
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
            match read_line_capped(&mut buf_reader, &mut buf, MAX_LINE_BYTES).await {
                Ok(0) => {
                    // EOF — tmux process exited (or PTY was closed). tmux's
                    // parting words (often a `%error` or `%exit detached`
                    // line) are raw control-mode output, so they are logged at
                    // `trace`, below the action trace's floor (docs/TRACING.md).
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
                // A line past the cap, dropped whole.
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

                    if let Some(event) = parser.parse_line(&buf) {
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
                    tracing::warn!(error = %e, "parser task: read error on PTY");
                    break;
                }
            }
        }
    });
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
    /// Check that `session_name` actually exists before we burn a PTY on it.
    /// Returns `Err(SessionNotFound)` enriched with the running session list
    /// for diagnostics — operators almost always need to see "what *do* you
    /// have" when this fires.
    pub(super) fn preflight_session(
        session_name: &str,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(), TmuxError> {
        let tmux_path = crate::session::tmux_path();
        tracing::debug!(session = session_name, "connect(): checking session");
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

    /// Spawn `tmux -CC …` attached to the supplied pty slave.
    ///
    /// Sets `TERM=xterm-256color`, `LANG=en_US.UTF-8` (only if absent), and
    /// prepends the Homebrew bin paths to `PATH` on macOS. These all exist
    /// to keep `.app`-from-Finder launches functional: launchd hands us a
    /// sparse env that breaks `default-command`s using Homebrew binaries.
    pub(super) fn spawn_tmux(
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
    pub(super) async fn wait_for_initial_state(
        child: &mut tokio::process::Child,
        ready_rx: tokio::sync::oneshot::Receiver<()>,
        session_name: &str,
        shell_desc: &str,
        recent_output: &Arc<Mutex<Vec<String>>>,
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(), TmuxError> {
        tracing::debug!("connect(): waiting for first control mode event (10s timeout)");
        log_to(
            log,
            LogKind::Info,
            "waiting for first control mode event (10s timeout)",
        );

        match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
            Ok(Ok(())) => {
                // The smoke tests count this line in the desktop app's log
                // file: more than two in a run is a reconnect loop.
                tracing::info!("connect(): control mode connected successfully");
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
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
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
