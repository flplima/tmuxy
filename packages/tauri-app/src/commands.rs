use serde_json::Value;
use tauri::State;
use tmuxy_core::control_mode::MonitorCommand;
use tmuxy_core::{executor, session};

use crate::monitor::{KeyBindingsState, MonitorState};

/// Get session name from environment or use default
fn get_session() -> String {
    std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string())
}

#[tauri::command]
pub async fn send_keys_to_tmux(keys: String) -> Result<(), String> {
    executor::send_keys(&get_session(), &keys)
}

#[tauri::command]
pub async fn process_key(key: String) -> Result<(), String> {
    tmuxy_core::process_key(&get_session(), &key)
}

#[tauri::command]
pub async fn get_initial_state(cols: Option<u32>, rows: Option<u32>) -> Result<Value, String> {
    // Resize if dimensions provided
    if let (Some(c), Some(r)) = (cols, rows) {
        let _ = executor::resize_window(&get_session(), c, r);
    }

    let state = tmuxy_core::capture_window_state_for_session(&get_session())?;
    serde_json::to_value(state).map_err(|e| e.to_string())
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
    executor::resize_window(&get_session(), cols, rows)
}

#[tauri::command]
pub async fn initialize_session() -> Result<(), String> {
    session::create_or_attach(&get_session())
}

#[tauri::command]
pub async fn get_scrollback_history() -> Result<String, String> {
    executor::capture_pane_with_history(&get_session())
}

#[tauri::command]
pub async fn split_pane_horizontal() -> Result<(), String> {
    executor::split_pane_horizontal(&get_session())
}

#[tauri::command]
pub async fn split_pane_vertical() -> Result<(), String> {
    executor::split_pane_vertical(&get_session())
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
pub async fn select_pane(direction: String) -> Result<(), String> {
    executor::select_pane(&get_session(), &direction)
}

#[tauri::command]
pub async fn select_window(window: String) -> Result<(), String> {
    executor::select_window(&get_session(), &window)
}

#[tauri::command]
pub async fn next_window() -> Result<(), String> {
    executor::next_window(&get_session())
}

#[tauri::command]
pub async fn previous_window() -> Result<(), String> {
    executor::previous_window(&get_session())
}

#[tauri::command]
pub async fn kill_pane() -> Result<(), String> {
    executor::kill_pane(&get_session())
}

#[tauri::command]
pub async fn kill_window() -> Result<(), String> {
    executor::kill_window(&get_session())
}

#[tauri::command]
pub async fn select_pane_by_id(pane_id: String) -> Result<(), String> {
    executor::select_pane_by_id(&pane_id)
}

#[tauri::command]
pub async fn scroll_pane(pane_id: String, direction: String, amount: u32) -> Result<(), String> {
    executor::scroll_pane(&pane_id, &direction, amount)
}

#[tauri::command]
pub async fn send_mouse_event(
    pane_id: String,
    event_type: String,
    button: u32,
    x: u32,
    y: u32,
) -> Result<(), String> {
    executor::send_mouse_event(&pane_id, &event_type, button, x, y)
}

#[tauri::command]
pub async fn execute_prefix_binding(key: String) -> Result<(), String> {
    executor::execute_prefix_binding(&get_session(), &key)
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
            let rewrite = match size {
                Some((cols, rows)) => format!(
                    "splitw -t {} ; breakp ; resizew -x {} -y {} ; set-option -w @tmuxy-window-type tab",
                    session, cols, rows
                ),
                None => format!(
                    "splitw -t {} ; breakp ; set-option -w @tmuxy-window-type tab",
                    session
                ),
            };
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
    executor::run_tmux_command_for_session(&get_session(), &command)
}

/// Fetch a range of scrollback cells for copy mode.
///
/// Matches the SSE server's `get_scrollback_cells` command shape so the
/// frontend can use the same FETCH_SCROLLBACK_CELLS path under Tauri.
/// Without this command, copy mode in the Tauri build silently fails to
/// load anything beyond the already-visible pane content.
#[tauri::command]
pub async fn get_scrollback_cells(pane_id: String, start: i64, end: i64) -> Result<Value, String> {
    let width_output =
        executor::execute_tmux_command(&["display-message", "-t", &pane_id, "-p", "#{pane_width}"])
            .map_err(|e| format!("Failed to get pane width: {}", e))?;
    let width: u32 = width_output.trim().parse().unwrap_or(80);

    let history_output = executor::execute_tmux_command(&[
        "display-message",
        "-t",
        &pane_id,
        "-p",
        "#{history_size}",
    ])
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
pub async fn get_theme_settings() -> Result<Value, String> {
    let theme = executor::execute_tmux_command(&["show-options", "-gqv", "@tmuxy-theme"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mode = executor::execute_tmux_command(&["show-options", "-gqv", "@tmuxy-theme-mode"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "theme": if theme.is_empty() { "default".to_string() } else { theme },
        "mode": if mode.is_empty() { "dark".to_string() } else { mode },
    }))
}

#[tauri::command]
pub async fn set_theme(name: String, mode: Option<String>) -> Result<(), String> {
    executor::execute_tmux_command(&["set-option", "-g", "@tmuxy-theme", &name])
        .map_err(|e| format!("Failed to set theme: {}", e))?;
    if let Some(ref m) = mode {
        executor::execute_tmux_command(&["set-option", "-g", "@tmuxy-theme-mode", m])
            .map_err(|e| format!("Failed to set theme mode: {}", e))?;
    }
    // Persist to tmuxy.state.conf so the choice survives a tmux server
    // restart (e.g. fully quitting the app). Failure here is non-fatal —
    // the live tmux option is already set, just won't outlive the server.
    if let Err(e) = session::write_managed_state(Some(&name), mode.as_deref()) {
        eprintln!(
            "Warning: could not persist theme to tmuxy.state.conf: {}",
            e
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn set_theme_mode(mode: String) -> Result<(), String> {
    executor::execute_tmux_command(&["set-option", "-g", "@tmuxy-theme-mode", &mode])
        .map_err(|e| format!("Failed to set theme mode: {}", e))?;
    if let Err(e) = session::write_managed_state(None, Some(&mode)) {
        eprintln!(
            "Warning: could not persist theme mode to tmuxy.state.conf: {}",
            e
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn get_themes_list() -> Result<Value, String> {
    let themes_dir = session::config_dir().join("themes");
    let mut names: Vec<String> = std::fs::read_dir(&themes_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.strip_suffix(".css").map(|n| n.to_string())
        })
        .collect();
    names.sort();

    let themes: Vec<Value> = names
        .into_iter()
        .map(|name| {
            let display_name = name
                .split('-')
                .map(|word| {
                    let mut chars = word.chars();
                    match chars.next() {
                        None => String::new(),
                        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            serde_json::json!({ "name": name, "displayName": display_name })
        })
        .collect();

    Ok(serde_json::json!(themes))
}

#[tauri::command]
pub async fn resize_pane(
    pane_id: String,
    direction: String,
    adjustment: u32,
) -> Result<(), String> {
    executor::resize_pane(&pane_id, &direction, adjustment)
}

#[tauri::command]
pub async fn resize_window(cols: u32, rows: u32) -> Result<(), String> {
    executor::resize_window(&get_session(), cols, rows)
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
