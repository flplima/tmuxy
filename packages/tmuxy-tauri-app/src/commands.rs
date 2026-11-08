pub mod gui_windows;
mod helpers;
pub mod window_size;

use serde_json::Value;
use tauri::Manager;
use tmuxy_core::host::{ClientCommand, HostCtx, SessionRuntime};
use tmuxy_core::CommandError;

use crate::monitor::Monitor;
use crate::titlebar;
use crate::windows::{self, GuiWindow};

use helpers::open_with_system;

struct DesktopCtx {
    app: tauri::AppHandle,
    window: GuiWindow,
    monitor: Monitor,
}

impl HostCtx for DesktopCtx {
    fn runtime(&self) -> &SessionRuntime {
        &self.monitor.runtime
    }

    fn client(&self) -> Option<u64> {
        Some(0)
    }

    fn switches_servers(&self) -> bool {
        true
    }

    async fn connect(&self, target: crate::monitor::ConnectTarget) -> Result<(), CommandError> {
        crate::monitor::request_reconnect(&self.app, &self.window, target).await;
        Ok(())
    }

    /// Not a plain `detach-client`: the monitor has to be told this was
    /// deliberate, or its loop treats the ended connection as a flap and
    /// reattaches, dropping the user back into the session they just left.
    async fn detach(&self) -> Result<(), CommandError> {
        self.monitor.detach().await;
        Ok(())
    }

    /// The webview never opens `target="_blank"` anchors on its own (a
    /// new-window request is denied), so a link clicked in a pane is opened
    /// here.
    fn open_url(&self, url: &str) -> Result<(), CommandError> {
        open_with_system(std::ffi::OsStr::new(url))
    }

    fn open_path(&self, path: &std::path::Path) -> Result<(), CommandError> {
        open_with_system(path.as_os_str())
    }
}

/// Every client command the page sends, for the window it came from
/// (`tmuxy_core::host::handle`). The request is `{ cmd, args }`, the body
/// the web build POSTs to `/commands`.
#[tauri::command]
pub async fn dispatch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Value,
) -> Result<Value, CommandError> {
    let cmd = ClientCommand::from_value(request)
        .map_err(|e| CommandError::invalid(format!("invalid command payload: {e}")))?;
    let entry = windows::entry_for(&window)?;
    let ctx = DesktopCtx {
        app,
        monitor: entry.monitor()?,
        window: entry,
    };
    // In the window's own tmux target, so every read the command makes
    // reaches the server the window is attached to.
    windows::scoped(&window, tmuxy_core::host::handle(cmd, &ctx)).await
}

/// The status bar is the window's title bar; it reports its rendered height
/// (logical px) so the native window buttons stay centred on it.
///
/// `action_id` is the client's trace correlation id (docs/TRACING.md).
#[tauri::command]
pub fn set_titlebar_height(window: tauri::WebviewWindow, height: f64, action_id: Option<String>) {
    titlebar::set_height(&window, height, action_id.as_deref());
}

/// Double-click on the status bar's empty space — the native title-bar gesture.
#[tauri::command]
pub fn titlebar_double_click(
    window: tauri::WebviewWindow,
    action_id: Option<String>,
) -> Result<(), CommandError> {
    titlebar::double_click(&window, action_id.as_deref())
        .map_err(|e| CommandError::unavailable(e.to_string()))
}

/// Leave the app (Quit, where the menu is the app's own rather than the
/// platform's). tmux keeps every session.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0)
}

/// Put this window into one of the iTerm2 window styles, by its menu slug
/// (`full-width-top`, `no-title-bar`, …). Unknown slugs are refused rather than
/// silently ignored, so a typo in the UI shows up as a snackbar.
#[tauri::command]
pub fn set_window_style(window: tauri::WebviewWindow, style: String) -> Result<(), CommandError> {
    let style = crate::window_style::WindowStyle::from_slug(&style)
        .ok_or_else(|| CommandError::invalid(format!("unknown window style '{style}'")))?;
    crate::window_style::apply(&window, style)
        .map_err(|e| CommandError::unavailable(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn get_window_style(window: tauri::WebviewWindow) -> String {
    crate::window_style::slug_of(
        window
            .state::<crate::window_style::WindowStyles>()
            .of(window.label()),
    )
}

/// Relaunch the desktop app in place (Debug ▸ Restart App). tmux keeps every
/// session; the new process reattaches to the same socket on start.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart()
}
