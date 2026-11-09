//! The GUI windows: opening, focusing, closing and listing them, and a new
//! window's splash page — the sessions on this machine to join, a new one,
//! or a host to attach to over ssh (`windows/attach.rs`).

use serde_json::Value;
use tmuxy_core::CommandError;

use crate::windows::{self, Attach, Attached, SshForm};

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

/// Attach this splash window, as one of three: to a session on this machine
/// (`session`), whose group it joins; to a new session on this machine
/// (`new_session`, a name or `""` for a number); or to the tmuxy server of a
/// host over ssh (`ssh`, the page's form). Answers `{ attached: true }`, or
/// `{ unknownHost: { fingerprint } }` when the host's key is to be confirmed.
#[tauri::command]
pub async fn attach_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session: Option<String>,
    new_session: Option<String>,
    ssh: Option<SshForm>,
) -> Result<Value, CommandError> {
    let choice = match (session, new_session, ssh) {
        (Some(session), None, None) => Attach::Local(session),
        (None, Some(name), None) => Attach::New(Some(name)),
        (None, None, Some(form)) => Attach::Ssh(form),
        _ => {
            return Err(CommandError::invalid(
                "one of a session, a new session or an ssh host",
            ))
        }
    };
    let label = window.label().to_string();
    // An ssh connection authenticates before the window attaches.
    let attached =
        tauri::async_runtime::spawn_blocking(move || windows::attach(&app, &label, choice))
            .await
            .map_err(|e| CommandError::unavailable(e.to_string()))?
            .map_err(CommandError::invalid)?;
    Ok(match attached {
        Attached::Done => serde_json::json!({ "attached": true }),
        Attached::UnknownHost { fingerprint } => {
            serde_json::json!({ "unknownHost": { "fingerprint": fingerprint } })
        }
    })
}

/// The hosts the user's `~/.ssh/config` names, for the ssh form to offer.
#[tauri::command]
pub fn list_ssh_hosts() -> Vec<String> {
    windows::config_hosts()
}

/// A native file chooser for the ssh form's key or certificate, opened in
/// `~/.ssh`: the path picked, or none.
#[tauri::command]
pub async fn pick_ssh_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(home) = std::env::var_os("HOME") {
        dialog = dialog.set_directory(std::path::Path::new(&home).join(".ssh"));
    }
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .ok()
        .flatten()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
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
