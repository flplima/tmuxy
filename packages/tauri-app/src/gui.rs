use tauri::Manager;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
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
/// This replaces the web-based hamburger menu when running as a desktop app,
/// giving users the standard macOS menu experience (Cmd+Q to quit, etc.).
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

    let file_menu = SubmenuBuilder::new(app, "File")
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    Ok(menu)
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

            // Set up native menu bar (macOS)
            if cfg!(target_os = "macos") {
                match build_app_menu(app) {
                    Ok(menu) => { let _ = app.set_menu(menu); },
                    Err(e) => eprintln!("Failed to build app menu: {}", e),
                }
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
