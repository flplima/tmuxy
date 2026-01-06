use tmuxy_core::{executor, session, TmuxState};

#[tauri::command]
pub async fn send_keys_to_tmux(keys: String) -> Result<(), String> {
    executor::send_keys_default(&keys)
}

#[tauri::command]
pub async fn get_initial_state() -> Result<TmuxState, String> {
    tmuxy_core::capture_state()
}

#[tauri::command]
pub async fn initialize_session() -> Result<(), String> {
    session::create_or_attach_default()
}

#[tauri::command]
pub async fn get_scrollback_history() -> Result<String, String> {
    executor::capture_pane_with_history_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_send_keys_command_signature() {
        // This just tests that the command compiles with correct signature
        // Real testing would require tmux running
        let _result = send_keys_to_tmux("test".to_string()).await;
    }

    #[tokio::test]
    async fn test_get_initial_state_signature() {
        // This just tests that the command compiles with correct signature
        let _result = get_initial_state().await;
    }

    #[tokio::test]
    async fn test_initialize_session_signature() {
        // This just tests that the command compiles with correct signature
        let _result = initialize_session().await;
    }
}
