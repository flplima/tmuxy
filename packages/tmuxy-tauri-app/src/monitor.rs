mod emitter;

use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::AppHandle;
use tmuxy_core::control_mode::{MonitorCommand, MonitorCommandSender, MonitorConfig};
use tmuxy_core::session_snapshot::SnapshotKeeper;
use tmuxy_core::transport::{self, Attempt, Ended, GaveUp, Host, Task};

use tmuxy_core::session::session_name as get_session;
/// Where `tmuxy connect` points the app: a tmux socket, a session (created if
/// missing) and the ssh host, if any. Installed through
/// `tmuxy_core::session::set_connect_target`, which every tmux invocation —
/// the control-mode connection and the one-off reads — resolves from.
pub use tmuxy_core::session::ConnectTarget;

pub use emitter::{
    apply_config_change, emit_config_settings, emit_theme_settings, lookup_image,
    poll_connect_requests, ImageStore, KeyBindingsState, TauriEmitter,
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
    let keeper = Arc::new(SnapshotKeeper::new());
    let emitter = Arc::new(TauriEmitter::new(
        app.clone(),
        label.clone(),
        monitor_state.clone(),
        keeper.clone(),
    ));

    // Start the tmux server in $HOME so the user's shell rc files cd to a
    // sensible cwd. Without this, a Finder/Spotlight launch hands tmuxy a cwd
    // of "/" (launchd default) which propagates into every new pane.
    let working_dir = std::env::var_os("HOME").map(std::path::PathBuf::from);

    let config = MonitorConfig {
        session,
        create_session: true,
        group_target,
        // Adaptive throttling: emit immediately for low-frequency events (typing),
        // throttle at 16ms (~60fps) when high-frequency output detected
        throttle_interval: Duration::from_millis(16),
        working_dir,
        ..Default::default()
    };
    let host = DesktopHost {
        app,
        label,
        monitor_state,
        config,
        parked: false,
    };
    transport::supervise(host, emitter, keeper, MIN_HEALTHY_RUN).await;
}

/// A connection that lived this long worked; a shorter one is the
/// macOS-Finder-launch failure mode: `connect()` reads the first `%end` and
/// reports success, tmux exits ~50ms later, and `run()` returns.
const MIN_HEALTHY_RUN: Duration = Duration::from_secs(5);

/// How often a parked monitor checks for a user-requested reconnect.
const PARKED_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// What the desktop app does around the monitor loop: it lives as long as
/// the app, parks instead of stopping, and follows `tmuxy connect` to another
/// server.
struct DesktopHost {
    app: AppHandle,
    label: String,
    monitor_state: MonitorState,
    /// `mut` so a `tmuxy connect` reconnect can retarget the session in place.
    config: MonitorConfig,
    /// Set after giving up, or after a detach. The loop stays alive and waits
    /// for a deliberate user reconnect rather than returning — returning left
    /// `request_reconnect` writing a `pending_reconnect` that nothing would
    /// ever read, while `connect_server` still returned Ok(()), so after a
    /// transient tmux flap the sidebar's server picker silently no-opped until
    /// the app was relaunched. A deliberate reconnect is a legitimate revival.
    parked: bool,
}

impl DesktopHost {
    fn reconnect_pending(&self) -> bool {
        self.monitor_state
            .pending_reconnect
            .read()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    fn set_channel(&self, tx: Option<MonitorCommandSender>) {
        if let Ok(mut guard) = self.monitor_state.cmd_tx.write() {
            *guard = tx;
        }
    }
}

impl Host for DesktopHost {
    async fn before_attempt(&mut self, _ever_ran: bool) -> Attempt {
        if self.parked {
            while !self.reconnect_pending() {
                tokio::time::sleep(PARKED_POLL_INTERVAL).await;
            }
            self.parked = false;
            tracing::info!("reviving parked monitor for a user reconnect");
        }

        // Apply a pending `tmuxy connect` reconnect before connecting. Every
        // tmux call (the control-mode connection AND the one-off executor
        // commands) resolves its socket, session and ssh host from the
        // connect target, so installing it — one write, seen whole by every
        // thread — points the whole app at the new server.
        let pending = self
            .monitor_state
            .pending_reconnect
            .write()
            .ok()
            .and_then(|mut g| g.take());
        if let Some(target) = pending {
            tmuxy_core::session::set_connect_target(target.clone());
            self.config.session = target.session.clone();
            tracing::info!(
                socket = %target.socket,
                session = %target.session,
                ssh = target.ssh.as_deref().unwrap_or("(local)"),
                "reconnecting"
            );
        }
        Attempt::Connect(self.config.clone())
    }

    /// A session that cannot be asked about is taken to exist: a restore is
    /// for a session known to be gone, never a guess.
    async fn session_exists(&self, session: &str) -> bool {
        tmuxy_core::session::SessionName::parse(session)
            .is_none_or(|name| tmuxy_core::session::session_exists(&name).unwrap_or(true))
    }

    /// Publish the live command channel so #[tauri::command] handlers can
    /// route mutations through control mode instead of spawning external tmux
    /// subprocesses (which races with CC mode and crashes tmux 3.5a — surfaced
    /// to users as a TransportError on actions like New Tab).
    async fn connected(&mut self, tx: MonitorCommandSender, _keeper: Arc<SnapshotKeeper>) -> bool {
        self.set_channel(Some(tx));
        true
    }

    async fn ended(&mut self) -> Ended {
        // Connection is gone — drop the stale sender so a command is answered
        // "monitor not connected" instead of being sent into a dead channel.
        self.set_channel(None);

        // The user detached. Park instead of reconnecting: a healthy
        // connection ending would otherwise reset the failure counters and
        // reattach on the next pass, putting them straight back in the session
        // they just stepped out of. The park already waits for a deliberate
        // reconnect, which is exactly the revival the session switcher performs.
        let detached = self
            .monitor_state
            .detached
            .read()
            .map(|g| *g)
            .unwrap_or(false);
        if detached {
            tracing::info!("detached by request — parking");
            emit_detached(&self.app, &self.label);
            self.parked = true;
            return Ended::Deliberate;
        }
        // A `tmuxy connect` request drops the connection deliberately (via
        // Shutdown): straight back to apply the new target.
        if self.reconnect_pending() {
            return Ended::Deliberate;
        }
        Ended::Judge
    }

    async fn gave_up(&mut self, message: String) -> GaveUp {
        emit_fatal(&self.app, &self.label, &message);
        // "FATAL:" is what the smoke tests look for in the log file.
        tracing::error!("FATAL: {message}");
        self.parked = true;
        GaveUp::Park
    }

    async fn spawn(&self, task: Task) {
        tokio::spawn(task);
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}
