use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Manager;
use tmuxy_core::{executor, session};

use crate::commands;
use crate::monitor;

/// Read a tmuxy user-option, preferring the live tmux server but falling back
/// to parsing `~/.config/tmuxy/tmuxy.conf` directly when the server isn't up
/// yet. The initial `apply_window_effects` call runs during Tauri setup —
/// before `monitor::start_monitoring` connects and sources the config — so
/// `show-options` would otherwise return empty and the macOS window would
/// open with no opacity/vibrancy on first launch.
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

/// Parse the @tmuxy-vibrancy value into a Tauri window effect.
fn parse_vibrancy(value: &str) -> Option<tauri::window::Effect> {
    use tauri::window::Effect;
    match value {
        // macOS effects (10.14+)
        "under-window" => Some(Effect::UnderWindowBackground),
        "sidebar" => Some(Effect::Sidebar),
        "content" => Some(Effect::ContentBackground),
        "header" => Some(Effect::HeaderView),
        "sheet" => Some(Effect::Sheet),
        "window" => Some(Effect::WindowBackground),
        "hud" => Some(Effect::HudWindow),
        "fullscreen-ui" => Some(Effect::FullScreenUI),
        "tooltip" => Some(Effect::Tooltip),
        "popover" => Some(Effect::Popover),
        "menu" => Some(Effect::Menu),
        "selection" => Some(Effect::Selection),
        // Windows effects
        "mica" => Some(Effect::Mica),
        "acrylic" => Some(Effect::Acrylic),
        "blur" => Some(Effect::Blur),
        "tabbed" => Some(Effect::Tabbed),
        _ => {
            eprintln!("Unknown vibrancy type: {}", value);
            None
        }
    }
}

/// Apply window effects from @tmuxy-opacity and @tmuxy-vibrancy.
///
/// Opacity controls terminal background transparency (0.0-1.0).
/// Vibrancy enables macOS native glass effects behind the transparent background.
/// Both can be used independently or together.
fn apply_window_effects(window: &tauri::WebviewWindow) {
    let opacity = read_tmuxy_option("@tmuxy-opacity")
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| v.clamp(0.0, 1.0));

    let active_pane_opacity = read_tmuxy_option("@tmuxy-active-pane-opacity")
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| v.clamp(0.0, 1.0));

    let vibrancy = read_tmuxy_option("@tmuxy-vibrancy")
        .and_then(|s| parse_vibrancy(&s).map(|effect| (s, effect)));

    // Apply vibrancy effect (macOS / Windows). Pin the effect state to Active
    // so the macOS blur stays applied when the window loses key focus. Without
    // this, NSVisualEffectView defaults to FollowsWindowActiveState — switching
    // away from the tmuxy window drops the blur and the configured @tmuxy-opacity
    // backing, leaving the inactive window opaque.
    if let Some((ref name, effect)) = vibrancy {
        let effects = tauri::window::EffectsBuilder::new()
            .effect(effect)
            .state(tauri::window::EffectState::Active)
            .build();
        if let Err(e) = window.set_effects(Some(effects)) {
            eprintln!("Failed to set vibrancy effect: {}", e);
        } else {
            println!("Applied vibrancy: {}", name);
        }
    }

    // Inject CSS custom properties for opacity and vibrancy into the frontend.
    // The frontend uses these to make backgrounds transparent so native effects show through.
    let mut js_parts = Vec::new();

    if let Some(opacity) = opacity {
        js_parts.push(format!(
            "document.documentElement.setAttribute('data-opacity', '{}')",
            opacity
        ));
        js_parts.push(format!(
            "document.documentElement.style.setProperty('--window-opacity', '{}')",
            opacity
        ));
    }

    if let Some(o) = active_pane_opacity {
        js_parts.push(format!(
            "document.documentElement.style.setProperty('--active-pane-opacity', '{}')",
            o
        ));
    }

    if let Some((ref name, _)) = vibrancy {
        js_parts.push(format!(
            "document.documentElement.setAttribute('data-vibrancy', '{}')",
            name
        ));
    }

    if !js_parts.is_empty() {
        let js = js_parts.join(";");
        let _ = window.eval(&js);
    }
}

/// Build the native macOS application menu bar.
///
/// Mirrors the web hamburger menu (Pane, Tab, Session, View, Help) plus
/// standard macOS menus (tmuxy app menu, Edit, Window).
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
        let label = display_theme_name(&name);
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
    // Exposes the same getSnapshot()/getRecentEvents() helpers we attach to
    // `window` for the browser console. Surfacing them in the OS menu means
    // bug reports can include a state dump without the user needing to open
    // devtools (which the production WebView build doesn't ship).
    let debug_menu = SubmenuBuilder::new(app, "Debug")
        .item(&MenuItem::with_id(
            app,
            "debug-copy-state",
            "Copy XState Snapshot",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "debug-copy-events",
            "Copy Recent Events",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "debug-copy-dom",
            "Copy DOM Snapshot",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "debug-copy-backend-log",
            "Copy Backend Log",
            true,
            None::<&str>,
        )?)
        .build()?;

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

/// Convert a theme file stem into a display label: "tokyonight" → "Tokyonight",
/// "cold-harbor" → "Cold Harbor". Mirrors the rough capitalization the web
/// menu uses for `displayName`.
fn display_theme_name(stem: &str) -> String {
    stem.split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
    if id == "help-copy-logs" || id == "debug-copy-backend-log" {
        copy_logs_to_clipboard(app_handle);
        return;
    }
    if id == "help-reveal-log-file" {
        reveal_log_file();
        return;
    }

    // Debug: copy frontend-side data (XState, DOM, events) to the clipboard.
    // The data lives in the WebView so we eval the read + clipboard write
    // there. The menu click is a fresh user gesture, which is enough for
    // navigator.clipboard.writeText() to succeed on macOS WKWebView.
    if let Some(js) = match id {
        "debug-copy-state" => Some(
            r#"(() => {
                try {
                    const snap = window.app?.getSnapshot?.();
                    const payload = JSON.stringify(snap?.context ?? null, null, 2);
                    navigator.clipboard.writeText(payload).then(
                        () => window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Copied XState snapshot to clipboard' }),
                        (e) => window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Clipboard write failed: ' + e })
                    );
                } catch (e) {
                    window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Could not read XState snapshot: ' + e });
                }
            })()"#,
        ),
        "debug-copy-events" => Some(
            r#"(() => {
                try {
                    const events = window.getRecentEvents?.() ?? [];
                    const payload = JSON.stringify(events, null, 2);
                    navigator.clipboard.writeText(payload).then(
                        () => window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Copied ' + events.length + ' recent events to clipboard' }),
                        (e) => window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Clipboard write failed: ' + e })
                    );
                } catch (e) {
                    window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Could not read recent events: ' + e });
                }
            })()"#,
        ),
        "debug-copy-dom" => Some(
            r#"(() => {
                try {
                    const lines = window.getSnapshot?.() ?? [];
                    const payload = lines.join('\n');
                    navigator.clipboard.writeText(payload).then(
                        () => window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Copied DOM snapshot to clipboard' }),
                        (e) => window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Clipboard write failed: ' + e })
                    );
                } catch (e) {
                    window.app?.send({ type: 'SHOW_STATUS_MESSAGE', text: 'Could not read DOM snapshot: ' + e });
                }
            })()"#,
        ),
        _ => None,
    } {
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.eval(js);
        }
        return;
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
/// behavior is unchanged: transparent webview, hidden macOS title with
/// traffic-light dot positioning. The opaque branch removes both — needed
/// when running under Xvfb-style displays that lack a compositor.
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
            use tauri::{LogicalPosition, TitleBarStyle};
            // Vertically center the traffic-light cluster on the visible
            // status-bar midline (y = 18 for a 36px statusbar). Tauri's
            // traffic_light_position is interpreted by Cocoa as an
            // offset from the implicit title-bar origin under Overlay
            // style, NOT the top of our webview content — math based on
            // statusbar pixels alone undershoots. Empirically y=18 lands
            // the cluster center on the tab-button midline; lower values
            // (e.g. 11) push the buttons to the very top of the bar.
            builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(16.0, 18.0));
        }
    }

    builder.build()?;

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
            show_status_message(app, &msg, true);
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
            show_status_message(
                app,
                &format!("Copied {} log to clipboard", path.display()),
                false,
            );
        }
        Err(e) => {
            show_status_message(app, &format!("Failed to write clipboard: {}", e), true);
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
/// Matches `ShowStatusMessageEvent` in tmuxy-ui (event.text). The is_error
/// flag is reserved for future styling but currently both render the same.
fn show_status_message(app: &tauri::AppHandle, message: &str, _is_error: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
        let js = format!(
            "window.app?.send({{ type: 'SHOW_STATUS_MESSAGE', text: '{}' }})",
            escaped
        );
        let _ = window.eval(js);
    }
}

/// Start the Tauri GUI application.
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // WebDriver plugin: enables GUI testing via W3C WebDriver on all platforms
    // including macOS (where the official tauri-driver doesn't support WKWebView).
    // Only included when built with --features webdriver.
    #[cfg(feature = "webdriver")]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
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

            // Patch the parent process PATH so any subprocess we spawn — including
            // executor::* paths that go through `sh -c "tmux ..."` — can resolve
            // tmux and the user's shell helpers. macOS launchd-spawned apps get
            // PATH=/usr/bin:/bin:/usr/sbin:/sbin (no Homebrew), which makes bare
            // `tmux` fail with "command not found" silently from inside the app.
            // Mirrors the per-child PATH augmentation in tmuxy_core::control_mode::connection.
            #[cfg(target_os = "macos")]
            {
                let extras = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
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
                    // SAFETY: we're in setup before any threads/subprocesses are spawned.
                    std::env::set_var("PATH", &prefixed);
                    tmuxy_core::debug_log::log(&format!(
                        "patched parent PATH for macOS Homebrew: prepended {}",
                        missing.join(":")
                    ));
                }
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
            let session_name =
                std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string());
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

            // Apply window effects from tmuxy config
            if let Some(window) = app.get_webview_window("main") {
                apply_window_effects(&window);

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
            commands::send_keys_to_tmux,
            commands::process_key,
            commands::get_initial_state,
            commands::set_client_size,
            commands::initialize_session,
            commands::get_scrollback_history,
            // Pane operations
            commands::split_pane_horizontal,
            commands::split_pane_vertical,
            commands::select_pane,
            commands::select_pane_by_id,
            commands::kill_pane,
            commands::resize_pane,
            commands::scroll_pane,
            commands::send_mouse_event,
            // Window operations
            commands::new_window,
            commands::select_window,
            commands::next_window,
            commands::previous_window,
            commands::kill_window,
            commands::resize_window,
            // General
            commands::run_tmux_command,
            commands::execute_prefix_binding,
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
            // Server picker (desktop-only): list saved tmux servers and
            // live-reconnect to one (localhost socket switch or remote SSH).
            commands::list_servers,
            commands::connect_server,
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
        let cfg = "set -g @tmuxy-vibrancy \"under-window\"\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-vibrancy"),
            Some("under-window".to_string())
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
        let cfg = "set -ga @tmuxy-vibrancy sidebar\n";
        assert_eq!(
            parse_option_from_config(cfg, "@tmuxy-vibrancy"),
            Some("sidebar".to_string())
        );
    }
}
