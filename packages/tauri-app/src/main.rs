#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod monitor;

use tmuxy_core::session;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize tmux session
            match session::create_or_attach_default() {
                Ok(_) => println!("tmuxy session initialized"),
                Err(e) => {
                    eprintln!("Failed to create tmux session: {}", e);
                    eprintln!("Make sure tmux is installed and available in PATH");
                }
            }

            // Start monitoring in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                monitor::start_monitoring(app_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_keys_to_tmux,
            commands::get_initial_state,
            commands::initialize_session,
            commands::get_scrollback_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
