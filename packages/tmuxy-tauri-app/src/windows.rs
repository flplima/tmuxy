//! Several GUI windows over one tmux session.
//!
//! Each OS window is an independent client: its own webview, its own control-mode
//! monitor, and its own tmux session. The sessions are members of one tmux
//! *session group* — they share every window and pane, but each keeps its own
//! current window, which is what lets window 1 sit on one tab while window 2
//! sits on another. The first window holds the group's base session (the one
//! `TMUXY_SESSION` names); every later window gets `<base>~<index>`.
//!
//! The registry here is what turns a webview label back into the monitor behind
//! it, so a `#[tauri::command]` serves the window it came from
//! (`monitor_for`), and what the Window menu lists (`list`).
//!
//! A window's session is killed when its window closes. Killing a member of a
//! group leaves the windows alone — they stay alive in the remaining members —
//! so the shared panes survive, while the session nobody is looking at does not
//! linger on the server.

use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::monitor::MonitorState;

/// Label of the first window, created at startup.
pub const MAIN_LABEL: &str = "main";

/// How many windows a digit accelerator can reach — Cmd+1…Cmd+9.
pub const MAX_INDEXED_WINDOWS: usize = 9;

/// One GUI window: its webview, the tmux session it is attached to, and the
/// monitor feeding it.
#[derive(Clone)]
pub struct GuiWindow {
    /// Webview window label (`main`, `win2`, …) — the `emit_to` address.
    pub label: String,
    /// 1-based position in the Window menu, and the digit that focuses it.
    pub index: usize,
    /// The session this window's client is attached to, for the windows that
    /// have one of their own. `None` for the first window, whose session is
    /// whatever the environment currently names — `tmuxy connect` can retarget
    /// it at runtime, and a snapshot taken at startup would route commands at
    /// the server it left.
    session: Option<String>,
    pub monitor: MonitorState,
}

impl GuiWindow {
    /// The tmux session this window's client is attached to.
    pub fn session(&self) -> String {
        self.session
            .clone()
            .unwrap_or_else(tmuxy_core::session::session_name)
    }
}

/// Every GUI window, in the order they were opened. Tauri-managed state.
#[derive(Clone, Default)]
pub struct GuiWindows(Arc<RwLock<Vec<GuiWindow>>>);

impl GuiWindows {
    /// The windows, lowest index first — the Window menu's order.
    pub fn list(&self) -> Vec<GuiWindow> {
        let mut windows = self.0.read().map(|g| g.clone()).unwrap_or_default();
        windows.sort_by_key(|w| w.index);
        windows
    }

    pub fn get(&self, label: &str) -> Option<GuiWindow> {
        self.0
            .read()
            .ok()?
            .iter()
            .find(|w| w.label == label)
            .cloned()
    }

    fn add(&self, window: GuiWindow) {
        if let Ok(mut guard) = self.0.write() {
            guard.push(window);
        }
    }

    fn remove(&self, label: &str) -> Option<GuiWindow> {
        let mut guard = self.0.write().ok()?;
        let at = guard.iter().position(|w| w.label == label)?;
        Some(guard.remove(at))
    }

    /// The lowest index no window holds, so a window opened after one closed
    /// reuses the freed digit rather than climbing past Cmd+9.
    fn free_index(&self) -> usize {
        let taken: Vec<usize> = self.list().iter().map(|w| w.index).collect();
        (1..).find(|i| !taken.contains(i)).unwrap_or(1)
    }
}

/// Find the picture behind a `tmuxyimg:` request in whichever window's monitor
/// decoded it. Each window's monitor keeps its own store, and the scheme handler
/// has only the URL — so the lookup asks all of them rather than guessing.
pub fn lookup_image(app: &AppHandle, path: &str) -> Option<tmuxy_core::control_mode::StoredImage> {
    app.state::<GuiWindows>()
        .list()
        .iter()
        .find_map(|entry| crate::monitor::lookup_image(&entry.monitor.images, path))
}

/// Menu id that focuses the window at `index`.
pub fn select_id(index: usize) -> String {
    format!("window-select-{index}")
}

/// The window index a menu id names, or `None` for an id that is not one.
pub fn index_from_id(id: &str) -> Option<usize> {
    id.strip_prefix("window-select-")?.parse().ok()
}

/// One row of the Window menu.
pub struct MenuEntry {
    pub label: String,
    pub index: usize,
    /// The window's own title — what the menu shows, as in every macOS app.
    pub title: String,
}

/// The Window menu's rows: every open GUI window, lowest index first.
pub fn list<M: Manager<tauri::Wry>>(app: &M) -> Vec<MenuEntry> {
    app.state::<GuiWindows>()
        .list()
        .into_iter()
        .map(|entry| MenuEntry {
            title: app
                .get_webview_window(&entry.label)
                .and_then(|w| w.title().ok())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| entry.session()),
            label: entry.label,
            index: entry.index,
        })
        .collect()
}

/// Label of the window with keyboard focus, falling back to the first one.
pub fn focused_label<M: Manager<tauri::Wry>>(app: &M) -> String {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
        .unwrap_or_else(|| MAIN_LABEL.to_string())
}

/// The base session of the group: the first window's, or `TMUXY_SESSION` before
/// that window is registered.
pub fn base_session(app: &AppHandle) -> String {
    app.state::<GuiWindows>()
        .get(MAIN_LABEL)
        .map(|w| w.session())
        .unwrap_or_else(tmuxy_core::session::session_name)
}

/// The monitor behind the window a command arrived from.
///
/// Every tmux mutation, query and scrollback fetch resolves its monitor this
/// way, so a command from window 2 runs on window 2's client — targeting the
/// first window's would move the wrong window's current tab.
pub fn monitor_for(window: &WebviewWindow) -> Result<MonitorState, String> {
    entry_for(window).map(|w| w.monitor)
}

/// The registry entry for the window a command arrived from — its monitor and
/// the session that monitor is attached to, which is the session a command is
/// routed against.
pub fn entry_for(window: &WebviewWindow) -> Result<GuiWindow, String> {
    let label = window.label();
    window
        .state::<GuiWindows>()
        .get(label)
        .ok_or_else(|| format!("no tmux monitor for window '{label}'"))
}

/// Register the first window and start its monitor on the base session.
pub fn register_main(app: &AppHandle, monitor: MonitorState) {
    app.state::<GuiWindows>().add(GuiWindow {
        label: MAIN_LABEL.to_string(),
        index: 1,
        session: None,
        monitor,
    });
}

/// Open another GUI window on the same tmux session group.
///
/// Returns the new window's label. The window is built first and its monitor
/// started after: the monitor emits to the label, so the webview has to exist to
/// be addressed.
pub fn open(app: &AppHandle) -> Result<String, String> {
    let registry = app.state::<GuiWindows>();
    let index = registry.free_index();
    if index > MAX_INDEXED_WINDOWS {
        return Err(format!(
            "tmuxy shows at most {MAX_INDEXED_WINDOWS} windows in the Window menu"
        ));
    }
    let base = base_session(app);
    let label = format!("win{index}");
    let session = format!("{base}~{index}");

    let window = crate::gui::build_window(app, &label).map_err(|e| e.to_string())?;
    // The title is what the Window menu lists this window as, so it names the
    // session that makes it a different view of the same tmux server.
    let _ = window.set_title(&format!("tmuxy — {session}"));
    crate::gui::configure_window(&window);

    let monitor = MonitorState::default();
    registry.add(GuiWindow {
        label: label.clone(),
        index,
        session: Some(session.clone()),
        monitor: monitor.clone(),
    });

    let app_handle = app.clone();
    let monitor_label = label.clone();
    tauri::async_runtime::spawn(async move {
        crate::monitor::start_monitoring_window(
            app_handle,
            monitor_label,
            monitor,
            session,
            Some(base),
        )
        .await;
    });

    crate::gui::refresh_menu(app);
    Ok(label)
}

/// Bring a window to the front by its menu index; a no-op when no window holds
/// that index.
pub fn focus_index(app: &AppHandle, index: usize) {
    let windows = app.state::<GuiWindows>().list();
    let Some(entry) = windows.into_iter().find(|w| w.index == index) else {
        return;
    };
    if let Some(window) = app.get_webview_window(&entry.label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The window the user is looking at, falling back to the first one — the target
/// for every native menu action, which has no window of its own.
pub fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(MAIN_LABEL))
}

/// Drop a window's registration and kill the session it was attached to when it
/// closes. The base session is left alone: it is the group's own session and
/// outlives the desktop app.
pub fn watch_for_close(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        let Some(entry) = app.state::<GuiWindows>().remove(&label) else {
            return;
        };
        if entry.label != MAIN_LABEL {
            let session = entry.session();
            // Not through the monitor's control-mode channel: that channel
            // belongs to the client being killed, and this session's own
            // `kill-session` would race its shutdown. The base session's
            // monitor is the surviving client, so route it there.
            if let Some(main) = app.state::<GuiWindows>().get(MAIN_LABEL) {
                tauri::async_runtime::spawn(async move {
                    crate::monitor::run_on(&main.monitor, &format!("kill-session -t {session}"))
                        .await;
                });
            }
        }
        crate::gui::refresh_menu(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, index: usize) -> GuiWindow {
        GuiWindow {
            label: label.to_string(),
            index,
            session: Some(format!("tmuxy~{index}")),
            monitor: MonitorState::default(),
        }
    }

    #[test]
    fn a_window_select_id_round_trips_through_its_index() {
        assert_eq!(index_from_id(&select_id(3)), Some(3));
        assert_eq!(index_from_id("window-new"), None);
    }

    #[test]
    fn the_first_free_digit_is_reused_after_a_window_closes() {
        // Otherwise the indexes climb with every open/close and the fourth
        // window of a session is on Cmd+7 for no reason the user can see.
        let windows = GuiWindows::default();
        windows.add(entry("main", 1));
        windows.add(entry("win2", 2));
        windows.add(entry("win3", 3));
        windows.remove("win2");
        assert_eq!(windows.free_index(), 2);
    }

    #[test]
    fn windows_are_listed_in_menu_order() {
        let windows = GuiWindows::default();
        windows.add(entry("win3", 3));
        windows.add(entry("main", 1));
        let order: Vec<usize> = windows.list().iter().map(|w| w.index).collect();
        assert_eq!(order, vec![1, 3]);
    }

    #[test]
    fn a_window_is_found_by_its_label() {
        let windows = GuiWindows::default();
        windows.add(entry("win2", 2));
        assert_eq!(
            windows.get("win2").map(|w| w.session()),
            Some("tmuxy~2".to_string())
        );
        assert!(windows.get("win5").is_none());
    }
}
