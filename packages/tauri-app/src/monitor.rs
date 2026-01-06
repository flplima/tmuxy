use tauri::{AppHandle, Emitter};
use tokio::time::{interval, Duration};
use tmuxy_core::TmuxError;

pub async fn start_monitoring(app: AppHandle) {
    let mut interval = interval(Duration::from_millis(100));
    let mut previous_hash = String::new();

    loop {
        interval.tick().await;

        match tmuxy_core::capture_state() {
            Ok(state) => {
                // Create a hash of all pane contents, active state, AND windows to detect changes
                let pane_hash: String = state
                    .panes
                    .iter()
                    .map(|p| format!("{}:{}:{}", p.id, p.active, p.content.join("")))
                    .collect::<Vec<_>>()
                    .join("|");
                let window_hash: String = state
                    .windows
                    .iter()
                    .map(|w| format!("{}:{}:{}", w.index, w.name, w.active))
                    .collect::<Vec<_>>()
                    .join("|");
                let current_hash = format!("{}||{}", pane_hash, window_hash);

                if current_hash != previous_hash {
                    if let Err(e) = app.emit("tmux-state-changed", &state) {
                        eprintln!("Failed to emit state: {}", e);
                    }
                    previous_hash = current_hash;
                }
            }
            Err(e) => {
                if let Err(e) = app.emit("tmux-error", TmuxError { message: e }) {
                    eprintln!("Failed to emit error: {}", e);
                }
            }
        }
    }
}
