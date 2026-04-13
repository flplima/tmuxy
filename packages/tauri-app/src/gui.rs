use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
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
fn build_app_menu(app: &tauri::App) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
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
        .item(&MenuItem::with_id(app, "pane-split-below", "Split Below", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-split-right", "Split Right", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "pane-next", "Next Pane", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-previous", "Previous Pane", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "pane-swap-prev", "Swap with Previous", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-swap-next", "Swap with Next", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-move-new-tab", "Move to New Tab", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-add-to-group", "Add to Group", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "pane-copy-mode", "Copy Mode", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-paste", "Paste Buffer", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "pane-clear", "Clear Screen", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "view-zoom", "Zoom Pane", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "pane-close", "Close Pane", true, None::<&str>)?)
        .build()?;

    // --- Tab ---
    let tab_menu = SubmenuBuilder::new(app, "Tab")
        .item(&MenuItem::with_id(app, "tab-new", "New Tab", true, Some("CmdOrCtrl+T"))?)
        .separator()
        .item(&MenuItem::with_id(app, "tab-next", "Next Tab", true, Some("CmdOrCtrl+Shift+]"))?)
        .item(&MenuItem::with_id(app, "tab-previous", "Previous Tab", true, Some("CmdOrCtrl+Shift+["))?)
        .item(&MenuItem::with_id(app, "tab-last", "Last Tab", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "tab-rename", "Rename Tab", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "tab-close", "Close Tab", true, Some("CmdOrCtrl+W"))?)
        .build()?;

    // --- Session ---
    let session_menu = SubmenuBuilder::new(app, "Session")
        .item(&MenuItem::with_id(app, "session-new", "New Session", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "session-rename", "Rename Session", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "session-detach", "Detach Session", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "session-kill", "Kill Session", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "session-reload-config", "Reload Config", true, None::<&str>)?)
        .build()?;

    // --- View ---
    let layout_menu = SubmenuBuilder::new(app, "Layout")
        .item(&MenuItem::with_id(app, "view-layout-even-horizontal", "Even Horizontal", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "view-layout-even-vertical", "Even Vertical", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "view-layout-main-horizontal", "Main Horizontal", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "view-layout-main-vertical", "Main Vertical", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "view-layout-tiled", "Tiled", true, None::<&str>)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&layout_menu)
        .separator()
        .item(&MenuItem::with_id(app, "view-font-bigger", "Make Text Bigger", true, Some("CmdOrCtrl+Plus"))?)
        .item(&MenuItem::with_id(app, "view-font-smaller", "Make Text Smaller", true, Some("CmdOrCtrl+-"))?)
        .item(&MenuItem::with_id(app, "view-font-reset", "Reset Text Size", true, Some("CmdOrCtrl+0"))?)
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
        .item(&MenuItem::with_id(app, "help-github", "Tmuxy on GitHub", true, None::<&str>)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&pane_menu)
        .item(&tab_menu)
        .item(&session_menu)
        .item(&view_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
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
        "pane-add-to-group" => Some("run-shell \"bin/tmuxy/pane-group-add #{pane_id} #{pane_width} #{pane_height}\""),
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

    // Frontend-only actions — dispatch via JS eval
    if let Some(window) = app_handle.get_webview_window("main") {
        let js = match id {
            "view-font-bigger" => Some("window.app?.send({ type: 'INCREASE_FONT_SIZE' })"),
            "view-font-smaller" => Some("window.app?.send({ type: 'DECREASE_FONT_SIZE' })"),
            "view-font-reset" => Some("window.app?.send({ type: 'RESET_FONT_SIZE' })"),
            "help-github" => Some("window.open('https://github.com/flplima/tmuxy', '_blank')"),
            _ => None,
        };
        if let Some(js) = js {
            let _ = window.eval(js);
        }
    }
}

/// Start the Tauri GUI application.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize tmux session — abort if this fails (no point showing
            // a broken UI that can't talk to tmux)
            let session_name =
                std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string());
            if let Err(e) = session::create_or_attach(&session_name) {
                let msg = format!(
                    "Failed to connect to tmux: {}\n\nMake sure tmux is installed.",
                    e
                );
                eprintln!("{}", msg);
                // Show a native error dialog so the user knows what happened
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(&format!(
                        "document.body.innerHTML = '<pre style=\"padding:2em;color:#f88\">{}</pre>'",
                        msg.replace('\'', "\\'").replace('\n', "\\n")
                    ));
                }
                return Err(msg.into());
            }
            println!("tmuxy session '{}' initialized", session_name);

            // Set up native menu bar (macOS) with event handler
            if cfg!(target_os = "macos") {
                match build_app_menu(app) {
                    Ok(menu) => { let _ = app.set_menu(menu); },
                    Err(e) => eprintln!("Failed to build app menu: {}", e),
                }
                app.on_menu_event(handle_menu_event);
            }

            // Apply window effects from tmuxy config
            if let Some(window) = app.get_webview_window("main") {
                apply_window_effects(&window);

                // Tell the frontend which platform we're on so it can adjust layout
                // (e.g., hide hamburger menu on macOS, add traffic light spacing)
                let platform = if cfg!(target_os = "macos") { "macos" }
                    else if cfg!(target_os = "windows") { "windows" }
                    else { "linux" };
                let _ = window.eval(&format!(
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
