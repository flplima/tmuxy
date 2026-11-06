use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tmuxy_core::control_mode::MonitorCommandSender;
use tmuxy_core::host::{HostEvent, Sink};
use tmuxy_core::servers::connect::{ConnectRequest, CONNECT_REQUEST};
use tmuxy_core::theme::ThemeSettings;

use super::{request_reconnect, ConnectTarget};

/// Where a window's events go: that window alone (`emit_to`), never the whole
/// app — each GUI window has its own monitor on its own session, so a
/// broadcast would cross the streams and paint one window with the other's
/// state.
pub struct TauriSink {
    pub app: AppHandle,
    /// The webview window this monitor feeds (`main` for the first one).
    pub label: String,
}

impl Sink for TauriSink {
    fn emit(&self, event: HostEvent) {
        if let Err(e) = self
            .app
            .emit_to(self.label.as_str(), event.name(), event.data())
        {
            tracing::warn!(error = %e, event = event.name(), "could not emit to the window");
        }
    }

    /// The window's blur where `@tmuxy-blur` says — none while
    /// `@tmuxy-transparency` is off, since an opaque window shows no blur —
    /// and the two-finger slide where `@tmuxy-gesture-swipe-tabs` says
    /// (docs/DESKTOP.md: the shell claims the slide only while it is on).
    fn appearance(&self, settings: &ThemeSettings) {
        let appearance = &settings.appearance;
        if let Some(window) = self.app.get_webview_window(&self.label) {
            crate::gui::apply_blur(&window, appearance.blur && appearance.transparency);
        }
        crate::gestures::set_swipe_tabs(appearance.gesture_swipe_tabs);
    }
}

const CONNECT_POLL: Duration = Duration::from_secs(2);

/// Watch for `tmuxy connect` requests and reconnect the app when one
/// arrives. `tmuxy connect <socket> [session]` and `tmuxy session connect`
/// write one request (`tmuxy_core::servers::connect`) into the current
/// server's global environment; this task reads it and, when the target
/// differs from the current server, clears it and moves every window there
/// (`request_reconnect`). Runs for the app's lifetime.
///
/// The reads and the clears ride a window's live control-mode connection —
/// the first one that has one; with none there is nothing to read from, and
/// nothing it could clear. Never while attached to a remote SSH tmux server:
/// an untrusted process on that machine could otherwise redirect the local
/// app onto a local socket, or make it open an outbound SSH connection from
/// the user's workstation.
pub async fn poll_connect_requests(app: AppHandle) {
    let mut tick = tokio::time::interval(CONNECT_POLL);
    loop {
        tick.tick().await;
        if tmuxy_core::session::ssh_target().is_some() {
            continue;
        }
        let Some(tx) = crate::windows::list_all(&app)
            .iter()
            .find_map(|window| window.monitor.runtime.tx_now())
        else {
            continue;
        };

        let Some(value) = take_global_env(&tx, CONNECT_REQUEST).await else {
            continue;
        };
        // Anything on the server it is attached to can write the request: it
        // is followed only when each part is a plain name, so none of it can
        // turn into an ssh option or a command.
        let Some(request) = ConnectRequest::decode(&value) else {
            tracing::warn!(
                "ignoring a connect request that is not a plain socket, session and host"
            );
            continue;
        };
        let ConnectRequest {
            socket,
            session,
            ssh,
        } = request;
        let session = session.unwrap_or_else(tmuxy_core::session::session_name);

        let current_ssh = tmuxy_core::session::ssh_target().map(|v| v.join(" "));
        let current_session = crate::windows::base_session(&app);
        if socket == tmuxy_core::session::tmux_socket()
            && session == current_session
            && ssh == current_ssh
        {
            continue;
        }

        request_reconnect(
            &app,
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
    if let Err(e) = tmuxy_core::transport::run(tx, &format!("set-environment -g -u {name}")).await {
        // Left set, the same request would fire again on every poll.
        tracing::warn!(error = %e, name, "could not clear a connect request; ignoring it");
        return None;
    }
    let prefix = format!("{name}=");
    out.lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}
