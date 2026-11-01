use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tmuxy_core::control_mode::{LogKind, LogSink, MonitorCommandSender, StateEmitter};
use tmuxy_core::transport::{self, KeyBindings};
use tmuxy_core::StateUpdate;

use tmuxy_core::session::session_name as get_session;

use super::{request_reconnect, ConnectTarget, MonitorState};

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
        // Mirrored to the log file so a bug report carries the *reason* a
        // connection died, which is otherwise only visible to the running UI
        // and gone on reconnect. A command or tmux's output is raw content:
        // `trace`, below the action trace's floor (docs/TRACING.md).
        match kind {
            LogKind::Error => tracing::warn!(target: "tmuxy_tauri_app::monitor", "{message}"),
            LogKind::Info => tracing::info!(target: "tmuxy_tauri_app::monitor", "{message}"),
            LogKind::Command | LogKind::Output => {
                tracing::trace!(target: "tmuxy_tauri_app::monitor", ?kind, "{message}")
            }
        }

        let payload = serde_json::json!({ "kind": kind, "message": message });
        if let Err(e) = self.app.emit_to(self.label.as_str(), "tmux-log", &payload) {
            tracing::warn!(error = %e, "could not emit log to the window");
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
            tracing::warn!(error = %e, "could not emit state to the window");
        }
    }

    fn emit_error(&self, error: String) {
        tracing::error!(target: "tmuxy_tauri_app::monitor", "{error}");
        if let Err(e) = self.app.emit_to(self.label.as_str(), "tmux-error", &error) {
            tracing::warn!(error = %e, "could not emit error to the window");
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
            tracing::warn!(error = %e, "could not emit detached to the window");
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
    /// payload via the WebView's navigator.clipboard. A native clipboard write
    /// from here would also work, but doing it in the WebView keeps the
    /// focus/transient activation context attached to the renderer, which is
    /// what some platforms require for clipboard access.
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
            tracing::warn!(error = %e, "could not emit clipboard to the window");
        }
    }

    /// A message tmux showed this client (`display-message`); the frontend
    /// puts it in the snackbar.
    fn show_message(&self, text: String) {
        let payload = serde_json::json!({ "text": text });
        if let Err(e) = self
            .app
            .emit_to(self.label.as_str(), "tmux-message", &payload)
        {
            tracing::warn!(error = %e, "could not emit message to the window");
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

/// Watch for `tmuxy connect` requests and reconnect the monitor when one
/// arrives. `tmuxy connect <socket> [session]` sets the `TMUXY_CONNECT_TO`
/// (and optional `TMUXY_CONNECT_SESSION` / `TMUXY_CONNECT_SSH`) tmux global env
/// vars on the current server; this task reads them and, when the target
/// differs from the current server, clears them and asks the monitor to
/// reconnect. Runs for the app's lifetime alongside [`super::start_monitoring`].
///
/// The reads and the clears ride the first window's control-mode connection,
/// so the watch only looks while that connection is live — during startup or
/// a reconnect there is nothing to read from, and nothing it could clear.
/// Ignore `TMUXY_CONNECT_*` global environment polling while attached to a
/// remote SSH tmux server so an untrusted process on that remote machine cannot
/// redirect the local desktop app onto a local socket or spawn an outbound SSH
/// connection from the user's workstation.
fn may_poll_connect_env(on_remote_ssh: bool) -> bool {
    !on_remote_ssh
}

pub async fn poll_connect_requests(monitor_state: MonitorState) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        if !may_poll_connect_env(tmuxy_core::session::ssh_target().is_some()) {
            continue;
        }
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

        // Anything on the server it is attached to (a remote host's, too)
        // can write these: a request is followed only when each part is a
        // plain name, so none of it can turn into an ssh option or a command.
        if !tmuxy_core::session::is_safe_socket(&socket)
            || !tmuxy_core::session::is_safe_session_name(&session)
            || ssh
                .as_deref()
                .is_some_and(|d| !tmuxy_core::session::is_ssh_destination(d))
        {
            tracing::warn!(
                "ignoring a connect request that is not a plain socket, session and host"
            );
            continue;
        }

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
pub(super) fn emit_fatal(app: &AppHandle, label: &str, message: &str) {
    let payload = serde_json::json!({ "message": message });
    if let Err(e) = app.emit_to(label, "tmux-fatal", &payload) {
        tracing::warn!(error = %e, "could not emit fatal to the window");
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
pub(super) fn emit_detached(app: &AppHandle, label: &str) {
    let payload = serde_json::json!({ "reason": "detached" });
    if let Err(e) = app.emit_to(label, "tmux-detached", &payload) {
        tracing::warn!(error = %e, "could not emit detached to the window");
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

/// What a user's edit under the config dir does to the running app, as the
/// web server does it: a saved stylesheet tells every webview to re-fetch
/// its CSS (`tmux-css-changed`); a saved `tmuxy.conf` is sourced on the
/// monitor and followed by the settings it may have changed.
pub async fn apply_config_change(
    app: &AppHandle,
    monitor: &MonitorState,
    change: transport::ConfigChange,
) {
    match change {
        transport::ConfigChange::Css => {
            if let Err(e) = app.emit("tmux-css-changed", ()) {
                tracing::warn!(error = %e, "could not announce the saved stylesheet");
            }
        }
        transport::ConfigChange::Conf => {
            let Some(tx) = monitor.tx() else {
                return;
            };
            match transport::source_config(&tx).await {
                Ok(()) => emit_config_settings(app, monitor).await,
                Err(e) => tracing::warn!(error = %e, "could not source the saved tmuxy.conf"),
            }
        }
    }
}

/// Push the theme + appearance settings so the frontend re-applies them, and
/// put every window's blur where `@tmuxy-blur` now says — none while
/// `@tmuxy-transparency` is off, since an opaque window shows no blur.
pub async fn emit_theme_settings(app: &AppHandle, tx: &MonitorCommandSender) {
    let settings = match tmuxy_core::theme::get_theme_settings(tx).await {
        Ok(settings) => settings,
        Err(e) => {
            tracing::warn!(error = %e, "theme settings unread");
            return;
        }
    };
    let appearance = &settings["appearance"];
    let blur = appearance["blur"].as_bool().unwrap_or(true)
        && appearance["transparency"].as_bool().unwrap_or(true);
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
        tracing::warn!(error = %e, "could not emit keybindings to the window");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::super::*;
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

    #[test]
    fn remote_ssh_server_cannot_drive_local_connect_polling() {
        assert!(super::may_poll_connect_env(false));
        assert!(!super::may_poll_connect_env(true));
    }
}
