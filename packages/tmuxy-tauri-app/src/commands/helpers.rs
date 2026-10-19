use tmuxy_core::command_router::Route;
use tmuxy_core::control_mode::MonitorCommand;
use tmuxy_core::transport;
use tmuxy_core::CommandError;

use crate::monitor::MonitorState;

/// The monitor's command channel, waiting for the monitor to finish
/// connecting if the webview asked first.
pub(super) async fn wait_for_monitor(
    state: &MonitorState,
) -> Result<tmuxy_core::control_mode::MonitorCommandSender, CommandError> {
    transport::wait_for_monitor(|| std::future::ready(state.tx())).await
}

/// Ask the monitor to size the session's windows to the viewport — the same
/// `MonitorCommand::ResizeWindow` the web server sends. Before the monitor is
/// connected there is nothing to size yet; it replays the client size once
/// the window list lands (see `TmuxMonitor::apply_client_size`).
pub(super) async fn resize_via_monitor(state: &MonitorState, cols: u32, rows: u32) {
    let cmd_tx = state.tx();
    match cmd_tx {
        Some(tx) => {
            if let Err(e) = tx.send(MonitorCommand::ResizeWindow { cols, rows }).await {
                tracing::warn!(target: "tmuxy_tauri_app::commands", error = %e, "resize not sent");
            }
        }
        None => {
            tracing::debug!(target: "tmuxy_tauri_app::commands", "no monitor yet, skipping resize")
        }
    }
}

/// Run a command through the monitor and wait for what it printed. An
/// `%error` from tmux is the Err, carrying tmux's message.
pub(super) async fn query_via_monitor(
    state: &MonitorState,
    command: &str,
) -> Result<String, CommandError> {
    transport::query(&state.connected_tx()?, command).await
}

/// The shared policy (`tmuxy_core::transport::route`): `None` for a blocked
/// command (logged, not an error — the web server answers those with null).
pub(super) fn route(state: &MonitorState, session: &str, command: &str) -> Option<String> {
    let size = state.last_client_size.read().ok().and_then(|g| *g);
    match transport::route(command, session, size) {
        Route::Blocked(reason) => {
            tracing::warn!(target: "tmuxy_tauri_app::commands", command, reason, "blocked command");
            None
        }
        Route::ControlMode(cmd) => Some(cmd),
    }
}

/// Write to the monitor's command channel. Once connected, the desktop
/// reaches tmux only over this channel — here, and through
/// `tmuxy_core::transport` for its reads: an external `tmux` while the
/// control-mode client is attached can crash tmux 3.5a, and a client-less
/// command has no current session to act on, which is how a pinned split used
/// to land on the wrong tab. Before the monitor connects there is nothing to
/// write to; the frontend only sends once connected, so reaching this without
/// a channel is a bug worth surfacing.
pub(super) async fn send_via_monitor(
    state: &MonitorState,
    cmd: MonitorCommand,
) -> Result<(), CommandError> {
    state
        .connected_tx()?
        .send(cmd)
        .await
        .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))
}

/// Whether a link a pane printed may be handed to the browser.
pub(crate) fn is_openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_control())
}

/// Hand a path to the desktop's default opener.
pub(super) fn open_path(path: &std::path::Path) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| CommandError::unavailable(format!("could not open {}: {e}", path.display())))
}

pub(super) async fn remove_server_json(id: &str) -> Result<serde_json::Value, CommandError> {
    let servers = tmuxy_core::servers::remove_server(id)
        .map_err(|e| CommandError::unavailable(format!("could not remove server: {e}")))?;
    let current = tmuxy_core::servers::current_server_id();
    Ok(serde_json::json!({
        "servers": servers,
        "currentId": current,
    }))
}

pub(super) async fn probe_server_json(
    state: Option<MonitorState>,
    id: String,
) -> Result<serde_json::Value, CommandError> {
    let current = tmuxy_core::servers::current_server_id();
    let live_sessions = if id == current {
        if let Some(st) = state {
            query_via_monitor(
                &st,
                "list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'",
            )
            .await
            .ok()
            .map(|out| tmuxy_core::servers::parse_session_list(&out))
        } else {
            None
        }
    } else {
        None
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let server = tmuxy_core::servers::find_server(&id)
            .ok_or_else(|| CommandError::invalid(format!("unknown server '{id}'")))?;
        Ok::<_, CommandError>(tmuxy_core::servers::probe_server(&server, live_sessions))
    })
    .await
    .map_err(|e| CommandError::unavailable(e.to_string()))??;
    serde_json::to_value(result).map_err(|e| CommandError::unavailable(e.to_string()))
}

#[cfg(test)]
mod open_url_tests {
    use super::super::open_url;
    use super::is_openable_url;

    /// A desktop command rejects with `{ error, kind }`, the shape the web
    /// server's `/commands` failures have.
    #[test]
    fn a_refused_link_rejects_with_kind_forbidden() {
        let err = open_url("file:///etc/passwd".to_string()).unwrap_err();
        let json = serde_json::to_value(&err).unwrap_or_default();
        assert_eq!(json["kind"], "forbidden");
        assert!(json["error"]
            .as_str()
            .is_some_and(|e| e.starts_with("refusing to open")));
    }

    #[test]
    fn only_web_links_are_openable() {
        assert!(is_openable_url("https://example.com/a?b=c"));
        assert!(is_openable_url("HTTP://EXAMPLE.COM"));
        assert!(is_openable_url("mailto:someone@example.com"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("ssh://host"));
        assert!(!is_openable_url("https://example.com/\u{1b}[31m"));
        assert!(!is_openable_url(""));
    }
}
