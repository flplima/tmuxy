mod emitter;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::AppHandle;
use tmuxy_core::control_mode::MonitorConfig;
use tmuxy_core::host::{self, Attempt, Ended, GaveUp, Host, HostEvent, SessionRuntime, Task};

/// Where `tmuxy connect` points the app: a tmux socket, a session (created if
/// missing) and the ssh host, if any. Installed through
/// `tmuxy_core::session::set_connect_target`, which every tmux invocation —
/// the control-mode connection and the one-off reads — resolves from.
pub use tmuxy_core::session::ConnectTarget;

pub use emitter::{poll_connect_requests, TauriSink};

/// A window's monitor: its session's runtime (`tmuxy_core::host`), and what
/// the desktop decides around the loop — a pending reconnect, a detach.
#[derive(Clone)]
pub struct Monitor {
    pub runtime: Arc<SessionRuntime>,
    control: Arc<Control>,
}

#[derive(Default)]
struct Control {
    /// The session (and the group it joins) a `tmuxy connect` moves this
    /// window to, applied at the top of the loop's next pass.
    pending: RwLock<Option<(String, Option<String>)>>,
    /// The user asked to step away: when the connection ends the loop parks
    /// rather than reconnects. Without it a detach is indistinguishable from
    /// a flap — the loop sees a healthy connection end and reattaches,
    /// putting the user straight back in the session they just left.
    detached: AtomicBool,
    /// What a parked loop waits on: a reconnect wakes it.
    revive: tokio::sync::Notify,
}

impl Monitor {
    pub fn new(runtime: Arc<SessionRuntime>) -> Self {
        Self {
            runtime,
            control: Arc::default(),
        }
    }

    /// Move this window to `session` (joining `group`'s windows when set) on
    /// the next pass of its loop: the live connection is ended, a parked
    /// loop woken.
    async fn reconnect_to(&self, session: String, group: Option<String>) {
        *self
            .control
            .pending
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some((session, group));
        // Attaching somewhere is the end of being detached — without this the
        // loop would park again the moment the new connection ended.
        self.control.detached.store(false, Ordering::SeqCst);
        self.control.revive.notify_one();
        self.runtime.shut_down_connection().await;
    }

    pub async fn detach(&self) {
        self.control.detached.store(true, Ordering::SeqCst);
        self.runtime.shut_down_connection().await;
    }

    fn reconnect_pending(&self) -> bool {
        self.control
            .pending
            .read()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }
}

/// Point the app at another tmux server. Every window moves: they are
/// members of one session group on one server, and a window left behind
/// would answer its one-off reads from the new server while its client sat
/// on the old one. The first window takes the target's session; window `N`
/// joins it as `<session>+N`.
pub async fn request_reconnect(app: &AppHandle, target: ConnectTarget) {
    tracing::info!(
        socket = %target.socket,
        session = %target.session,
        ssh = target.ssh.as_deref().unwrap_or("(local)"),
        "reconnecting"
    );
    tmuxy_core::session::set_connect_target(target.clone());
    for window in crate::windows::list_all(app) {
        let (session, group) = if window.label == crate::windows::MAIN_LABEL {
            (target.session.clone(), None)
        } else {
            (
                format!("{}+{}", target.session, window.index),
                Some(target.session.clone()),
            )
        };
        window.monitor.reconnect_to(session, group).await;
    }
}

/// Run one tmux command on a monitor's control-mode connection, dropping it if
/// that monitor is not connected. For the app's own housekeeping — a window
/// closing kills its session this way — where there is no client to report an
/// error to.
pub async fn run_on(monitor: &Monitor, command: &str) {
    if let Some(tx) = monitor.runtime.tx_now() {
        if let Err(e) = tmuxy_core::control_mode::run(&tx, command).await {
            tracing::warn!(error = %e, "housekeeping command not sent");
        }
    }
}

/// `group_target`, when set, names the session whose group the window's
/// session joins on the create path — a second GUI window shares every
/// window and pane with the first while keeping its own current window (see
/// `windows.rs`).
pub async fn start_monitoring_window(monitor: Monitor, group_target: Option<String>) {
    let session = monitor.runtime.session();
    let config = MonitorConfig {
        group_target,
        // The desktop's frames go to a webview in the same process, so it
        // can afford twice the web's rate during bulk output (~60fps); the
        // web's cross a network as JSON, to a phone as often as not.
        throttle_interval: Duration::from_millis(16),
        ..host::monitor_config(&session, true)
    };
    let runtime = Arc::clone(&monitor.runtime);
    let desktop = DesktopHost {
        monitor,
        config,
        parked: false,
    };
    host::supervise(desktop, runtime).await;
}

/// What the desktop app does around the monitor loop: it lives as long as
/// the window, parks instead of stopping, and follows `tmuxy connect` to
/// another server.
struct DesktopHost {
    monitor: Monitor,
    /// Retargeted in place by a `tmuxy connect` reconnect.
    config: MonitorConfig,
    /// Set after giving up, or after a detach. The loop stays alive and waits
    /// for a deliberate user reconnect rather than returning — returning left
    /// a reconnect request that nothing would ever read, so after a transient
    /// tmux flap the server picker silently did nothing until the app was
    /// relaunched.
    parked: bool,
}

impl Host for DesktopHost {
    async fn before_attempt(&mut self, _ever_ran: bool) -> Attempt {
        if self.parked {
            while !self.monitor.reconnect_pending() {
                self.monitor.control.revive.notified().await;
            }
            self.parked = false;
            tracing::info!("reviving parked monitor for a user reconnect");
        }
        let pending = self
            .monitor
            .control
            .pending
            .write()
            .ok()
            .and_then(|mut g| g.take());
        if let Some((session, group)) = pending {
            self.monitor.runtime.set_session(session.clone());
            self.config.session = session;
            self.config.group_target = group;
        }
        Attempt::Connect(self.config.clone())
    }

    async fn ended(&mut self) -> Ended {
        // The user detached. Park instead of reconnecting; the park already
        // waits for a deliberate reconnect, which is exactly the revival the
        // session switcher performs.
        if self.monitor.control.detached.load(Ordering::SeqCst) {
            tracing::info!("detached by request — parking");
            // Said from here rather than from tmux's `%exit`: a control client
            // that detaches ITSELF gets a bare `%exit` with no reason (tmux
            // 3.7c), and the loop has usually returned before it is read.
            self.monitor.runtime.emit(HostEvent::Detached {
                reason: Some("detached".to_string()),
            });
            self.parked = true;
            return Ended::Parked;
        }
        // A `tmuxy connect` request drops the connection deliberately (via
        // Shutdown): straight back to apply the new target.
        if self.monitor.reconnect_pending() {
            return Ended::Deliberate;
        }
        Ended::Judge
    }

    async fn gave_up(&mut self, message: String) -> GaveUp {
        self.monitor.runtime.emit(HostEvent::Fatal {
            message: message.clone(),
        });
        // "FATAL:" is what the smoke tests look for in the log file.
        tracing::error!("FATAL: {message}");
        self.parked = true;
        GaveUp::Park
    }

    async fn spawn(&self, task: Task) {
        tauri::async_runtime::spawn(task);
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// The app is going: the last snapshot of every window's session, before
/// the process ends — a change still on the autosave's debounce would be
/// lost otherwise.
pub async fn save_snapshots(app: &AppHandle) {
    for window in crate::windows::list_all(app) {
        window
            .monitor
            .runtime
            .save_snapshot_now(FINAL_SNAPSHOT_TIMEOUT)
            .await;
    }
}

/// How long the last snapshot of a session may take before quitting goes on
/// without it.
const FINAL_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);
