//! Several GUI windows over one tmux session.
//!
//! Each OS window is an independent client: its own webview, its own control-mode
//! monitor, and its own tmux session. The sessions are members of one tmux
//! *session group* — they share every window and pane, but each keeps its own
//! current window, which is what lets window 1 sit on one tab while window 2
//! sits on another. The first window holds the group's base session (the one
//! `TMUXY_SESSION` names); every later window gets `<base>+<index>`.
//!
//! The registry here is what turns a webview label back into the monitor behind
//! it, so a `#[tauri::command]` serves the window it came from
//! (`monitor_for`), and what the Window menu lists (`list`).
//!
//! Every window after the first opens on a splash page (`attach.rs`) that lists
//! the sessions on this machine and takes an ssh host: picking a session joins
//! its group, an ssh host attaches the window to that machine's tmux server.
//! Only then does the window's monitor start, inside the window's own target
//! (`tmuxy_core::session::scoped`), so one window can be on another machine
//! while the rest stay here.
//!
//! A window's session is killed when its window closes. Killing a member of a
//! group leaves the windows alone — they stay alive in the remaining members —
//! so the shared panes survive, while the session nobody is looking at does not
//! linger on the server.

mod attach;

use std::future::Future;
use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager, WebviewWindow};
use tmuxy_core::session::scoped::{self, TargetCell};

pub use attach::{attach, local_sessions, Attach};

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
    /// Where this window's tmux calls go: empty for the first window, which
    /// follows the process-wide target (`tmuxy connect`), and for a window
    /// still on its splash page.
    pub target: TargetCell,
    /// The window made its session (a group member) and kills it on close.
    owns_session: bool,
    pub monitor: MonitorState,
}

impl GuiWindow {
    /// The tmux session this window's client is attached to.
    pub fn session(&self) -> String {
        self.session
            .clone()
            .unwrap_or_else(tmuxy_core::session::session_name)
    }

    /// Attached to a session: the first window always, a later one once its
    /// splash page has chosen.
    pub fn attached(&self) -> bool {
        self.label == MAIN_LABEL || self.session.is_some()
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

    /// Record the session a splash window chose.
    fn set_session(&self, label: &str, session: String, owns_session: bool) {
        if let Ok(mut guard) = self.0.write() {
            if let Some(entry) = guard.iter_mut().find(|w| w.label == label) {
                entry.session = Some(session);
                entry.owns_session = owns_session;
            }
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

/// The monitor behind the window a command arrived from.
///
/// Every tmux mutation, query and scrollback fetch resolves its monitor this
/// way, so a command from window 2 runs on window 2's client — targeting the
/// first window's would move the wrong window's current tab.
pub fn monitor_for(window: &WebviewWindow) -> Result<MonitorState, tmuxy_core::CommandError> {
    entry_for(window).map(|w| w.monitor)
}

/// The registry entry for the window a command arrived from — its monitor and
/// the session that monitor is attached to, which is the session a command is
/// routed against.
pub fn entry_for(window: &WebviewWindow) -> Result<GuiWindow, tmuxy_core::CommandError> {
    let label = window.label();
    window.state::<GuiWindows>().get(label).ok_or_else(|| {
        tmuxy_core::CommandError::unavailable(format!("no tmux monitor for window '{label}'"))
    })
}

/// Run `fut` — a command a window sent — against that window's tmux target,
/// so a read it makes reaches the server the window is attached to.
pub async fn scoped<F: Future>(window: &WebviewWindow, fut: F) -> F::Output {
    match window.state::<GuiWindows>().get(window.label()) {
        Some(entry) => scoped::with_cell(entry.target, fut).await,
        None => fut.await,
    }
}

/// Register the first window and start its monitor on the base session.
pub fn register_main(app: &AppHandle, monitor: MonitorState) {
    app.state::<GuiWindows>().add(GuiWindow {
        label: MAIN_LABEL.to_string(),
        index: 1,
        session: None,
        target: TargetCell::default(),
        owns_session: false,
        monitor,
    });
}

/// Open another GUI window, on its splash page.
///
/// Returns the new window's label. Nothing is attached yet: the page lists
/// the sessions to pick from, and [`attach`] starts the window's monitor on
/// the one picked.
pub fn open(app: &AppHandle) -> Result<String, String> {
    let registry = app.state::<GuiWindows>();
    let index = registry.free_index();
    if index > MAX_INDEXED_WINDOWS {
        return Err(format!(
            "tmuxy shows at most {MAX_INDEXED_WINDOWS} windows in the Window menu"
        ));
    }
    let label = format!("win{index}");
    let window = crate::gui::build_window(app, &label).map_err(|e| e.to_string())?;
    let _ = window.set_title("tmuxy");
    crate::gui::configure_window(&window);
    registry.add(GuiWindow {
        label: label.clone(),
        index,
        session: None,
        target: TargetCell::default(),
        owns_session: false,
        monitor: MonitorState::default(),
    });
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
        if entry.owns_session && attach::main_shares_server(&entry) {
            let session = entry.session();
            // Not through the monitor's control-mode channel: that channel
            // belongs to the client being killed, and this session's own
            // `kill-session` would race its shutdown. The base session's
            // monitor is the surviving client, so route it there.
            if let Some(main) = app.state::<GuiWindows>().get(MAIN_LABEL) {
                tauri::async_runtime::spawn(async move {
                    crate::monitor::run_on(
                        &main.monitor,
                        &format!(
                            "kill-session -t {}",
                            tmuxy_core::tmux_quote(&format!("={session}"))
                        ),
                    )
                    .await;
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, index: usize) -> GuiWindow {
        GuiWindow {
            label: label.to_string(),
            index,
            session: Some(format!("tmuxy+{index}")),
            target: TargetCell::default(),
            owns_session: true,
            monitor: MonitorState::default(),
        }
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
            Some("tmuxy+2".to_string())
        );
        assert!(windows.get("win5").is_none());
    }
}
