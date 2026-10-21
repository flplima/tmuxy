mod emitter;

use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::AppHandle;
use tmuxy_core::control_mode::{
    LogSink, MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter, TmuxMonitor,
};
use tmuxy_core::transport;

use tmuxy_core::session::session_name as get_session;
/// Where `tmuxy connect` points the app: a tmux socket, a session (created if
/// missing) and the ssh host, if any. Installed through
/// `tmuxy_core::session::set_connect_target`, which every tmux invocation —
/// the control-mode connection and the one-off reads — resolves from.
pub use tmuxy_core::session::ConnectTarget;

pub use emitter::{
    apply_config_change, emit_config_settings, lookup_image, poll_connect_requests, ImageStore,
    KeyBindingsState, TauriEmitter,
};
use emitter::{emit_detached, emit_fatal};

/// Live handle to the running control-mode monitor.
///
/// `cmd_tx` is the channel every tmux command and read goes through, on the
/// existing CC connection. Spawning external `tmux <cmd>` while CC is
/// attached can crash tmux 3.5a — see AGENTS.md and `docs/TMUX.md` — so the
/// desktop, like the web server, has no other way to reach tmux once
/// connected.
///
/// `last_client_size` is the most recent viewport size the frontend reported.
/// `run_tmux_command` uses it when rewriting `new-window` so the broken-out
/// window matches the visible viewport instead of inheriting the half-width
/// post-`splitw` size or the 200x50 control-mode PTY default.
#[derive(Clone, Default)]
pub struct MonitorState {
    pub cmd_tx: Arc<RwLock<Option<MonitorCommandSender>>>,
    /// Pictures decoded out of pane output, served by the `tmuxyimg:` scheme.
    pub images: ImageStore,
    pub last_client_size: Arc<RwLock<Option<(u32, u32)>>>,
    /// A pending `tmuxy connect` request. The monitor loop applies it at the
    /// top of its next iteration (switching sockets/session); a live
    /// connection is interrupted with a graceful `Shutdown` so the loop gets
    /// there promptly. See [`request_reconnect`].
    pub pending_reconnect: Arc<RwLock<Option<ConnectTarget>>>,
    /// Set by `detach_client`: the user asked to step away, so when the
    /// connection ends the loop must PARK rather than reconnect.
    ///
    /// Without it a detach is indistinguishable from a flap — the loop sees a
    /// healthy connection end, resets its counters and reattaches, putting the
    /// user straight back in the session they just left. Cleared when a
    /// deliberate reconnect revives the monitor.
    pub detached: Arc<RwLock<bool>>,
}

impl MonitorState {
    /// The live command channel, or `None` while the monitor is not connected.
    pub fn tx(&self) -> Option<MonitorCommandSender> {
        self.cmd_tx.read().ok().and_then(|g| g.clone())
    }

    /// The live command channel, or the error a command is answered with
    /// while the monitor is not connected.
    pub fn connected_tx(&self) -> Result<MonitorCommandSender, tmuxy_core::CommandError> {
        self.tx()
            .ok_or_else(|| tmuxy_core::CommandError::unavailable("monitor not connected"))
    }
}

/// Ask the running monitor to drop its current connection and reconnect to a
/// different socket/session. Stores the target and, if a connection is live,
/// sends a graceful `Shutdown` (detach-client) so `monitor.run()` returns and
/// the loop applies the target on its next pass. If nothing is connected yet,
/// the target still applies on the next connect attempt.
pub async fn request_reconnect(monitor_state: &MonitorState, target: ConnectTarget) {
    if let Ok(mut guard) = monitor_state.pending_reconnect.write() {
        *guard = Some(target);
    }
    // Attaching somewhere is the end of being detached — without this the
    // loop would park again the moment the new connection ended.
    if let Ok(mut guard) = monitor_state.detached.write() {
        *guard = false;
    }
    let cmd_tx = monitor_state.tx();
    if let Some(tx) = cmd_tx {
        let _ = tx.send(MonitorCommand::Shutdown).await;
    }
}

/// Detach this client: mark the monitor detached, then close the connection
/// gracefully. `run()` returns, the loop sees the flag and parks instead of
/// reconnecting, and the frontend gets `%exit detached` through
/// `emit_disconnected`. A later [`request_reconnect`] clears the flag and
/// revives the parked loop.
pub async fn request_detach(monitor_state: &MonitorState) {
    if let Ok(mut guard) = monitor_state.detached.write() {
        *guard = true;
    }
    let cmd_tx = monitor_state.tx();
    if let Some(tx) = cmd_tx {
        let _ = tx.send(MonitorCommand::Shutdown).await;
    }
}

/// Run one tmux command on a monitor's control-mode connection, dropping it if
/// that monitor is not connected. For the app's own housekeeping — a window
/// closing kills its session this way — where there is no client to report an
/// error to.
pub async fn run_on(monitor_state: &MonitorState, command: &str) {
    let cmd_tx = monitor_state.tx();
    if let Some(tx) = cmd_tx {
        let _ = tx
            .send(MonitorCommand::RunCommand {
                command: command.to_string(),
            })
            .await;
    }
}

/// Start control mode monitoring for the first GUI window's session.
pub async fn start_monitoring(app: AppHandle, monitor_state: MonitorState) {
    start_monitoring_window(app, "main".to_string(), monitor_state, get_session(), None).await
}

/// Start control mode monitoring for one GUI window.
///
/// `label` is the webview window the monitor feeds; `group_target`, when set,
/// names the session whose group `session` joins on the create path — a second
/// GUI window shares every window and pane with the first while keeping its own
/// current window (see `windows.rs`).
pub async fn start_monitoring_window(
    app: AppHandle,
    label: String,
    monitor_state: MonitorState,
    session: String,
    group_target: Option<String>,
) {
    let keeper = Arc::new(tmuxy_core::session_snapshot::SnapshotKeeper::new());
    let emitter = Arc::new(TauriEmitter::new(
        app.clone(),
        label.clone(),
        monitor_state.clone(),
        keeper.clone(),
    ));
    let snapshot_dir = tmuxy_core::session_snapshot::default_dir();
    let log_sink: Arc<dyn LogSink> = emitter.clone();

    // Start the tmux server in $HOME so the user's shell rc files cd to a
    // sensible cwd. Without this, a Finder/Spotlight launch hands tmuxy a cwd
    // of "/" (launchd default) which propagates into every new pane.
    let working_dir = std::env::var_os("HOME").map(std::path::PathBuf::from);

    // `mut` so a `tmuxy connect` reconnect can retarget the session in place.
    let mut config = MonitorConfig {
        session,
        create_session: true,
        group_target,
        // Adaptive throttling: emit immediately for low-frequency events (typing),
        // throttle at 16ms (~60fps) when high-frequency output detected
        throttle_interval: Duration::from_millis(16),
        working_dir,
        ..Default::default()
    };

    // Reconnect with exponential backoff, bounded by MAX_CONSECUTIVE_FAILURES.
    //
    // A "consecutive failure" is either:
    //   1. A connect attempt that returned Err, OR
    //   2. A connect that succeeded but whose monitor.run() returned within
    //      MIN_HEALTHY_DURATION — i.e. tmux died right after handshake.
    //
    // Case 2 is the macOS-Finder-launch failure mode: `connect()` reads the
    // first %end and reports "control mode connected successfully", but tmux
    // exits ~50ms later, sync_initial_state fails on broken pipe, and run()
    // returns silently. Without this guard, the failure counter resets every
    // cycle and the loop runs forever.
    //
    // Only durable connections (ran ≥ MIN_HEALTHY_DURATION) reset the counter.
    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    const MIN_HEALTHY_DURATION: Duration = Duration::from_secs(5);
    /// How often a parked monitor checks for a user-requested reconnect.
    const PARKED_POLL_INTERVAL: Duration = Duration::from_millis(500);

    let mut consecutive_failures: u32 = 0;
    // Set after MAX_CONSECUTIVE_FAILURES. The loop stays alive and waits for a
    // deliberate user reconnect rather than returning — see the parked block
    // at the top of the loop.
    let mut parked = false;

    loop {
        // Parked after giving up: wait for the user to ask for a different
        // server instead of returning. Returning left `request_reconnect`
        // writing a `pending_reconnect` that nothing would ever read, while
        // `connect_server` still returned Ok(()) — so after a transient tmux
        // flap the sidebar's server picker silently no-opped until the app
        // was relaunched. A deliberate reconnect is a legitimate revival path.
        if parked {
            loop {
                let has_pending = monitor_state
                    .pending_reconnect
                    .read()
                    .map(|g| g.is_some())
                    .unwrap_or(false);
                if has_pending {
                    break;
                }
                tokio::time::sleep(PARKED_POLL_INTERVAL).await;
            }
            parked = false;
            consecutive_failures = 0;
            backoff = Duration::from_millis(100);
            tracing::info!("reviving parked monitor for a user reconnect");
        }

        // Apply a pending `tmuxy connect` reconnect before connecting. Every
        // tmux call (the control-mode connection AND the one-off executor
        // commands) resolves its socket, session and ssh host from the
        // connect target, so installing it — one write, seen whole by every
        // thread — points the whole app at the new server. Reset the failure
        // counters: a deliberate switch is not a crash.
        let pending = monitor_state
            .pending_reconnect
            .write()
            .ok()
            .and_then(|mut g| g.take());
        if let Some(target) = pending {
            tmuxy_core::session::set_connect_target(target.clone());
            config.session = target.session.clone();
            backoff = Duration::from_millis(100);
            consecutive_failures = 0;
            tracing::info!(
                socket = %target.socket,
                session = %target.session,
                ssh = target.ssh.as_deref().unwrap_or("(local)"),
                "reconnecting"
            );
        }

        // A session about to be created may have a snapshot to come back
        // from, as on the web server (`sse.rs`).
        let mut connect_config = config.clone();
        let mut restore = if connect_config.create_session
            && !tmuxy_core::session::session_exists(&connect_config.session).unwrap_or(true)
        {
            transport::restore_plan(&snapshot_dir, &mut connect_config)
        } else {
            None
        };
        match TmuxMonitor::connect(connect_config, Some(&log_sink)).await {
            Ok((mut monitor, cmd_tx)) => {
                let autosave = if tmuxy_core::session_snapshot::autosave_disabled() {
                    None
                } else {
                    let keeper = keeper.clone();
                    let tx = cmd_tx.clone();
                    let dir = snapshot_dir.clone();
                    let name = config.session.clone();
                    Some(tokio::spawn(async move { keeper.run(name, dir, tx).await }))
                };
                if let Some(snapshot) = restore.take() {
                    let rebuild =
                        transport::restore_after_attach(snapshot, keeper.clone(), cmd_tx.clone());
                    let name = config.session.clone();
                    tokio::spawn(async move {
                        match rebuild.await {
                            Ok(()) => {
                                tracing::info!(session = %name, "session restored from snapshot")
                            }
                            Err(e) => {
                                tracing::warn!(session = %name, %e, "session restore stopped")
                            }
                        }
                    });
                }
                // Publish the live command channel so #[tauri::command]
                // handlers can route mutations through control mode instead
                // of spawning external tmux subprocesses (which races with
                // CC mode and crashes tmux 3.5a — surfaced to users as a
                // TransportError on actions like New Tab).
                if let Ok(mut guard) = monitor_state.cmd_tx.write() {
                    *guard = Some(cmd_tx);
                }
                let started = std::time::Instant::now();
                monitor.run(emitter.as_ref()).await;
                let lived = started.elapsed();
                if let Some(task) = autosave {
                    task.abort();
                }
                // Connection is gone — drop the stale sender so a command
                // is answered "monitor not connected" instead of being sent
                // into a dead channel.
                if let Ok(mut guard) = monitor_state.cmd_tx.write() {
                    *guard = None;
                }

                // The user detached. Park instead of reconnecting: a healthy
                // connection ending would otherwise reset the failure counters
                // and reattach on the next pass, putting them straight back in
                // the session they just stepped out of. The park loop already
                // waits for a deliberate reconnect, which is exactly the
                // revival the session switcher performs.
                let detached = monitor_state.detached.read().map(|g| *g).unwrap_or(false);
                if detached {
                    tracing::info!("detached by request — parking");
                    emit_detached(&app, &label);
                    parked = true;
                    continue;
                }

                // A `tmuxy connect` request drops the connection deliberately
                // (via Shutdown). Loop straight back to apply the new target —
                // this is not a failure, so skip the backoff/failure handling.
                let reconnect_pending = monitor_state
                    .pending_reconnect
                    .read()
                    .map(|g| g.is_some())
                    .unwrap_or(false);
                if reconnect_pending {
                    continue;
                }

                tracing::info!(?lived, consecutive_failures, "monitor run() returned");

                if lived >= MIN_HEALTHY_DURATION {
                    backoff = Duration::from_millis(100);
                    consecutive_failures = 0;
                } else {
                    consecutive_failures += 1;
                    let msg = format!(
                        "tmux connection died after {:?} (attempt {} of {})",
                        lived, consecutive_failures, MAX_CONSECUTIVE_FAILURES
                    );
                    emitter.emit_error(msg);

                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        let final_msg = format!(
                            "tmux disconnects immediately after handshake; giving up after {} attempts. Connection lived {:?} on the last try.",
                            MAX_CONSECUTIVE_FAILURES, lived
                        );
                        emit_fatal(&app, &label, &final_msg);
                        // "FATAL:" is what the smoke tests look for in the log file.
                        tracing::error!("FATAL: {final_msg}");
                        parked = true;
                        continue;
                    }
                }
            }
            Err(e) => {
                consecutive_failures += 1;
                emitter.emit_error(format!(
                    "Failed to connect to control mode (attempt {} of {}): {}",
                    consecutive_failures, MAX_CONSECUTIVE_FAILURES, e
                ));

                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    let final_msg = format!(
                        "Unable to connect to tmux after {} attempts; giving up. Last error: {}",
                        MAX_CONSECUTIVE_FAILURES, e
                    );
                    emit_fatal(&app, &label, &final_msg);
                    tracing::error!("FATAL: {final_msg}");
                    parked = true;
                    continue;
                }
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}
