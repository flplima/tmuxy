use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Manager;
use tmuxy_core::{executor, session};

use crate::commands;
use crate::monitor;

/// Read a tmuxy user-option from tmux globals, returning None if unset or empty.
fn read_tmuxy_option(name: &str) -> Option<String> {
    executor::execute_tmux_command(&["show-options", "-gqv", name])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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

    let vibrancy = read_tmuxy_option("@tmuxy-vibrancy")
        .and_then(|s| parse_vibrancy(&s).map(|effect| (s, effect)));

    // Apply vibrancy effect (macOS / Windows)
    if let Some((ref name, effect)) = vibrancy {
        let effects = tauri::window::EffectsBuilder::new().effect(effect).build();
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
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

/// Convert a theme file stem into a display label: "tokyonight" → "Tokyonight",
/// "gruvbox-material" → "Gruvbox Material". Mirrors the rough capitalization
/// the web menu uses for `displayName`.
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

/// Handle native menu item clicks.
///
/// Tmux commands are executed directly via the control mode connection.
/// Frontend-only actions (font size) are dispatched via window.eval().
fn handle_menu_event(app_handle: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();

    // Map menu IDs to tmux commands (mirrors menuActions.ts)
    let tmux_cmd = match id {
        // Pane
        "pane-split-below" => Some("split-window -v"),
        "pane-split-right" => Some("split-window -h"),
        "pane-next" => Some("select-pane -t :.+"),
        "pane-previous" => Some("last-pane"),
        "pane-swap-prev" => Some("swap-pane -U"),
        "pane-swap-next" => Some("swap-pane -D"),
        "pane-move-new-tab" => Some("break-pane"),
        "pane-add-to-group" => {
            Some("run-shell \"bin/tmuxy/pane-group-add #{pane_id} #{pane_width} #{pane_height}\"")
        }
        "pane-copy-mode" => Some("copy-mode"),
        "pane-paste" => Some("paste-buffer"),
        "pane-clear" => Some("send-keys -R \\; clear-history"),
        "pane-close" => Some("kill-pane"),
        "view-zoom" => Some("resize-pane -Z"),
        // Tab
        "tab-new" => Some("new-window"),
        "tab-next" => Some("next-window"),
        "tab-previous" => Some("previous-window"),
        "tab-last" => Some("last-window"),
        "tab-rename" => Some("command-prompt -I \"#W\" \"rename-window -- '%%'\""),
        "tab-close" => Some("kill-window"),
        // Session
        "session-new" => Some("new-session -d"),
        "session-rename" => Some("command-prompt -I \"#S\" \"rename-session -- '%%'\""),
        "session-detach" => Some("detach-client"),
        "session-kill" => Some("kill-session"),
        "session-reload-config" => Some("source-file ~/.tmux.conf"),
        // View — Layouts
        "view-layout-even-horizontal" => Some("select-layout even-horizontal"),
        "view-layout-even-vertical" => Some("select-layout even-vertical"),
        "view-layout-main-horizontal" => Some("select-layout main-horizontal"),
        "view-layout-main-vertical" => Some("select-layout main-vertical"),
        "view-layout-tiled" => Some("select-layout tiled"),
        _ => None,
    };

    if let Some(cmd) = tmux_cmd {
        let session = std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string());
        if let Err(e) = executor::run_tmux_command_for_session(&session, cmd) {
            eprintln!("[menu] Failed to execute '{}': {}", cmd, e);
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
        .fullscreen(false);

    if !opaque {
        builder = builder.transparent(true);

        #[cfg(target_os = "macos")]
        {
            use tauri::{LogicalPosition, TitleBarStyle};
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
            tmuxy_core::debug_log::log(&format!("config: {:?}", config_path));
            tmuxy_core::debug_log::log(&format!("themes: {:?}", themes_dir));

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

            // Start control mode monitoring in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                monitor::start_monitoring(app_handle).await;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
