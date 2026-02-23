use serde_json::Value;
use tmuxy_core::{executor, session};

/// Get session name from environment or use default
fn get_session() -> String {
    std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string())
}

#[tauri::command]
pub async fn send_keys_to_tmux(keys: String) -> Result<(), String> {
    executor::send_keys(&get_session(), &keys)
}

#[tauri::command]
pub async fn process_key(key: String) -> Result<(), String> {
    tmuxy_core::process_key(&get_session(), &key)
}

#[tauri::command]
pub async fn get_initial_state(cols: Option<u32>, rows: Option<u32>) -> Result<Value, String> {
    // Resize if dimensions provided
    if let (Some(c), Some(r)) = (cols, rows) {
        let _ = executor::resize_window(&get_session(), c, r);
    }

    let state = tmuxy_core::capture_window_state_for_session(&get_session())?;
    serde_json::to_value(state).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_client_size(cols: u32, rows: u32) -> Result<(), String> {
    executor::resize_window(&get_session(), cols, rows)
}

#[tauri::command]
pub async fn initialize_session() -> Result<(), String> {
    session::create_or_attach(&get_session())
}

#[tauri::command]
pub async fn get_scrollback_history() -> Result<String, String> {
    executor::capture_pane_with_history(&get_session())
}

#[tauri::command]
pub async fn split_pane_horizontal() -> Result<(), String> {
    executor::split_pane_horizontal(&get_session())
}

#[tauri::command]
pub async fn split_pane_vertical() -> Result<(), String> {
    executor::split_pane_vertical(&get_session())
}

#[tauri::command]
pub async fn new_window() -> Result<(), String> {
    executor::new_window(&get_session())
}

#[tauri::command]
pub async fn select_pane(direction: String) -> Result<(), String> {
    executor::select_pane(&get_session(), &direction)
}

#[tauri::command]
pub async fn select_window(window: String) -> Result<(), String> {
    executor::select_window(&get_session(), &window)
}

#[tauri::command]
pub async fn next_window() -> Result<(), String> {
    executor::next_window(&get_session())
}

#[tauri::command]
pub async fn previous_window() -> Result<(), String> {
    executor::previous_window(&get_session())
}

#[tauri::command]
pub async fn kill_pane() -> Result<(), String> {
    executor::kill_pane(&get_session())
}

#[tauri::command]
pub async fn kill_window() -> Result<(), String> {
    executor::kill_window(&get_session())
}

#[tauri::command]
pub async fn select_pane_by_id(pane_id: String) -> Result<(), String> {
    executor::select_pane_by_id(&pane_id)
}

#[tauri::command]
pub async fn scroll_pane(pane_id: String, direction: String, amount: u32) -> Result<(), String> {
    executor::scroll_pane(&pane_id, &direction, amount)
}

#[tauri::command]
pub async fn send_mouse_event(
    pane_id: String,
    event_type: String,
    button: u32,
    x: u32,
    y: u32,
) -> Result<(), String> {
    executor::send_mouse_event(&pane_id, &event_type, button, x, y)
}

#[tauri::command]
pub async fn execute_prefix_binding(key: String) -> Result<(), String> {
    executor::execute_prefix_binding(&get_session(), &key)
}

#[tauri::command]
pub async fn run_tmux_command(command: String) -> Result<String, String> {
    executor::run_tmux_command_for_session(&get_session(), &command)
}

#[tauri::command]
pub async fn resize_pane(
    pane_id: String,
    direction: String,
    adjustment: u32,
) -> Result<(), String> {
    executor::resize_pane(&pane_id, &direction, adjustment)
}

#[tauri::command]
pub async fn resize_window(cols: u32, rows: u32) -> Result<(), String> {
    executor::resize_window(&get_session(), cols, rows)
}

#[tauri::command]
pub async fn get_key_bindings() -> Result<Value, String> {
    let bindings = tmuxy_core::get_prefix_bindings()?;
    let prefix = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".to_string());
    Ok(serde_json::json!({
        "prefix": prefix,
        "bindings": bindings
    }))
}
