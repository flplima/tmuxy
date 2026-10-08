use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tmuxy_core::control_mode::{
    LogKind, LogSink, MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter,
    TmuxMonitor,
};
use tmuxy_core::transport::{self, KeyBindings};
use tmuxy_core::StateUpdate;

use tmuxy_core::session::session_name as get_session;

/// A target for the monitor to (re)connect to: a tmux socket + session.
/// Drives `tmuxy connect` — live-switching the desktop app to a different
/// tmux server without relaunching.
#[derive(Clone, Debug)]
pub struct ConnectTarget {
    /// Socket name or full path, in the same form the `TMUX_SOCKET` env var
    /// accepts (a value with a `/` is a path → `-S`, else a name → `-L`).
    pub socket: String,
    /// Session to attach to (created if missing) on the target socket.
    pub session: String,
    /// SSH tunnel argv tail (the `TMUXY_SSH` value, e.g. `-p 2222 user@host`),
    /// or `None` for a local server. When set, the monitor and every executor
    /// read run tmux over `ssh` on the remote host.
    pub ssh: Option<String>,
}

/// Snapshot of the most recently broadcast keybindings.
///
/// Stored in Tauri-managed state so the frontend can fetch it on connect.
/// Without this, `app.emit("tmux-keybindings", …)` fires before the WebView
/// has subscribed via `listen()`, the event vanishes, and the frontend ends
/// up with an empty `prefixBindings` map — which is why the statusline
/// indicator was missing, prefix C-a + binding key did nothing, and
/// `Ctrl+hjkl` fell through to the shell instead of triggering nav.
pub struct KeyBindingsState(pub Arc<RwLock<Option<KeyBindings>>>);

impl Default for KeyBindingsState {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(None)))
    }
}

/// Decoded image bytes keyed by `(pane id, placement id)`.
pub type ImageStore = Arc<RwLock<tmuxy_core::transport::ImageStore>>;

/// Look up the picture behind a `tmuxyimg:` request path, which is
/// `<pane digits>/<placement id>` — the same pair the web build spells
/// `/api/images/<pane>/<id>`. The pane arrives without its `%` because a URL
/// host/path is a poor place for one.
pub fn lookup_image(
    images: &ImageStore,
    path: &str,
) -> Option<tmuxy_core::control_mode::StoredImage> {
    let (pane, id) = path.trim_matches('/').split_once('/')?;
    let pane = tmuxy_core::PaneId::parse(&format!("%{pane}")).ok()?;
    let id: u32 = id.parse().ok()?;
    images.read().ok()?.get(&pane, id).cloned()
}

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

/// Tauri emitter that broadcasts state changes to the frontend.
///
/// Every event is addressed to one window (`emit_to`), not the whole app: each
/// GUI window has its own monitor on its own session, so a broadcast would
/// cross the streams and paint one window with the other's state.
pub struct TauriEmitter {
    app: AppHandle,
    /// The webview window this monitor feeds (`main` for the first one).
    label: String,
    /// The window's monitor: its picture store, served back to the webview by
    /// the `tmuxyimg:` scheme (see `gui.rs`) as the web server serves
    /// `/api/images`, and its command channel, which the reads after the
    /// config is sourced go back through.
    monitor: MonitorState,
    /// Told of every change to the session's shape, so a snapshot follows it
    /// (`tmuxy_core::session_snapshot`), the same as the web server's emitter.
    keeper: Arc<tmuxy_core::session_snapshot::SnapshotKeeper>,
}

impl TauriEmitter {
    pub fn new(
        app: AppHandle,
        label: String,
        monitor: MonitorState,
        keeper: Arc<tmuxy_core::session_snapshot::SnapshotKeeper>,
    ) -> Self {
        Self {
            app,
            label,
            monitor,
            keeper,
        }
    }
}

impl LogSink for TauriEmitter {
    fn log(&self, kind: LogKind, message: String) {
        // Mirror to the persistent debug log so the user's "Copy Logs to
        // Clipboard" capture includes the *reason* a connection died.
        // Without this, sync_initial_state failures and broken-pipe errors
        // are only visible to the running UI and disappear on reconnect.
        let label = match kind {
            LogKind::Command => "CMD",
            LogKind::Output => "OUT",
            LogKind::Info => "INFO",
            LogKind::Error => "ERR",
        };
        tmuxy_core::debug_log::log(&format!("[monitor {}] {}", label, message));

        let payload = serde_json::json!({ "kind": kind, "message": message });
        if let Err(e) = self.app.emit_to(self.label.as_str(), "tmux-log", &payload) {
            eprintln!("Failed to emit log: {}", e);
        }
    }
}

impl StateEmitter for TauriEmitter {
    fn emit_state(&self, update: StateUpdate) {
        transport::on_state_update(&update, &self.keeper, |state| {
            if let Ok(mut guard) = self.monitor.images.try_write() {
                guard.retain_live_panes(state);
            }
        });
        if let Err(e) = self
            .app
            .emit_to(self.label.as_str(), "tmux-state-update", &update)
        {
            eprintln!("Failed to emit state: {}", e);
        }
    }

    fn emit_error(&self, error: String) {
        tmuxy_core::debug_log::log(&format!("[monitor ERR] {}", error));
        if let Err(e) = self.app.emit_to(self.label.as_str(), "tmux-error", &error) {
            eprintln!("Failed to emit error: {}", e);
        }
    }

    /// The connection ended, carrying tmux's `%exit` reason. The frontend uses
    /// it to tell a deliberate detach from a dropped link — the former shows
    /// the session switcher, the latter retries.
    fn emit_disconnected(&self, reason: Option<String>) {
        let payload = serde_json::json!({ "reason": reason });
        if let Err(e) = self
            .app
            .emit_to(self.label.as_str(), "tmux-detached", &payload)
        {
            eprintln!("Failed to emit detached: {}", e);
        }
    }

    fn store_images(
        &self,
        pane_id: &tmuxy_core::PaneId,
        images: Vec<(u32, tmuxy_core::control_mode::StoredImage)>,
    ) {
        // try_write so a contended lock never stalls the monitor loop; a
        // dropped picture is redrawn by the next frame.
        if let Ok(mut guard) = self.monitor.images.try_write() {
            guard.insert(pane_id, images);
        }
    }

    /// Forward an OSC 52 clipboard request to the frontend so it can write the
    /// payload via the WebView's navigator.clipboard. We could also use the
    /// tauri-plugin-clipboard-manager directly here, but doing it in the WebView
    /// keeps focus/transient activation context attached to the renderer, which
    /// is what some platforms require for clipboard access.
    fn write_clipboard(&self, pane_id: Option<&tmuxy_core::PaneId>, text: String) {
        if !tmuxy_core::transport::clipboard_write_allowed(&text) {
            tracing::debug!(
                ?pane_id,
                bytes = text.len(),
                "clipboard write over the cap, dropped"
            );
            return;
        }
        let pane_id = pane_id.map(|p| p.to_string()).unwrap_or_default();
        let payload = serde_json::json!({ "pane_id": pane_id, "text": text });
        if let Err(e) = self
            .app
            .emit_to(self.label.as_str(), "tmux-clipboard", &payload)
        {
            eprintln!("Failed to emit clipboard: {}", e);
        }
    }

    /// Re-emit keybindings after sync_initial_state has source-file'd
    /// the user's tmuxy.conf. Without this, the frontend latches the
    /// prefix it read before the config was sourced — which is the
    /// default C-b on a tmux server that already existed from a previous
    /// tmuxy run, even though our source-file just applied
    /// `set -g prefix C-a` server-globally. SseEmitter does the same thing
    /// in tmuxy-server/src/sse.rs.
    fn on_initial_sync_complete(&self) {
        let app = self.app.clone();
        let monitor = self.monitor.clone();
        tauri::async_runtime::spawn(async move { emit_config_settings(&app, &monitor).await });
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
            tmuxy_core::debug_log::log("[monitor] reviving parked monitor for a user reconnect");
        }

        // Apply a pending `tmuxy connect` reconnect before connecting. Because
        // every tmux call (the control-mode connection AND the one-off
        // executor commands) resolves its socket/session from the env, setting
        // these two vars is enough to point the whole app at the new server.
        // Reset the failure counters: a deliberate switch is not a crash.
        //
        // KNOWN RACE (tracked, not yet fixed): these three vars are mutated
        // here while #[tauri::command] handlers on other runtime threads read
        // them (get_session(), executor socket resolution). They are not set
        // atomically, so a command issued mid-switch can target the old server
        // with the new session (or vice versa); `set_var` alongside libc
        // `getenv` on another thread is also UB. The real fix is to hold an
        // explicit ConnectTarget in MonitorState that executor calls read,
        // replacing env-var-as-app-state.
        let pending = monitor_state
            .pending_reconnect
            .write()
            .ok()
            .and_then(|mut g| g.take());
        if let Some(target) = pending {
            std::env::set_var("TMUX_SOCKET", &target.socket);
            std::env::set_var("TMUXY_SESSION", &target.session);
            // TMUXY_SSH drives the ssh-wrapped invocation in tmuxy_core; unset
            // it for a local server so we don't keep tunneling to a stale host.
            match &target.ssh {
                Some(ssh) => std::env::set_var("TMUXY_SSH", ssh),
                None => std::env::remove_var("TMUXY_SSH"),
            }
            config.session = target.session.clone();
            backoff = Duration::from_millis(100);
            consecutive_failures = 0;
            tmuxy_core::debug_log::log(&format!(
                "[monitor] reconnecting to socket '{}' session '{}' ssh '{}'",
                target.socket,
                target.session,
                target.ssh.as_deref().unwrap_or("(local)")
            ));
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
                            Ok(()) => tmuxy_core::debug_log::log(&format!(
                                "[monitor] session '{name}' restored from snapshot"
                            )),
                            Err(e) => tmuxy_core::debug_log::log(&format!(
                                "[monitor] session '{name}' restore stopped: {e}"
                            )),
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
                    tmuxy_core::debug_log::log("[monitor] detached by request — parking");
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

                tmuxy_core::debug_log::log(&format!(
                    "[monitor] run() returned after {:?} (failures so far: {})",
                    lived, consecutive_failures
                ));

                if lived >= MIN_HEALTHY_DURATION {
                    backoff = Duration::from_millis(100);
                    consecutive_failures = 0;
                } else {
                    consecutive_failures += 1;
                    let msg = format!(
                        "tmux connection died after {:?} (attempt {} of {})",
                        lived, consecutive_failures, MAX_CONSECUTIVE_FAILURES
                    );
                    tmuxy_core::debug_log::log(&format!("[monitor] {}", msg));
                    emitter.emit_error(msg);

                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        let final_msg = format!(
                            "tmux disconnects immediately after handshake; giving up after {} attempts. Connection lived {:?} on the last try.",
                            MAX_CONSECUTIVE_FAILURES, lived
                        );
                        emit_fatal(&app, &label, &final_msg);
                        tmuxy_core::debug_log::log(&format!("[monitor] FATAL: {}", final_msg));
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
                    tmuxy_core::debug_log::log(&format!("[monitor] FATAL: {}", final_msg));
                    parked = true;
                    continue;
                }
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

/// Watch for `tmuxy connect` requests and reconnect the monitor when one
/// arrives. `tmuxy connect <socket> [session]` sets the `TMUXY_CONNECT_TO`
/// (and optional `TMUXY_CONNECT_SESSION` / `TMUXY_CONNECT_SSH`) tmux global env
/// vars on the current server; this task reads them and, when the target
/// differs from the current server, clears them and asks the monitor to
/// reconnect. Runs for the app's lifetime alongside [`start_monitoring`].
///
/// The reads and the clears ride the first window's control-mode connection,
/// so the watch only looks while that connection is live — during startup or
/// a reconnect there is nothing to read from, and nothing it could clear.
pub async fn poll_connect_requests(monitor_state: MonitorState) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let Some(tx) = monitor_state.tx() else {
            continue;
        };

        let Some(socket) = take_global_env(&tx, "TMUXY_CONNECT_TO").await else {
            continue;
        };
        let session = take_global_env(&tx, "TMUXY_CONNECT_SESSION")
            .await
            .unwrap_or_else(get_session);
        // Optional SSH tunnel for the target (absent → a local server).
        let ssh = take_global_env(&tx, "TMUXY_CONNECT_SSH").await;

        // No-op if we're already on this exact target (socket + session + ssh).
        let current_ssh = tmuxy_core::session::ssh_target().map(|v| v.join(" "));
        if socket == tmuxy_core::session::tmux_socket()
            && session == get_session()
            && ssh == current_ssh
        {
            continue;
        }

        request_reconnect(
            &monitor_state,
            ConnectTarget {
                socket,
                session,
                ssh,
            },
        )
        .await;
    }
}

/// Read a tmux global environment variable and unset it, so a request fires
/// once. `None` when it is unset or blank.
async fn take_global_env(tx: &MonitorCommandSender, name: &str) -> Option<String> {
    let out = tmuxy_core::transport::query(tx, &format!("show-environment -g {name}"))
        .await
        .ok()?;
    let _ = tmuxy_core::transport::run(tx, &format!("set-environment -g -u {name}")).await;
    let prefix = format!("{name}=");
    out.lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Emit a terminal failure event to the frontend.
/// The UI should treat this as a non-recoverable state — the monitor loop has
/// stopped and no further state updates will arrive.
fn emit_fatal(app: &AppHandle, label: &str, message: &str) {
    let payload = serde_json::json!({ "message": message });
    if let Err(e) = app.emit_to(label, "tmux-fatal", &payload) {
        eprintln!("Failed to emit fatal: {}", e);
    }
}

/// Tell the frontend this client detached, from the point where the loop parks.
///
/// NOT from the `%exit` arm, which is where this started: a control client that
/// detaches ITSELF gets a bare `%exit` with no reason — verified against tmux
/// 3.7c — and the loop has usually already returned by then, so that event may
/// never be dispatched at all. Here the intent is known from
/// `MonitorState.detached` rather than inferred from tmux's text, so it cannot
/// be missed or mistaken for a dropped link.
fn emit_detached(app: &AppHandle, label: &str) {
    let payload = serde_json::json!({ "reason": "detached" });
    if let Err(e) = app.emit_to(label, "tmux-detached", &payload) {
        eprintln!("Failed to emit detached: {}", e);
    }
}

/// Push everything a sourced config can change: the key bindings
/// (`tmux-keybindings`) and the theme + appearance settings
/// (`tmux-theme-settings`), read through the monitor, and the native blur the
/// appearance asks for. Mirrors the web server's `keybindings` and
/// `theme-settings` broadcasts. Called once the monitor has sourced the
/// config, and again after a client's `source-file`.
pub async fn emit_config_settings(app: &AppHandle, monitor: &MonitorState) {
    let Some(tx) = monitor.tx() else {
        return;
    };
    emit_keybindings(app, &tx).await;
    emit_theme_settings(app, &tx).await;
}

/// Push the theme + appearance settings so the frontend re-applies them, and
/// put every window's blur where `@tmuxy-blur` now says.
async fn emit_theme_settings(app: &AppHandle, tx: &MonitorCommandSender) {
    let settings = match tmuxy_core::theme::get_theme_settings(tx).await {
        Ok(settings) => settings,
        Err(e) => {
            tmuxy_core::debug_log::log(&format!("[monitor] theme settings unread: {e}"));
            return;
        }
    };
    let blur = settings["appearance"]["blur"].as_bool().unwrap_or(true);
    for window in app.webview_windows().values() {
        crate::gui::apply_blur(window, blur);
    }
    let _ = app.emit("tmux-theme-settings", settings);
}

/// Read the key bindings and emit them to the frontend.
///
/// Also stores them in `KeyBindingsState` so a frontend that connects after
/// the emit can still retrieve them via `get_keybindings_snapshot`.
async fn emit_keybindings(app: &AppHandle, tx: &MonitorCommandSender) {
    let bindings = KeyBindings::read(tx).await;
    if let Some(state) = app.try_state::<KeyBindingsState>() {
        if let Ok(mut guard) = state.0.write() {
            *guard = Some(bindings.clone());
        }
    }
    if let Err(e) = app.emit("tmux-keybindings", &bindings) {
        eprintln!("Failed to emit keybindings: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tmuxy_core::control_mode::StoredImage;

    fn store_with(pane: &str, id: u32) -> ImageStore {
        let store: ImageStore = Default::default();
        store.write().unwrap().insert(
            &tmuxy_core::PaneId::parse(pane).unwrap(),
            vec![(
                id,
                StoredImage {
                    data: vec![1, 2, 3],
                    mime_type: "image/png".to_string(),
                },
            )],
        );
        store
    }

    #[test]
    fn a_request_path_finds_the_picture_the_pane_drew() {
        let store = store_with("%3", 7);
        let found = lookup_image(&store, "/3/7").expect("the picture is served");
        assert_eq!(found.data, vec![1, 2, 3]);
        assert_eq!(found.mime_type, "image/png");
        // The leading slash is optional; the scheme handler may trim it first.
        assert!(lookup_image(&store, "3/7").is_some());
    }

    #[test]
    fn a_path_naming_nothing_we_hold_is_not_served() {
        let store = store_with("%3", 7);
        for path in ["/3/8", "/4/7", "/3", "//", "/3/x", "/%3/7", ""] {
            assert!(
                lookup_image(&store, path).is_none(),
                "{path} must not resolve"
            );
        }
    }
}
