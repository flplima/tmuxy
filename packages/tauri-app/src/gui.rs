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

/// Start the Tauri GUI application.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize tmux session
            let session_name =
                std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string());
            match session::create_or_attach(&session_name) {
                Ok(_) => println!("tmuxy session '{}' initialized", session_name),
                Err(e) => {
                    eprintln!("Failed to create tmux session: {}", e);
                    eprintln!("Make sure tmux is installed and available in PATH");
                }
            }

            // Apply window effects from tmuxy config
            if let Some(window) = app.get_webview_window("main") {
                apply_window_effects(&window);
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
