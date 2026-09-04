use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Manager;
use tmuxy_core::constants::tmux_options;
use tmuxy_core::{executor, session};

use crate::commands;
use crate::monitor;
use crate::titlebar;

/// Read a tmuxy user-option, preferring the live tmux server but falling back
/// to parsing `~/.config/tmuxy/tmuxy.conf` directly when the server isn't up
/// yet. The initial `apply_blur` call runs during Tauri setup — before
/// `monitor::start_monitoring` connects and sources the config — so
/// `show-options` would otherwise return empty and the macOS window would
/// open without its blur on first launch.
fn read_tmuxy_option(name: &str) -> Option<String> {
    if let Ok(s) = executor::execute_tmux_command(&["show-options", "-gqv", name]) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    // Fall back to parsing the config files in tmux's source order
    // (defaults first, then user conf) — last assignment wins, matching what
    // `source-file` would resolve to. App-managed state lives in
    // tmuxy.state.json and is applied via set-option at session-init time,
    // so it wins over both files at runtime; check it last here so the
    // fallback matches that ordering for the not-yet-connected path.
    let dir = session::config_dir();
    let mut found: Option<String> = None;
    for filename in ["tmuxy.defaults.conf", "tmuxy.conf"] {
        if let Ok(content) = std::fs::read_to_string(dir.join(filename)) {
            if let Some(v) = parse_option_from_config(&content, name) {
                found = Some(v);
            }
        }
    }
    // tmuxy.state.json overrides — translate known keys to their @tmuxy-* option.
    let state = session::read_managed_state();
    let state_value = match name {
        "@tmuxy-theme" => state.theme,
        "@tmuxy-theme-mode" => state.theme_mode,
        _ => None,
    };
    if state_value.is_some() {
        found = state_value;
    }
    found
}

/// Best-effort parser for `set [-g|-ga|-gu|-s|-sg|...] @name value` lines in a
/// tmux config. Matches the last assignment wins (mirroring tmux) and ignores
/// comments. The value can be a bare word or a single-/double-quoted string.
fn parse_option_from_config(content: &str, name: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut tokens = line.split_whitespace();
        if tokens.next() != Some("set") {
            continue;
        }
        // Skip the flag(s) (`-g`, `-ga`, `-gu`, `-sg`, etc.); the next token
        // should be the option name.
        let after_flag = loop {
            match tokens.next() {
                Some(tok) if tok.starts_with('-') => continue,
                Some(tok) => break Some(tok),
                None => break None,
            }
        };
        if after_flag != Some(name) {
            continue;
        }
        // The remainder of the line is the value (possibly quoted).
        let rest = tokens.collect::<Vec<&str>>().join(" ");
        let value = strip_quotes(rest.trim());
        if !value.is_empty() {
            found = Some(value.to_string());
        }
    }
    found
}

fn strip_quotes(s: &str) -> &str {
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        let first = bytes[0];
        let last = bytes[s.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// Apply the native blur behind the window from `@tmuxy-blur` (default on).
/// macOS only — the option is accepted and ignored elsewhere. Called at setup
/// and again whenever the user's config is (re)sourced, so flipping the flag
/// takes effect live. The surface opacities the blur shows through are the
/// frontend's business (`theme::Appearance`, applied as CSS variables).
pub(crate) fn apply_blur(window: &tauri::WebviewWindow) {
    let blur = read_tmuxy_option(tmux_options::BLUR)
        .map(|value| tmuxy_core::theme::parse_flag(&value, true))
        .unwrap_or(true);
    set_native_blur(window, blur);
}

#[cfg(target_os = "macos")]
fn set_native_blur(window: &tauri::WebviewWindow, blur: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        // Every apply adds a fresh NSVisualEffectView under the webview and
        // tauri's `set_effects(None)` clears nothing on macOS, so drop the
        // previous view first — that is also what turns blur off.
        if let Err(e) = window_vibrancy::clear_vibrancy(&target) {
            eprintln!("Failed to clear window blur: {}", e);
        }
        if !blur {
            return;
        }
        // Pin the effect state to Active so the blur stays applied when the
        // window loses key focus. NSVisualEffectView defaults to
        // FollowsWindowActiveState — switching away from the tmuxy window
        // would drop the blur and leave the inactive window flat.
        let effects = tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::UnderWindowBackground)
            .state(tauri::window::EffectState::Active)
            .build();
        if let Err(e) = target.set_effects(effects) {
            eprintln!("Failed to apply window blur: {}", e);
        }
    });
}

/// No native window material on this platform; the option is read for parity
/// and has nothing to drive.
#[cfg(not(target_os = "macos"))]
fn set_native_blur(_window: &tauri::WebviewWindow, _blur: bool) {}

/// Build the native macOS application menu bar.
///
/// Mirrors the web hamburger menu (Pane, Tab, Session, View, Help) plus
/// standard macOS menus (tmuxy app menu, Edit, Window).
/// Handles for the Debug menu's trace controls, kept so a click can re-render
/// the whole group: the switch enables/disables everything below it, and
/// picking a level has to uncheck its siblings (a native menu has no radio
/// group that does this for us).
struct TraceMenu {
    toggle: CheckMenuItem<tauri::Wry>,
    levels: [CheckMenuItem<tauri::Wry>; 3],
    gated: Vec<MenuItem<tauri::Wry>>,
}

/// Repaint the Debug menu from the live trace state, and tell the frontend so
/// its own tracer starts/stops shipping and the in-app menu agrees.
fn sync_trace_menu(app: &tauri::AppHandle) {
    let on = tmuxy_core::trace::is_enabled();
    let level = tmuxy_core::trace::level_name();
    if let Some(menu) = app.try_state::<TraceMenu>() {
        let _ = menu.toggle.set_checked(on);
        for (item, name) in menu.levels.iter().zip(["shape", "labeled", "full"]) {
            let _ = item.set_enabled(on);
            let _ = item.set_checked(on && level == name);
        }
        for item in &menu.gated {
            let _ = item.set_enabled(on);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(format!("window.tmuxyTraceSync?.({on})"));
    }
}

fn build_app_menu(
    app: &tauri::App,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let app_menu = SubmenuBuilder::new(app, "tmuxy")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // --- Pane ---
    let pane_menu = SubmenuBuilder::new(app, "Pane")
        .item(&MenuItem::with_id(
            app,
            "pane-split-below",
            "Split Below",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-split-right",
            "Split Right",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "pane-next",
            "Next Pane",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-previous",
            "Previous Pane",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "pane-swap-prev",
            "Swap with Previous",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-swap-next",
            "Swap with Next",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-move-new-tab",
            "Move to New Tab",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-add-to-group",
            "Add to Group",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "pane-copy-mode",
            "Copy Mode",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-paste",
            "Paste Buffer",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "pane-clear",
            "Clear Screen",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "view-zoom",
            "Zoom Pane",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "pane-close",
            "Close Pane",
            true,
            None::<&str>,
        )?)
        .build()?;

    // --- Tab ---
    let tab_menu = SubmenuBuilder::new(app, "Tab")
        .item(&MenuItem::with_id(
            app,
            "tab-new",
            "New Tab",
            true,
            Some("CmdOrCtrl+T"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "tab-next",
            "Next Tab",
            true,
            Some("CmdOrCtrl+Shift+]"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "tab-previous",
            "Previous Tab",
            true,
            Some("CmdOrCtrl+Shift+["),
        )?)
        .item(&MenuItem::with_id(
            app,
            "tab-last",
            "Last Tab",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "tab-rename",
            "Rename Tab",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "tab-close",
            "Close Tab",
            true,
            Some("CmdOrCtrl+W"),
        )?)
        .build()?;

    // --- Session ---
    let session_menu = SubmenuBuilder::new(app, "Session")
        .item(&MenuItem::with_id(
            app,
            "session-new",
            "New Session",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "session-rename",
            "Rename Session",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "session-detach",
            "Detach Session",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "session-kill",
            "Kill Session",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "session-reload-config",
            "Reload Config",
            true,
            None::<&str>,
        )?)
        .build()?;

    // --- Theme ---
    // Mirrors the web hamburger menu's Theme submenu: light/dark mode toggle,
    // then one item per *.css under ~/.config/tmuxy/themes/. Theme list is
    // captured at app startup; changing the directory at runtime won't update
    // the menu until next launch (acceptable v1 — themes don't churn often).
    let mut theme_builder = SubmenuBuilder::new(app, "Theme")
        .item(&MenuItem::with_id(
            app,
            "theme-mode-dark",
            "Dark Mode",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "theme-mode-light",
            "Light Mode",
            true,
            None::<&str>,
        )?)
        .separator();
    for name in tmuxy_core::session::list_themes() {
        let label = tmuxy_core::theme::display_theme_name(&name);
        theme_builder = theme_builder.item(&MenuItem::with_id(
            app,
            format!("theme-set-{}", name),
            label,
            true,
            None::<&str>,
        )?);
    }
    let theme_menu = theme_builder.build()?;

    // --- View ---
    let layout_menu = SubmenuBuilder::new(app, "Layout")
        .item(&MenuItem::with_id(
            app,
            "view-layout-even-horizontal",
            "Even Horizontal",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "view-layout-even-vertical",
            "Even Vertical",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "view-layout-main-horizontal",
            "Main Horizontal",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "view-layout-main-vertical",
            "Main Vertical",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "view-layout-tiled",
            "Tiled",
            true,
            None::<&str>,
        )?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&layout_menu)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "view-font-bigger",
            "Make Text Bigger",
            true,
            Some("CmdOrCtrl+Plus"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "view-font-smaller",
            "Make Text Smaller",
            true,
            Some("CmdOrCtrl+-"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "view-font-reset",
            "Reset Text Size",
            true,
            Some("CmdOrCtrl+0"),
        )?)
        .build()?;

    // --- Edit (standard macOS) ---
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .copy()
        .paste()
        .select_all()
        .build()?;

    // --- Window (standard macOS) ---
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    // --- Debug ---
    // The local action trace (docs/TELEMETRY.md) and nothing else. The switch
    // gates every item under it: with tracing off there is no level to choose
    // and no file worth opening.
    let tracing_on = tmuxy_core::trace::is_enabled();
    // A kill switch (DO_NOT_TRACK / TMUXY_NO_TRACE) makes the switch itself
    // inert — show it disabled rather than one that silently refuses.
    let switch_usable = !tmuxy_core::trace::is_locked_off();
    let level = tmuxy_core::trace::level_name();

    let trace_toggle = CheckMenuItem::with_id(
        app,
        "trace-enabled",
        "Enable Traces",
        switch_usable,
        tracing_on,
        None::<&str>,
    )?;
    let level_header = MenuItem::with_id(
        app,
        "trace-level-header",
        "Trace Level",
        false,
        None::<&str>,
    )?;
    let level_shape = CheckMenuItem::with_id(
        app,
        "trace-level-shape",
        "Shape",
        tracing_on,
        level == "shape",
        None::<&str>,
    )?;
    let level_labeled = CheckMenuItem::with_id(
        app,
        "trace-level-labeled",
        "Labeled",
        tracing_on,
        level == "labeled",
        None::<&str>,
    )?;
    let level_full = CheckMenuItem::with_id(
        app,
        "trace-level-full",
        "Full",
        tracing_on,
        level == "full",
        None::<&str>,
    )?;
    let trace_open = MenuItem::with_id(
        app,
        "trace-open",
        "Open trace.ndjson",
        tracing_on,
        None::<&str>,
    )?;
    let trace_copy_path = MenuItem::with_id(
        app,
        "trace-copy-path",
        "Copy trace.ndjson Path",
        tracing_on,
        None::<&str>,
    )?;

    let restart_app = MenuItem::with_id(app, "restart-app", "Restart App", true, None::<&str>)?;

    let debug_menu = SubmenuBuilder::new(app, "Debug")
        .item(&trace_toggle)
        .separator()
        .item(&level_header)
        .item(&level_shape)
        .item(&level_labeled)
        .item(&level_full)
        .separator()
        .item(&trace_open)
        .item(&trace_copy_path)
        .separator()
        .item(&restart_app)
        .build()?;

    // Keep the handles: clicking any of these has to re-render the others
    // (the switch enables/disables the rest; picking a level unchecks its
    // siblings), which needs the items themselves, not just their ids.
    app.manage(TraceMenu {
        toggle: trace_toggle,
        levels: [level_shape, level_labeled, level_full],
        gated: vec![trace_open, trace_copy_path],
    });

    // --- Help ---
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItem::with_id(
            app,
            "help-copy-logs",
            "Copy Logs to Clipboard",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "help-reveal-log-file",
            "Reveal Log File in Finder",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "help-github",
            "Tmuxy on GitHub",
            true,
            None::<&str>,
        )?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&pane_menu)
        .item(&tab_menu)
        .item(&session_menu)
        .item(&theme_menu)
        .item(&view_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&debug_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

/// Menu item IDs that map to a tmux operation. These are dispatched through the
/// frontend's `executeMenuAction` (exposed as `window.tmuxyMenuAction`), which
/// routes them via the control-mode-safe adapter path — including the
/// `new-window` → `splitw ; breakp` rewrite and the `@tmuxy-window-type` tag.
/// Running them here as external `sh -c "tmux …"` subprocesses would bypass
/// control mode and can crash tmux 3.5a (e.g. a raw `new-window`). This list
/// mirrors the tmux cases in `tmuxy-ui/src/components/menus/menuActions.ts`.
const FRONTEND_MENU_ACTIONS: &[&str] = &[
    "pane-split-below",
    "pane-split-right",
    "pane-next",
    "pane-previous",
    "pane-swap-prev",
    "pane-swap-next",
    "pane-move-new-tab",
    "pane-add-to-group",
    "pane-copy-mode",
    "pane-paste",
    "pane-clear",
    "pane-close",
    "view-zoom",
    "tab-new",
    "tab-next",
    "tab-previous",
    "tab-last",
    "tab-rename",
    "tab-close",
    "session-new",
    "session-rename",
    "session-detach",
    "session-kill",
    "session-reload-config",
    "view-layout-even-horizontal",
    "view-layout-even-vertical",
    "view-layout-main-horizontal",
    "view-layout-main-vertical",
    "view-layout-tiled",
];

/// Handle native menu item clicks.
///
/// Tmux operations are dispatched to the frontend (`window.tmuxyMenuAction`),
/// which runs them through the control-mode connection — the same path the
/// in-app menu uses. Frontend-only actions (font size, theme) are dispatched
/// via window.eval() too.
fn handle_menu_event(app_handle: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();

    if FRONTEND_MENU_ACTIONS.contains(&id) {
        if let Some(window) = app_handle.get_webview_window("main") {
            // `id` is a fixed literal from the menu definition (not user input);
            // `{id:?}` emits it as a quoted JS string literal.
            if let Err(e) = window.eval(format!("window.tmuxyMenuAction?.({id:?})")) {
                eprintln!("[menu] Failed to dispatch '{}': {}", id, e);
            }
        }
        return;
    }

    // Help: copy / reveal the debug log file
    if id == "help-copy-logs" {
        copy_logs_to_clipboard(app_handle);
        return;
    }
    if id == "help-reveal-log-file" {
        reveal_log_file();
        return;
    }

    // Debug: the local action trace (docs/TELEMETRY.md). Every branch ends by
    // re-syncing the menu, because these controls describe each other — the
    // switch gates the rest, and the levels are mutually exclusive.
    match id {
        "trace-enabled" => {
            let on = !tmuxy_core::trace::is_enabled();
            let effective = tmuxy_core::trace::set_enabled(on);
            if on && !effective {
                show_status_message(
                    app_handle,
                    "Tracing is disabled by DO_NOT_TRACK / TMUXY_NO_TRACE",
                );
            } else {
                show_status_message(
                    app_handle,
                    if effective {
                        "Action tracing ON — local file only, never uploaded"
                    } else {
                        "Action tracing OFF"
                    },
                );
            }
            sync_trace_menu(app_handle);
            return;
        }
        "trace-level-shape" | "trace-level-labeled" | "trace-level-full" => {
            let name = &id["trace-level-".len()..];
            let level = tmuxy_core::trace::TraceLevel::parse(name);
            tmuxy_core::trace::set_level_persisted(level);
            show_status_message(app_handle, &format!("Trace level: {}", level.as_str()));
            sync_trace_menu(app_handle);
            return;
        }
        "restart-app" => app_handle.restart(),
        "trace-open" => {
            if let Err(e) = commands::open_trace_file() {
                show_status_message(app_handle, &e);
            }
            return;
        }
        "trace-copy-path" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            match tmuxy_core::trace::trace_path() {
                Some(path) => {
                    let text = path.display().to_string();
                    match app_handle.clipboard().write_text(text.clone()) {
                        Ok(()) => show_status_message(app_handle, &format!("Copied {text}")),
                        Err(e) => show_status_message(
                            app_handle,
                            &format!("Failed to write clipboard: {e}"),
                        ),
                    }
                }
                None => show_status_message(app_handle, "No trace file path could be resolved"),
            }
            return;
        }
        _ => {}
    }

    // Frontend-only actions — dispatch via JS eval. Theme actions reuse the
    // same XState events the web hamburger menu fires, so the Tauri menu and
    // the in-app menu stay in sync without a parallel code path.
    if let Some(window) = app_handle.get_webview_window("main") {
        let owned;
        let js: Option<&str> = match id {
            "view-font-bigger" => Some("window.app?.send({ type: 'INCREASE_FONT_SIZE' })"),
            "view-font-smaller" => Some("window.app?.send({ type: 'DECREASE_FONT_SIZE' })"),
            "view-font-reset" => Some("window.app?.send({ type: 'RESET_FONT_SIZE' })"),
            "help-github" => Some("window.open('https://github.com/flplima/tmuxy', '_blank')"),
            "theme-mode-dark" => Some("window.app?.send({ type: 'SET_THEME_MODE', mode: 'dark' })"),
            "theme-mode-light" => {
                Some("window.app?.send({ type: 'SET_THEME_MODE', mode: 'light' })")
            }
            other if other.starts_with("theme-set-") => {
                let name = &other["theme-set-".len()..];
                // JSON-encode the theme name so quotes/special chars in
                // exotic theme filenames (none today, but cheap insurance)
                // can't break out of the JS string literal.
                let json_name =
                    serde_json::to_string(name).unwrap_or_else(|_| "\"default\"".to_string());
                owned = format!(
                    "window.app?.send({{ type: 'SET_THEME', name: {} }})",
                    json_name
                );
                Some(owned.as_str())
            }
            _ => None,
        };
        if let Some(js) = js {
            let _ = window.eval(js);
        }
    }
}

/// Build the main webview window from code so its transparency settings
/// can react to runtime env (TMUXY_OPAQUE_WINDOW=1 → opaque + decorated).
///
/// Defaults match the previous tauri.conf.json values exactly so production
/// behavior is unchanged: transparent webview, hidden macOS title with the
/// traffic lights centred on the status bar. The opaque branch removes both —
/// needed when running under Xvfb-style displays that lack a compositor.
fn create_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let opaque = std::env::var_os("TMUXY_OPAQUE_WINDOW").is_some();

    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("tmuxy")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        // macOS swallows the first click on an inactive window — only the
        // os-level focus changes, the webview never sees the mousedown. With
        // `accept_first_mouse(true)` the click flows through, so clicking
        // an inactive pane to bring tmuxy back to the foreground also makes
        // that pane active in one motion instead of two.
        .accept_first_mouse(true);

    if !opaque {
        builder = builder.transparent(true);

        #[cfg(target_os = "macos")]
        {
            use tauri::TitleBarStyle;
            // The web status bar is the visible title bar; titlebar.rs keeps
            // the traffic-light buttons centred on it as its height changes.
            builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true);
        }
    }

    let window = builder.build()?;

    if !opaque {
        titlebar::install(&window);
    }

    if opaque {
        tmuxy_core::debug_log::log(
            "TMUXY_OPAQUE_WINDOW=1: built window with decorations, no transparency",
        );
    }

    Ok(())
}

/// Path to the persistent debug log written by tmuxy_core::debug_log.
fn debug_log_path() -> std::path::PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        std::path::PathBuf::from(home).join("tmuxy-debug.log")
    } else {
        std::path::PathBuf::from("/tmp/tmuxy-debug.log")
    }
}

/// Read the debug log file and copy its contents (with a small env header)
/// to the system clipboard. Surfaces a status message in the UI either way.
fn copy_logs_to_clipboard(app: &tauri::AppHandle) {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let path = debug_log_path();
    let header = build_log_header(&path);

    let body = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) => {
            let msg = format!("Could not read log file at {}: {}", path.display(), e);
            show_status_message(app, &msg);
            return;
        }
    };

    // Cap to the last ~256 KB so a long-running session's log doesn't
    // overflow the clipboard or hang the paste target.
    const MAX_LOG_BYTES: usize = 256 * 1024;
    let trimmed = if body.len() > MAX_LOG_BYTES {
        let cut = body.len() - MAX_LOG_BYTES;
        format!("[…{} earlier bytes truncated]\n{}", cut, &body[cut..])
    } else {
        body
    };

    let payload = format!("{}\n\n{}", header, trimmed);

    match app.clipboard().write_text(payload) {
        Ok(()) => {
            show_status_message(app, &format!("Copied {} log to clipboard", path.display()));
        }
        Err(e) => {
            show_status_message(app, &format!("Failed to write clipboard: {}", e));
        }
    }
}

/// Reveal the debug log file in the platform file manager.
fn reveal_log_file() {
    let path = debug_log_path();
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
    }
}

fn build_log_header(path: &std::path::Path) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let pid = std::process::id();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let env_lines: Vec<String> = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL", "USER"]
        .iter()
        .map(|k| {
            format!(
                "  {}={}",
                k,
                std::env::var(k).unwrap_or_else(|_| "(unset)".into())
            )
        })
        .collect();
    format!(
        "=== tmuxy log dump ===\nversion: {}\npid: {}\nutc_seconds_since_epoch: {}\nlog_file: {}\nplatform: {}\nenv:\n{}\n--- log file contents below ---",
        version,
        pid,
        now,
        path.display(),
        std::env::consts::OS,
        env_lines.join("\n"),
    )
}

/// Forward a transient status banner to the React UI via window.eval.
/// Matches `ShowStatusMessageEvent` in tmuxy-ui (event.text).
fn show_status_message(app: &tauri::AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        // serde_json produces a complete JS string literal, including escapes
        // for newlines. Hand-rolling `\\` and `'` missed `\n`/`\r`, so a
        // multi-line message (an fs error with a path plus context) produced a
        // JS syntax error and the banner silently never appeared.
        let Ok(text) = serde_json::to_string(message) else {
            return;
        };
        let js = format!("window.app?.send({{ type: 'SHOW_STATUS_MESSAGE', text: {text} }})");
        let _ = window.eval(js);
    }
}

/// Start the Tauri GUI application.
pub fn run() {
    // The desktop GUI previously installed no tracing subscriber, so every
    // `tracing` event (spans, warns, errors) was silently dropped here — only
    // the `debug_log` file logger survived. Install it now so the whole Rust
    // pipeline is observable in the app, and so the NDJSON trace layer is wired.
    tmuxy_server::init_logging();
    if let Some(path) = tmuxy_core::trace::init(None, cfg!(debug_assertions)) {
        let level = tmuxy_core::trace::level_name();
        tmuxy_core::debug_log::log(&format!("action tracing ON [{level}] → {}", path.display()));
        eprintln!(
            "[tmuxy] action tracing ON [level={level}] → {} (local only, never uploaded; \
             TMUXY_TRACE_LEVEL=shape|labeled|full; DO_NOT_TRACK=1 or TMUXY_NO_TRACE=1 to disable)",
            path.display()
        );
    }

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // WebDriver plugin: enables GUI testing via W3C WebDriver on all platforms
    // including macOS (where the official tauri-driver doesn't support WKWebView).
    // Only included when built with --features webdriver.
    #[cfg(feature = "webdriver")]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    // Status-bar height reported by the frontend — see titlebar.rs.
    #[cfg(target_os = "macos")]
    {
        builder = builder.manage(titlebar::TitlebarState::default());
    }

    builder
        // Single instance: when user clicks the app icon while already running,
        // bring the existing window to front instead of launching a broken second instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Clipboard manager: powers Help > Copy Logs to Clipboard so users
        // launched from Finder can grab ~/tmuxy-debug.log without a terminal.
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(monitor::KeyBindingsState::default())
        .manage(monitor::MonitorState::default())
        // Shared execution context — handed to TmuxMonitor on connect AND used
        // by async Tauri commands for retried+timed-out tmux dispatch via the
        // Tower stack. Mirrors AppState::ctx on the server side.
        .manage(tmuxy_core::Ctx::live())
        .setup(|app| {
            // Log environment for debugging Finder vs CLI launch differences
            tmuxy_core::debug_log::log("=== tmuxy starting ===");
            tmuxy_core::debug_log::log_env();

            // Materialize the per-user config layout on first run:
            //   ~/.config/tmuxy/tmuxy.conf   — main tmux config (prefix bindings, etc.)
            //   ~/.config/tmuxy/themes/*.css — bundled themes mirrored to disk
            // The CC connection's `tmux -f <conf> -CC new-session -A` picks up
            // the tmuxy.conf for create paths; existing sessions keep their
            // running settings (an attach sources the conf via source-file in
            // sync_initial_state). Without this call the prefix never gets
            // re-bound to C-a, the status bar's prefix indicator looks wrong,
            // and prefix-key sequences silently no-op for new users.
            let config_path = tmuxy_core::session::ensure_config();
            let themes_dir = tmuxy_core::session::ensure_themes();
            // Mirror the bundled CLI dispatcher and helper scripts so the
            // in-config command-aliases (Ctrl+hjkl nav, pane groups, …) and
            // the `tmuxy <subcommand>` shell wrapper can reach them by an
            // absolute path even when launched from Finder/Spotlight.
            let bin_dir = tmuxy_core::session::ensure_bin_scripts();
            tmuxy_core::debug_log::log(&format!("config: {:?}", config_path));
            tmuxy_core::debug_log::log(&format!("themes: {:?}", themes_dir));
            tmuxy_core::debug_log::log(&format!("bin: {:?}", bin_dir));

            // Patch the parent process PATH so any subprocess we spawn — including
            // executor::* paths that go through `sh -c "tmux ..."` — can resolve
            // tmux and the user's shell helpers. macOS launchd-spawned apps get
            // PATH=/usr/bin:/bin:/usr/sbin:/sbin (no Homebrew), which makes bare
            // `tmux` fail with "command not found" silently from inside the app.
            // Mirrors the per-child PATH augmentation in tmuxy_core::control_mode::connection.
            //
            // Done BEFORE the first async spawn / subprocess below so no other
            // task reads PATH concurrently with this write — `set_var` racing a
            // libc `getenv` on another thread is UB.
            #[cfg(target_os = "macos")]
            {
                // `~/.local/bin` holds the `tmuxy` shorthand the app writes on launch
                // (session::refresh_launcher); without it a pane's `tmuxy widget tree`
                // (the left sidebar) is "command not found" when launched from Finder.
                let local_bin = std::env::var("HOME")
                    .map(|h| format!("{h}/.local/bin"))
                    .unwrap_or_default();
                let extras: Vec<&str> =
                    ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
                        .into_iter()
                        .chain((!local_bin.is_empty()).then_some(local_bin.as_str()))
                        .collect();
                let current = std::env::var("PATH").unwrap_or_default();
                let missing: Vec<&str> = extras
                    .iter()
                    .copied()
                    .filter(|p| !current.split(':').any(|seg| seg == *p))
                    .collect();
                if !missing.is_empty() {
                    let prefixed = if current.is_empty() {
                        missing.join(":")
                    } else {
                        format!("{}:{}", missing.join(":"), current)
                    };
                    std::env::set_var("PATH", &prefixed);
                    tmuxy_core::debug_log::log(&format!(
                        "patched parent PATH for macOS Homebrew: prepended {}",
                        missing.join(":")
                    ));
                }
            }

            // Refresh ~/.local/bin/tmuxy → this binary, async so a slow
            // disk doesn't delay the splash window. Best-effort: failures
            // are logged but don't block startup.
            if let Ok(exe) = std::env::current_exe() {
                tauri::async_runtime::spawn(async move {
                    tmuxy_core::session::refresh_launcher(&exe);
                });
            } else {
                tmuxy_core::debug_log::log(
                    "current_exe() failed; tmuxy CLI shorthand not refreshed",
                );
            }

            // Create the main window programmatically so we can flip
            // transparent + Overlay titlebar based on TMUXY_OPAQUE_WINDOW.
            // tauri.conf.json's `windows: []` prevents auto-creation.
            //
            // Why: transparent windows need a compositor (Cocoa on macOS,
            // Mutter/Picom/etc. on Linux). Xvfb has none, so the WebView
            // paints onto a never-rendered surface and screenshots come
            // out monochrome. TMUXY_OPAQUE_WINDOW=1 lets tests in headless
            // CI/dev envs render visibly without changing prod defaults.
            create_main_window(app)?;

            // Verify tmux is available — the monitor will create the session
            // itself via control mode (avoids race between sync creation and
            // async monitor connection where the session can die in between)
            let tmux_bin = session::tmux_path();
            let session_name = tmuxy_core::session::session_name();
            tmuxy_core::debug_log::log(&format!("tmux binary: {}", tmux_bin));
            eprintln!("[tmuxy] tmux binary: {}", tmux_bin);
            eprintln!("[tmuxy] session name: {}", session_name);

            // Quick check that tmux is actually runnable
            match std::process::Command::new(tmux_bin).arg("-V").output() {
                Ok(output) if output.status.success() => {
                    let version = String::from_utf8_lossy(&output.stdout);
                    eprintln!("[tmuxy] {}", version.trim());
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let msg = format!(
                        "tmux failed to run.\n\nbinary: {}\nexit code: {}\nstderr: {}",
                        tmux_bin,
                        output.status.code().unwrap_or(-1),
                        stderr.trim()
                    );
                    return Err(msg.into());
                }
                Err(e) => {
                    let msg = format!(
                        "tmux binary not found or not executable.\n\nbinary: {}\nerror: {}",
                        tmux_bin, e
                    );
                    return Err(msg.into());
                }
            }

            // Set up native menu bar (macOS) with event handler
            if cfg!(target_os = "macos") {
                match build_app_menu(app) {
                    Ok(menu) => {
                        let _ = app.set_menu(menu);
                    }
                    Err(e) => eprintln!("Failed to build app menu: {}", e),
                }
                app.on_menu_event(handle_menu_event);
            }

            // Native blur behind the window, from tmuxy config
            if let Some(window) = app.get_webview_window("main") {
                apply_blur(&window);

                // Tell the frontend which platform we're on so it can adjust layout
                // (e.g., hide hamburger menu on macOS, add traffic light spacing)
                let platform = if cfg!(target_os = "macos") {
                    "macos"
                } else if cfg!(target_os = "windows") {
                    "windows"
                } else {
                    "linux"
                };
                let _ = window.eval(format!(
                    "document.documentElement.setAttribute('data-platform', '{}')",
                    platform
                ));
            }

            // Start control mode monitoring in background. The monitor
            // owns the live CC connection's command channel — handing the
            // shared MonitorState into the loop lets #[tauri::command]
            // handlers route mutations through that channel.
            let app_handle = app.handle().clone();
            let monitor_state = app.state::<monitor::MonitorState>().inner().clone();
            // Watch for `tmuxy connect` socket-switch requests. Shares the same
            // MonitorState so it can ask the monitor loop to reconnect.
            let connect_watch_state = monitor_state.clone();
            tauri::async_runtime::spawn(async move {
                monitor::poll_connect_requests(connect_watch_state).await;
            });
            tauri::async_runtime::spawn(async move {
                monitor::start_monitoring(app_handle, monitor_state).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Core commands
            commands::get_initial_state,
            commands::set_client_size,
            // Pane/window operations exercised by the Tauri webdriver test
            // (the production UI drives these through run_tmux_command).
            commands::split_pane_horizontal,
            commands::new_window,
            // General
            commands::run_tmux_command,
            commands::get_key_bindings,
            commands::get_keybindings_snapshot,
            // Copy mode + themes (mirrors the SSE server's invoke surface so
            // the React frontend's INVOKE / FETCH_SCROLLBACK_CELLS paths work
            // identically under Tauri)
            commands::get_scrollback_cells,
            commands::get_theme_settings,
            commands::set_theme,
            commands::set_theme_mode,
            commands::get_themes_list,
            // Window chrome: the status bar doubles as the title bar
            commands::set_titlebar_height,
            commands::titlebar_double_click,
            commands::open_url,
            // Server picker (desktop-only): list saved tmux servers and
            // live-reconnect to one (localhost socket switch or remote SSH).
            commands::list_servers,
            commands::connect_server,
            // Local action tracing (docs/TELEMETRY.md): the frontend tracer
            // queries `trace_enabled` and ships batches to `record_trace`.
            commands::trace_enabled,
            commands::restart_app,
            commands::record_trace,
            // Debug menu: read/flip the trace switch, level, and file.
            commands::get_trace_settings,
            commands::set_trace_enabled,
            commands::set_trace_level,
            commands::open_trace_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_option_reads_set_g_bare_value() {
        let cfg = "set -g @tmuxy-opacity 0.8\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-opacity"),
            Some("0.8".to_string())
        );
    }

    #[test]
    fn parse_option_reads_set_g_quoted_value() {
        let cfg = "set -g @tmuxy-blur \"off\"\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-blur"),
            Some("off".to_string())
        );
    }

    #[test]
    fn parse_option_ignores_comments() {
        let cfg = "# set -g @tmuxy-opacity 1.0\nset -g @tmuxy-opacity 0.8\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-opacity"),
            Some("0.8".to_string())
        );
    }

    #[test]
    fn parse_option_last_assignment_wins() {
        let cfg = "set -g @tmuxy-opacity 0.5\nset -g @tmuxy-opacity 0.8\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-opacity"),
            Some("0.8".to_string())
        );
    }

    #[test]
    fn parse_option_returns_none_when_missing() {
        let cfg = "set -g prefix C-a\n";
        assert_eq!(parse_option_from_config(cfg, "@tmuxy-opacity"), None);
    }

    #[test]
    fn parse_option_handles_multi_flag_forms() {
        let cfg = "set -ga @tmuxy-blur off\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-blur"),
            Some("off".to_string())
        );
    }
}
