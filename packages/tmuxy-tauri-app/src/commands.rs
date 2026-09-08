use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State};
use tmuxy_core::control_mode::MonitorCommand;
use tmuxy_core::{executor, Ctx};

use crate::monitor::{KeyBindingsState, MonitorState};
use crate::titlebar;

use tmuxy_core::session::session_name as get_session;

#[tauri::command]
pub async fn get_initial_state(
    state: State<'_, MonitorState>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<Value, String> {
    // Resize if dimensions provided
    if let (Some(c), Some(r)) = (cols, rows) {
        resize_via_monitor(&state, c, r).await;

        // Cache the viewport size so the FIRST `new-window` after startup sizes
        // the broken-out window to match the viewport. Otherwise `last_client_size`
        // stays None until a later resize fires `set_client_size`, and a tab
        // created before that inherits the half-width post-`splitw` size or the
        // 200x50 control-mode PTY default — appearing too small until the user
        // resizes the OS window. The SSE server populates client sizes here too.
        if let Ok(mut cached) = state.last_client_size.write() {
            *cached = Some((c, r));
        }
    }

    let snapshot = tmuxy_core::capture_window_state_for_session(&get_session())?;
    serde_json::to_value(snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_client_size(
    state: State<'_, MonitorState>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    // Cache the size so the next run_tmux_command("new-window") can size
    // the broken-out window to match the viewport. Without this the new
    // window inherits the half-width post-`splitw` size and looks tiny.
    if let Ok(mut size) = state.last_client_size.write() {
        *size = Some((cols, rows));
    }
    resize_via_monitor(&state, cols, rows).await;
    Ok(())
}

/// Ask the monitor to size the session's windows to the viewport — the same
/// `MonitorCommand::ResizeWindow` the web server sends. Before the monitor is
/// connected there is nothing to size yet; it replays the client size once
/// the window list lands (see `TmuxMonitor::apply_client_size`).
async fn resize_via_monitor(state: &State<'_, MonitorState>, cols: u32, rows: u32) {
    let cmd_tx = state.cmd_tx.read().ok().and_then(|g| g.clone());
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

#[tauri::command]
pub async fn run_tmux_command(
    app: tauri::AppHandle,
    state: State<'_, MonitorState>,
    command: String,
) -> Result<(), String> {
    // `source-file` may change the prefix, the theme or the appearance options:
    // push the fresh settings once tmux has applied it (same settle delay as
    // the SSE server's re-broadcast).
    let is_source_file = {
        let trimmed = command.trim_start();
        trimmed.starts_with("source-file") || trimmed.starts_with("source ")
    };
    let Some(routed) = route(&state, &command)? else {
        return Ok(());
    };
    send_via_monitor(&state, MonitorCommand::RunCommand { command: routed }).await?;
    if is_source_file {
        tokio::time::sleep(SOURCE_FILE_SETTLE).await;
        crate::monitor::emit_theme_settings(&app).await;
        if let Some(window) = app.get_webview_window("main") {
            crate::gui::apply_blur(&window);
        }
    }
    Ok(())
}

/// Run a tmux command and return what it printed — the one way the frontend
/// reads from tmux. Same route as a mutation, same connection; the reply is
/// the command's own output (`RunCommandWithReply`), and an `%error` from
/// tmux comes back as the Err.
#[tauri::command]
pub async fn query_tmux(state: State<'_, MonitorState>, command: String) -> Result<String, String> {
    let Some(routed) = route(&state, &command)? else {
        return Err("command not allowed".to_string());
    };
    query_via_monitor(&state, &routed).await
}

/// Run a command through the monitor and wait for what it printed. An
/// `%error` from tmux is the Err, carrying tmux's message.
async fn query_via_monitor(
    state: &State<'_, MonitorState>,
    command: &str,
) -> Result<String, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    send_via_monitor(
        state,
        MonitorCommand::RunCommandWithReply {
            command: command.to_string(),
            reply,
        },
    )
    .await?;
    rx.await
        .map_err(|_| "monitor went away before answering".to_string())?
        .into_result()
}

/// How long to wait after a `source-file` before re-reading tmux options.
const SOURCE_FILE_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// The shared policy (`tmuxy_core::command_router`): `None` for a blocked
/// command (logged, not an error — the web server answers those with null).
fn route(state: &State<'_, MonitorState>, command: &str) -> Result<Option<String>, String> {
    // Record the WHAT as the tmux verb (content-free; args only at trace level
    // `full`) — parity with the web server's send_via_control_mode.
    tracing::debug!(
        target: "tmuxy_tauri_app::commands",
        verb = command.split_whitespace().next().unwrap_or(""),
        command,
        "run command"
    );
    let size = state.last_client_size.read().ok().and_then(|g| *g);
    match tmuxy_core::command_router::route_command(command, &get_session(), size) {
        tmuxy_core::command_router::Route::Blocked(reason) => {
            tracing::warn!(target: "tmuxy_tauri_app::commands", command, reason, "blocked command");
            Ok(None)
        }
        tmuxy_core::command_router::Route::ControlMode(cmd) => Ok(Some(cmd)),
    }
}

/// Write to the monitor's command channel. Every tmux command the app runs
/// after connecting goes through here — there is no subprocess path: an
/// external `tmux` while the control-mode client is attached can crash tmux
/// 3.5a, and a client-less command has no current session to act on, which
/// is how a pinned split used to land on the wrong tab. Before the monitor
/// connects there is nothing to write to; the frontend only sends once
/// connected, so reaching this without a channel is a bug worth surfacing.
async fn send_via_monitor(
    state: &State<'_, MonitorState>,
    cmd: MonitorCommand,
) -> Result<(), String> {
    let cmd_tx = state.cmd_tx.read().ok().and_then(|g| g.clone());
    let Some(tx) = cmd_tx else {
        return Err("monitor not connected".to_string());
    };
    tx.send(cmd)
        .await
        .map_err(|e| format!("Monitor channel error: {}", e))
}

/// Fetch a range of scrollback cells for copy mode.
///
/// Matches the SSE server's `get_scrollback_cells` command shape so the
/// frontend can use the same FETCH_SCROLLBACK_CELLS path under Tauri.
/// Without this command, copy mode in the Tauri build silently fails to
/// load anything beyond the already-visible pane content.
#[tauri::command]
pub async fn get_scrollback_cells(
    ctx: State<'_, Arc<Ctx>>,
    pane_id: String,
    start: i64,
    end: i64,
) -> Result<Value, String> {
    let width_output = ctx
        .tmux_call(
            vec![
                "display-message".into(),
                "-t".into(),
                pane_id.clone(),
                "-p".into(),
                "#{pane_width}".into(),
            ],
            "get_pane_width",
        )
        .await
        .map_err(|e| format!("Failed to get pane width: {}", e))?;
    let width: u32 = width_output.trim().parse().unwrap_or(80);

    let history_output = ctx
        .tmux_call(
            vec![
                "display-message".into(),
                "-t".into(),
                pane_id.clone(),
                "-p".into(),
                "#{history_size}".into(),
            ],
            "get_history_size",
        )
        .await
        .map_err(|e| format!("Failed to get history size: {}", e))?;
    let history_size: u32 = history_output.trim().parse().unwrap_or(0);

    let raw = executor::capture_pane_range(&pane_id, start, end)
        .map_err(|e| format!("Failed to capture pane range: {}", e))?;

    let cells = tmuxy_core::parse_scrollback_to_cells(&raw, width);

    Ok(serde_json::json!({
        "cells": cells,
        "historySize": history_size,
        "start": start,
        "end": end,
        "width": width,
    }))
}

#[tauri::command]
pub async fn get_theme_settings(ctx: State<'_, Arc<Ctx>>) -> Result<Value, String> {
    Ok(tmuxy_core::theme::get_theme_settings(&ctx).await)
}

#[tauri::command]
pub async fn set_theme(
    ctx: State<'_, Arc<Ctx>>,
    name: String,
    mode: Option<String>,
) -> Result<(), String> {
    tmuxy_core::theme::set_theme(&ctx, &name, mode.as_deref()).await
}

#[tauri::command]
pub async fn set_theme_mode(ctx: State<'_, Arc<Ctx>>, mode: String) -> Result<(), String> {
    tmuxy_core::theme::set_theme_mode(&ctx, &mode).await
}

#[tauri::command]
pub async fn get_themes_list() -> Result<Value, String> {
    Ok(tmuxy_core::theme::get_themes_list())
}

/// Git worktree context for the sidebar tree, discovered from the cwd of
/// every pane on the socket (read through tmux, never supplied by the page).
/// The git subprocesses stay off Tauri's async runtime.
#[tauri::command]
pub async fn list_git_worktrees(state: State<'_, MonitorState>) -> Result<Value, String> {
    use tmuxy_core::worktrees::{list_git_worktrees, paths_from_pane_listing, LIST_PANE_PATHS_CMD};
    let listing = query_via_monitor(&state, LIST_PANE_PATHS_CMD).await?;
    let repositories = tauri::async_runtime::spawn_blocking(move || {
        list_git_worktrees(paths_from_pane_listing(&listing))
    })
    .await
    .map_err(|e| format!("worktree discovery task failed: {e}"))?
    .map_err(|e| e.to_string())?;
    serde_json::to_value(repositories).map_err(|e| e.to_string())
}

/// The status bar is the window's title bar; it reports its rendered height
/// (logical px) so the native window buttons stay centred on it.
///
/// `action_id` is the client's trace correlation id (docs/TELEMETRY.md).
#[tauri::command]
pub fn set_titlebar_height(window: tauri::WebviewWindow, height: f64, action_id: Option<String>) {
    titlebar::set_height(&window, height, action_id.as_deref());
}

/// Double-click on the status bar's empty space — the native title-bar gesture.
#[tauri::command]
pub fn titlebar_double_click(
    window: tauri::WebviewWindow,
    action_id: Option<String>,
) -> Result<(), String> {
    titlebar::double_click(&window, action_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_key_bindings() -> Result<Value, String> {
    let bindings = tmuxy_core::get_prefix_bindings()?;
    let prefix = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".to_string());
    Ok(serde_json::json!({
        "prefix": prefix,
        "bindings": bindings
    }))
}

/// Return the most recent `tmux-keybindings` payload, or null if the monitor
/// hasn't broadcast one yet. The frontend calls this on connect to recover
/// from the race where the backend emits before the WebView's listener is
/// attached.
#[tauri::command]
pub fn get_keybindings_snapshot(state: State<'_, KeyBindingsState>) -> Option<Value> {
    state.0.read().ok().and_then(|guard| guard.clone())
}

/// List the saved servers (localhost plus any added via `tmuxy connect`), read
/// fresh from `~/.config/tmuxy/servers.json`, along with the id of the server
/// the app is currently attached to. Powers the sidebar server picker — a
/// desktop-only surface; the web build always uses its launch socket.
#[tauri::command]
pub async fn list_servers() -> Result<Value, String> {
    let servers = tmuxy_core::servers::read_servers();
    let current = tmuxy_core::servers::current_server_id();
    Ok(serde_json::json!({
        "servers": servers,
        "currentId": current,
    }))
}

/// Reconnect the desktop app to a saved server by id: resolve it from
/// servers.json and ask the monitor to retarget its socket, SSH tunnel, and
/// session live (no relaunch). Routes through the same [`request_reconnect`]
/// path as `tmuxy connect <socket>`.
///
/// [`request_reconnect`]: crate::monitor::request_reconnect
#[tauri::command]
pub async fn connect_server(state: State<'_, MonitorState>, id: String) -> Result<(), String> {
    let server =
        tmuxy_core::servers::find_server(&id).ok_or_else(|| format!("unknown server '{id}'"))?;
    let (socket, ssh) = server.connect_env();
    let session = server.session.clone().unwrap_or_else(get_session);
    crate::monitor::request_reconnect(
        state.inner(),
        crate::monitor::ConnectTarget {
            socket,
            session,
            ssh,
        },
    )
    .await;
    Ok(())
}

/// Relaunch the desktop app in place (Debug ▸ Restart App). tmux keeps every
/// session; the new process reattaches to the same socket on start.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart()
}

/// Whether local action tracing is active on this desktop backend
/// (docs/TELEMETRY.md). The frontend tracer ships events only when this is true.
#[tauri::command]
pub fn trace_enabled() -> bool {
    tmuxy_core::trace::is_enabled()
}

/// Everything the Debug menu needs to render itself: the switch position, the
/// level, the file it writes to, and whether a `DO_NOT_TRACK` / `TMUXY_NO_TRACE`
/// kill switch forbids turning it on at all (in which case the UI shows the
/// control disabled rather than a switch that silently does nothing).
#[tauri::command]
pub fn get_trace_settings() -> Value {
    serde_json::json!({
        "enabled": tmuxy_core::trace::is_enabled(),
        "level": tmuxy_core::trace::level_name(),
        "path": tmuxy_core::trace::trace_path().map(|p| p.display().to_string()),
        "locked": tmuxy_core::trace::is_locked_off(),
    })
}

/// Turn tracing on or off and remember the choice. Returns the state actually
/// in force, which is `false` for an `enabled: true` request that the kill
/// switch refuses — the caller renders the answer, never its own request.
#[tauri::command]
pub fn set_trace_enabled(enabled: bool) -> bool {
    tmuxy_core::trace::set_enabled(enabled)
}

/// Set the level (`shape` | `labeled` | `full`) and remember it. An unknown
/// name resolves to `shape`, so a bad argument cannot raise sensitivity.
#[tauri::command]
pub fn set_trace_level(level: String) -> String {
    let level = tmuxy_core::trace::TraceLevel::parse(&level);
    tmuxy_core::trace::set_level_persisted(level);
    level.as_str().to_string()
}

/// Open the trace file in the OS default handler. Desktop-only by nature: the
/// file lives on the machine running the backend.
#[tauri::command]
pub fn open_trace_file() -> Result<(), String> {
    let path = tmuxy_core::trace::trace_path().ok_or("no trace file path could be resolved")?;
    if !path.exists() {
        return Err(format!("{} does not exist yet", path.display()));
    }
    open_path(&path)
}

/// Open a web link in the user's default browser.
///
/// The desktop webview never opens `target="_blank"` anchors on its own (a
/// new-window request is denied), so a click on an OSC 8 or auto-detected link
/// in a pane used to do nothing on the desktop. The frontend routes link clicks
/// here instead. Only web schemes are accepted: a pane can print any text, so
/// `file:` and custom schemes stay out.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !is_openable_url(url) {
        return Err(format!(
            "refusing to open {url:?}: only http(s) and mailto links"
        ));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {url}: {e}"))
}

/// Whether a link a pane printed may be handed to the browser.
pub(crate) fn is_openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod open_url_tests {
    use super::is_openable_url;

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

/// Hand a path to the desktop's default opener.
fn open_path(path: &std::path::Path) -> Result<(), String> {
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
        .map_err(|e| format!("could not open {}: {e}", path.display()))
}

/// Ingest a batch of client trace events into the shared NDJSON file. **Fails
/// closed**: dropped entirely when tracing is off, regardless of what the
/// frontend believes. Every event is re-sanitized by `record_client_event`
/// before it reaches the file, so no terminal content can slip through.
#[tauri::command]
pub fn record_trace(events: Vec<serde_json::Map<String, Value>>) {
    if !tmuxy_core::trace::is_enabled() {
        return;
    }
    for obj in events.into_iter().take(1000) {
        tmuxy_core::trace::record_client_event(obj);
    }
}
