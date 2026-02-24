#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod monitor;

use tmuxy_core::session;

fn main() {
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
