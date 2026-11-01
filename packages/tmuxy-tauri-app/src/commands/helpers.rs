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

/// The shared query policy (`tmuxy_core::transport::route_query`): `None`
/// for a query that would run anything but a read.
pub(super) fn route_query(command: &str) -> Option<String> {
    match transport::route_query(command) {
        Route::Blocked(reason) => {
            tracing::warn!(target: "tmuxy_tauri_app::commands", reason, "blocked query");
            None
        }
        Route::ControlMode(cmd) => Some(cmd),
    }
}

/// Whether a link a pane printed may be handed to the browser: a web or mail
/// link, with none of the characters a URL must percent-encode (whitespace,
/// quotes, `<>^`{}|\`), so an opener that reads it as text finds nothing to
/// parse in it.
pub(crate) fn is_openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\'' | '<' | '>' | '^' | '`' | '{' | '}' | '|' | '\\'
                )
        })
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        // What `cmd.exe` would read as its own syntax, were one in the way.
        assert!(is_openable_url("https://example.com/?a=1&b=2"));
        assert!(!is_openable_url("https://example.com/\"&calc.exe"));
        assert!(!is_openable_url("https://example.com/ x"));
        assert!(!is_openable_url("https://example.com/^|x"));
    }
}
