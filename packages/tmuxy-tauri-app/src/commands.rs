use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use tmuxy_core::control_mode::MonitorCommand;
use tmuxy_core::{executor, Ctx};

use crate::monitor::{KeyBindingsState, MonitorState};

use tmuxy_core::session::session_name as get_session;

#[tauri::command]
pub async fn get_initial_state(
    state: State<'_, MonitorState>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<Value, String> {
    // Resize if dimensions provided
    if let (Some(c), Some(r)) = (cols, rows) {
        let _ = executor::resize_window(&get_session(), c, r);

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
    executor::resize_window(&get_session(), cols, rows).map_err(Into::into)
}

#[tauri::command]
pub async fn split_pane_horizontal() -> Result<(), String> {
    executor::split_pane_horizontal(&get_session()).map_err(Into::into)
}

#[tauri::command]
pub async fn new_window(state: State<'_, MonitorState>) -> Result<(), String> {
    // Reuse the same CC-routed rewrite as `run_tmux_command("new-window")`
    // so callers that hit this dedicated command don't slip back into the
    // external-subprocess path that races with control mode.
    run_tmux_command(state, "new-window".to_string())
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn run_tmux_command(
    state: State<'_, MonitorState>,
    command: String,
) -> Result<String, String> {
    // `new-window` (neww) crashes tmux 3.5a control mode when run as an external
    // subprocess while a control-mode client is attached. Tmuxy's monitor is one
    // such client. Rewrite to `split-window` + `break-pane -d`, which produces
    // the same window without the crash. Mirrors the same intercept in the SSE
    // server (packages/tmuxy-server/src/sse.rs).
    //
    // We push the rewrite through the monitor's CC connection — even the
    // intermediate split-window + break-pane subprocesses race with CC and
    // can crash the server (surfaced as a TransportError when the Tauri
    // invoke promise rejects). Going through the same connection that's
    // already attached avoids the race entirely.
    let trimmed = command.trim_start();
    if trimmed.starts_with("new-window") || trimmed.starts_with("neww") {
        let cmd_tx = state.cmd_tx.read().ok().and_then(|g| g.clone());
        if let Some(tx) = cmd_tx {
            let session = get_session();
            let size = state.last_client_size.read().ok().and_then(|g| *g);
            // Shared with the SSE server so the rewrite shape and the window
            // tag can't drift between transports; also quotes the session,
            // which can contain whitespace when it comes from servers.json.
            let rewrite = tmuxy_core::executor::new_window_rewrite(&session, size);
            tx.send(MonitorCommand::RunCommand { command: rewrite })
                .await
                .map_err(|e| format!("Monitor channel error: {}", e))?;
            return Ok(String::new());
        }
        // CC connection isn't up yet (very early startup). The external
        // path is the only option here; if it crashes tmux, the reconnect
        // loop will recover.
        executor::new_window(&get_session())?;
        return Ok(String::new());
    }

    // Multi-command batches (newline-joined) — e.g. the multiline-paste sequence
    // the keyboard actor builds (`send-keys -l 'line1'` / `send-keys Enter` / …)
    // — MUST go through the control-mode connection. tmux control mode reads each
    // line as a separate command, executing the batch atomically and in order. An
    // external `sh -c "tmux <batch>"` subprocess can't: only the first line gets a
    // `tmux` prefix, so the remaining `send-keys` lines are mangled into the shell
    // (the literal "send-keys …" text the user sees pasted on every linebreak).
    // The SSE server already routes these through `MonitorCommand::RunCommand`.
    if command.contains('\n') {
        let cmd_tx = state.cmd_tx.read().ok().and_then(|g| g.clone());
        if let Some(tx) = cmd_tx {
            tx.send(MonitorCommand::RunCommand { command })
                .await
                .map_err(|e| format!("Monitor channel error: {}", e))?;
            return Ok(String::new());
        }
        // CC connection isn't up yet — fall through to the external path, which
        // at least lands the first line rather than dropping the paste entirely.
    }

    executor::run_tmux_command_for_session(&get_session(), &command).map_err(Into::into)
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
