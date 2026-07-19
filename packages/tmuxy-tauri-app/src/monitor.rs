use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tmuxy_core::control_mode::{
    LogKind, LogSink, MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter,
    TmuxMonitor,
};
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
pub struct KeyBindingsState(pub Arc<RwLock<Option<serde_json::Value>>>);

impl Default for KeyBindingsState {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(None)))
    }
}

/// Live handle to the running control-mode monitor.
///
/// `cmd_tx` is the channel for issuing tmux mutations through the existing
/// CC connection. Spawning external `tmux <cmd>` while CC is attached crashes
/// tmux 3.5a — see CLAUDE.md and `docs/TMUX.md`. The SSE server avoids this
/// by routing every mutation through `MonitorCommand::RunCommand`; the Tauri
/// app now does the same.
///
/// `last_client_size` is the most recent viewport size the frontend reported.
/// `run_tmux_command` uses it when rewriting `new-window` so the broken-out
/// window matches the visible viewport instead of inheriting the half-width
/// post-`splitw` size or the 200x50 control-mode PTY default.
#[derive(Clone, Default)]
pub struct MonitorState {
    pub cmd_tx: Arc<RwLock<Option<MonitorCommandSender>>>,
    pub last_client_size: Arc<RwLock<Option<(u32, u32)>>>,
    /// A pending `tmuxy connect` request. The monitor loop applies it at the
    /// top of its next iteration (switching sockets/session); a live
    /// connection is interrupted with a graceful `Shutdown` so the loop gets
    /// there promptly. See [`request_reconnect`].
    pub pending_reconnect: Arc<RwLock<Option<ConnectTarget>>>,
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
    let cmd_tx = monitor_state.cmd_tx.read().ok().and_then(|g| g.clone());
    if let Some(tx) = cmd_tx {
        let _ = tx.send(MonitorCommand::Shutdown).await;
    }
}

/// Tauri emitter that broadcasts state changes to the frontend
pub struct TauriEmitter {
    app: AppHandle,
}

impl TauriEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
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
        if let Err(e) = self.app.emit("tmux-log", &payload) {
            eprintln!("Failed to emit log: {}", e);
        }
    }
}

impl StateEmitter for TauriEmitter {
    fn emit_state(&self, update: StateUpdate) {
        if let Err(e) = self.app.emit("tmux-state-update", &update) {
            eprintln!("Failed to emit state: {}", e);
        }
    }

    fn emit_error(&self, error: String) {
        tmuxy_core::debug_log::log(&format!("[monitor ERR] {}", error));
        if let Err(e) = self.app.emit("tmux-error", &error) {
            eprintln!("Failed to emit error: {}", e);
        }
    }

    /// Forward an OSC 52 clipboard request to the frontend so it can write the
    /// payload via the WebView's navigator.clipboard. We could also use the
    /// tauri-plugin-clipboard-manager directly here, but doing it in the WebView
    /// keeps focus/transient activation context attached to the renderer, which
    /// is what some platforms require for clipboard access.
    fn write_clipboard(&self, pane_id: &str, text: String) {
        let payload = serde_json::json!({ "pane_id": pane_id, "text": text });
        if let Err(e) = self.app.emit("tmux-clipboard", &payload) {
            eprintln!("Failed to emit clipboard: {}", e);
        }
    }

    /// Re-emit keybindings after sync_initial_state has source-file'd
    /// the user's tmuxy.conf. Without this, the frontend latches the
    /// prefix it read at start_monitoring time (before the config was
    /// sourced) — which is the default C-b on a tmux server that
    /// already existed from a previous tmuxy run, even though our
    /// source-file just applied `set -g prefix C-a` server-globally.
    /// SseEmitter does the same thing in tmuxy-server/src/sse.rs.
    fn on_initial_sync_complete(&self) {
        emit_keybindings(&self.app);
    }
}

/// Start control mode monitoring for tmux state changes
pub async fn start_monitoring(app: AppHandle, monitor_state: MonitorState) {
    let emitter = Arc::new(TauriEmitter::new(app.clone()));
    let log_sink: Arc<dyn LogSink> = emitter.clone();
    let session = get_session();

    // Start the tmux server in $HOME so the user's shell rc files cd to a
    // sensible cwd. Without this, a Finder/Spotlight launch hands tmuxy a cwd
    // of "/" (launchd default) which propagates into every new pane.
    let working_dir = std::env::var_os("HOME").map(std::path::PathBuf::from);

    // `mut` so a `tmuxy connect` reconnect can retarget the session in place.
    let mut config = MonitorConfig {
        session,
        sync_interval: Duration::from_millis(500),
        create_session: true,
        // Adaptive throttling: emit immediately for low-frequency events (typing),
        // throttle at 16ms (~60fps) when high-frequency output detected
        throttle_interval: Duration::from_millis(16),
        throttle_threshold: 20,
        rate_window: Duration::from_millis(100),
        working_dir,
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

    // Build once and clone the Arc per reconnect attempt — the live ctx is
    // cheap to share and lets the Tauri app participate in the same Ctx
    // substitution that tests use elsewhere.
    let ctx = tmuxy_core::Ctx::live();

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
        // explicit ConnectTarget in MonitorState/Ctx that executor calls read,
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

        match TmuxMonitor::connect(config.clone(), Some(&log_sink), ctx.clone()).await {
            Ok((mut monitor, cmd_tx)) => {
                // Publish the live command channel so #[tauri::command]
                // handlers can route mutations through control mode instead
                // of spawning external tmux subprocesses (which races with
                // CC mode and crashes tmux 3.5a — surfaced to users as a
                // TransportError on actions like New Tab).
                if let Ok(mut guard) = monitor_state.cmd_tx.write() {
                    *guard = Some(cmd_tx);
                }
                emit_keybindings(&app);
                let started = std::time::Instant::now();
                monitor.run(emitter.as_ref()).await;
                let lived = started.elapsed();
                // Connection is gone — drop the stale sender so the next
                // mutation falls back to the external path instead of
                // sending into a dead channel.
                if let Ok(mut guard) = monitor_state.cmd_tx.write() {
                    *guard = None;
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
                        emit_fatal(&app, &final_msg);
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
                    emit_fatal(&app, &final_msg);
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
/// (and optional `TMUXY_CONNECT_SESSION`) tmux global env vars on the current
/// server; this task reads them and, when the target differs from the current
/// server, clears them and asks the monitor to reconnect. Runs for the app's
/// lifetime alongside [`start_monitoring`].
///
/// Only polls while a connection is live (`cmd_tx` present) so it never spawns
/// tmux subprocesses during startup or an in-progress reconnect. The read is
/// via `show-environment` on the current socket — a read-only external call,
/// safe alongside control mode on the targeted tmux 3.7a (the app already uses
/// external executor calls for reads elsewhere).
pub async fn poll_connect_requests(monitor_state: MonitorState) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;

        // Skip unless a connection is live — nothing to reconnect from, and we
        // avoid spawning subprocesses mid-reconnect.
        if monitor_state
            .cmd_tx
            .read()
            .map(|g| g.is_none())
            .unwrap_or(true)
        {
            continue;
        }

        let Some(socket) = read_global_env("TMUXY_CONNECT_TO") else {
            continue;
        };
        let socket = socket.trim().to_string();
        if socket.is_empty() {
            continue;
        }

        // Clear the request vars on the current server so the switch fires once.
        let _ = tmuxy_core::executor::execute_tmux_command(&[
            "set-environment",
            "-g",
            "-u",
            "TMUXY_CONNECT_TO",
        ]);
        let session = read_global_env("TMUXY_CONNECT_SESSION")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(get_session);
        let _ = tmuxy_core::executor::execute_tmux_command(&[
            "set-environment",
            "-g",
            "-u",
            "TMUXY_CONNECT_SESSION",
        ]);
        // Optional SSH tunnel for the target (absent → a local server).
        let ssh = read_global_env("TMUXY_CONNECT_SSH")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let _ = tmuxy_core::executor::execute_tmux_command(&[
            "set-environment",
            "-g",
            "-u",
            "TMUXY_CONNECT_SSH",
        ]);

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

/// Read a tmux global environment variable via `show-environment -g <name>`,
/// returning its value (the part after `NAME=`), or `None` when unset.
fn read_global_env(name: &str) -> Option<String> {
    let out = tmuxy_core::executor::execute_tmux_command(&["show-environment", "-g", name]).ok()?;
    let prefix = format!("{name}=");
    out.lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(|v| v.to_string())
}

/// Emit a terminal failure event to the frontend.
/// The UI should treat this as a non-recoverable state — the monitor loop has
/// stopped and no further state updates will arrive.
fn emit_fatal(app: &AppHandle, message: &str) {
    let payload = serde_json::json!({ "message": message });
    if let Err(e) = app.emit("tmux-fatal", &payload) {
        eprintln!("Failed to emit fatal: {}", e);
    }
}

/// Emit keybindings to the frontend after a successful connection.
///
/// Also stores the payload in `KeyBindingsState` so a frontend that connects
/// after the emit can still retrieve them via `get_keybindings_snapshot`.
fn emit_keybindings(app: &AppHandle) {
    let prefix_key = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".into());
    let prefix_bindings = tmuxy_core::get_prefix_bindings().unwrap_or_default();
    let root_bindings = tmuxy_core::get_root_bindings().unwrap_or_default();

    let payload = serde_json::json!({
        "prefix_key": prefix_key,
        "prefix_bindings": prefix_bindings,
        "root_bindings": root_bindings,
    });

    if let Some(state) = app.try_state::<KeyBindingsState>() {
        if let Ok(mut guard) = state.0.write() {
            *guard = Some(payload.clone());
        }
    }

    if let Err(e) = app.emit("tmux-keybindings", &payload) {
        eprintln!("Failed to emit keybindings: {}", e);
    }
}
