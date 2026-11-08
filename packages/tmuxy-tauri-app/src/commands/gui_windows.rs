//! The GUI windows: opening, focusing, closing and listing them, and a new
//! window's splash page — the sessions on this machine to join, or an ssh
//! host to attach to (`windows/attach.rs`).

use serde_json::Value;
use tmuxy_core::CommandError;

use crate::windows::{self, Attach};

/// Open another GUI window (Window ▸ New Window), on its splash page: the
/// window attaches once the page has chosen where ([`attach_window`]).
#[tauri::command]
pub fn new_window(app: tauri::AppHandle) -> Result<(), CommandError> {
    windows::open(&app)
        .map(|_| ())
        .map_err(CommandError::unavailable)
}

/// Whether this window is attached to a session, or still on its splash page.
/// A window the registry does not know yet is the first one starting up.
#[tauri::command]
pub fn window_attachment(window: tauri::WebviewWindow) -> Value {
    let attached = windows::entry_for(&window).map_or(true, |entry| entry.attached());
    serde_json::json!({ "attached": attached })
}

/// The sessions on this machine's tmuxy server, for the splash page to list.
#[tauri::command]
pub async fn list_local_sessions() -> Result<Value, CommandError> {
    let sessions = tauri::async_runtime::spawn_blocking(windows::local_sessions)
        .await
        .map_err(|e| CommandError::unavailable(e.to_string()))?;
    serde_json::to_value(sessions).map_err(|e| CommandError::unavailable(e.to_string()))
}

/// Attach this splash window: to a session on this machine (`session`), whose
/// group it joins, or to the tmuxy server of an ssh host (`ssh`).
#[tauri::command]
pub fn attach_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session: Option<String>,
    ssh: Option<String>,
) -> Result<(), CommandError> {
    let choice = match (session, ssh) {
        (Some(session), None) => Attach::Local(session),
        (None, Some(ssh)) => Attach::Ssh(ssh),
        _ => {
            return Err(CommandError::invalid(
                "a session or an ssh host, one of the two",
            ))
        }
    };
    windows::attach(&app, window.label(), choice).map_err(CommandError::invalid)
}

/// Bring the GUI window at `index` to the front (Window ▸ the window list, and
/// the Cmd/Ctrl+Shift+digit shortcuts).
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle, index: usize) {
    windows::focus_index(&app, index);
}

/// Close this OS window (Window ▸ Close Window).
#[tauri::command]
pub fn close_window(window: tauri::WebviewWindow) -> Result<(), CommandError> {
    window
        .close()
        .map_err(|e| CommandError::unavailable(e.to_string()))
}

/// Every open GUI window, in Window-menu order, for the in-app menu to list —
/// the native menu bar builds its own from the same registry.
#[tauri::command]
pub fn list_gui_windows(app: tauri::AppHandle) -> Vec<Value> {
    let focused = windows::focused_label(&app);
    windows::list(&app)
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "index": entry.index,
                "title": entry.title,
                "focused": entry.label == focused,
            })
        })
        .collect()
}
