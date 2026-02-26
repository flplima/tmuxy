use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tmuxy_core::control_mode::{MonitorConfig, StateEmitter, TmuxMonitor};
use tmuxy_core::StateUpdate;

/// Get session name from environment or use default
fn get_session() -> String {
    std::env::var("TMUXY_SESSION").unwrap_or_else(|_| "tmuxy".to_string())
}

/// Tauri emitter that broadcasts state changes to the frontend
pub struct TauriEmitter {
    app: AppHandle,
}

impl TauriEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl StateEmitter for TauriEmitter {
    fn emit_state(&self, update: StateUpdate) {
        if let Err(e) = self.app.emit("tmux-state-update", &update) {
            eprintln!("Failed to emit state: {}", e);
        }
    }

    fn emit_error(&self, error: String) {
        if let Err(e) = self.app.emit("tmux-error", &error) {
            eprintln!("Failed to emit error: {}", e);
        }
    }
}

/// Start control mode monitoring for tmux state changes
pub async fn start_monitoring(app: AppHandle) {
    let emitter = TauriEmitter::new(app.clone());
    let session = get_session();

    let config = MonitorConfig {
        session,
        sync_interval: Duration::from_millis(500),
        create_session: false,
        // Adaptive throttling: emit immediately for low-frequency events (typing),
        // throttle at 16ms (~60fps) when high-frequency output detected
        throttle_interval: Duration::from_millis(16),
        throttle_threshold: 20,
        rate_window: Duration::from_millis(100),
        working_dir: None,
    };

    // Keep trying to connect with exponential backoff
    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);

    loop {
        match TmuxMonitor::connect(config.clone()).await {
            Ok(mut monitor) => {
                backoff = Duration::from_millis(100); // Reset on success

                // Emit keybindings on each successful connection
                emit_keybindings(&app);

                monitor.run(&emitter).await;
                // If we get here, the connection was closed - continue to reconnect
            }
            Err(e) => {
                emitter.emit_error(format!("Failed to connect to control mode: {}", e));
            }
        }

        // Exponential backoff before retry
        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

/// Emit keybindings to the frontend after a successful connection
fn emit_keybindings(app: &AppHandle) {
    let prefix_key = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".into());
    let prefix_bindings = tmuxy_core::get_prefix_bindings().unwrap_or_default();
    let root_bindings = tmuxy_core::get_root_bindings().unwrap_or_default();

    let payload = serde_json::json!({
        "prefix_key": prefix_key,
        "prefix_bindings": prefix_bindings,
        "root_bindings": root_bindings,
    });

    if let Err(e) = app.emit("tmux-keybindings", &payload) {
        eprintln!("Failed to emit keybindings: {}", e);
    }
}
