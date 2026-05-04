use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tmuxy_core::control_mode::{LogKind, LogSink, MonitorConfig, StateEmitter, TmuxMonitor};
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

impl LogSink for TauriEmitter {
    fn log(&self, kind: LogKind, message: String) {
        // Mirror to the persistent debug log so the user's "Copy Logs to
        // Clipboard" capture includes the *reason* a connection died.
        // Without this, sync_initial_state failures and broken-pipe errors
        // are only visible to the running UI and disappear on reconnect.
        let label = match kind {
            LogKind::Command => "CMD",
            LogKind::Output => "OUT",
            LogKind::Info => "INFO",
            LogKind::Error => "ERR",
        };
        tmuxy_core::debug_log::log(&format!("[monitor {}] {}", label, message));

        let payload = serde_json::json!({ "kind": kind, "message": message });
        if let Err(e) = self.app.emit("tmux-log", &payload) {
            eprintln!("Failed to emit log: {}", e);
        }
    }
}

impl StateEmitter for TauriEmitter {
    fn emit_state(&self, update: StateUpdate) {
        if let Err(e) = self.app.emit("tmux-state-update", &update) {
            eprintln!("Failed to emit state: {}", e);
        }
    }

    fn emit_error(&self, error: String) {
        tmuxy_core::debug_log::log(&format!("[monitor ERR] {}", error));
        if let Err(e) = self.app.emit("tmux-error", &error) {
            eprintln!("Failed to emit error: {}", e);
        }
    }
}

/// Start control mode monitoring for tmux state changes
pub async fn start_monitoring(app: AppHandle) {
    let emitter = Arc::new(TauriEmitter::new(app.clone()));
    let log_sink: Arc<dyn LogSink> = emitter.clone();
    let session = get_session();

    let config = MonitorConfig {
        session,
        sync_interval: Duration::from_millis(500),
        create_session: true,
        // Adaptive throttling: emit immediately for low-frequency events (typing),
        // throttle at 16ms (~60fps) when high-frequency output detected
        throttle_interval: Duration::from_millis(16),
        throttle_threshold: 20,
        rate_window: Duration::from_millis(100),
        working_dir: None,
    };

    // Reconnect with exponential backoff, bounded by MAX_CONSECUTIVE_FAILURES.
    //
    // A "consecutive failure" is either:
    //   1. A connect attempt that returned Err, OR
    //   2. A connect that succeeded but whose monitor.run() returned within
    //      MIN_HEALTHY_DURATION — i.e. tmux died right after handshake.
    //
    // Case 2 is the macOS-Finder-launch failure mode: `connect()` reads the
    // first %end and reports "control mode connected successfully", but tmux
    // exits ~50ms later, sync_initial_state fails on broken pipe, and run()
    // returns silently. Without this guard, the failure counter resets every
    // cycle and the loop runs forever.
    //
    // Only durable connections (ran ≥ MIN_HEALTHY_DURATION) reset the counter.
    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    const MIN_HEALTHY_DURATION: Duration = Duration::from_secs(5);

    let mut consecutive_failures: u32 = 0;

    loop {
        match TmuxMonitor::connect(config.clone(), Some(&log_sink)).await {
            Ok((mut monitor, _cmd_tx)) => {
                emit_keybindings(&app);
                let started = std::time::Instant::now();
                monitor.run(emitter.as_ref()).await;
                let lived = started.elapsed();
                tmuxy_core::debug_log::log(&format!(
                    "[monitor] run() returned after {:?} (failures so far: {})",
                    lived, consecutive_failures
                ));

                if lived >= MIN_HEALTHY_DURATION {
                    backoff = Duration::from_millis(100);
                    consecutive_failures = 0;
                } else {
                    consecutive_failures += 1;
                    let msg = format!(
                        "tmux connection died after {:?} (attempt {} of {})",
                        lived, consecutive_failures, MAX_CONSECUTIVE_FAILURES
                    );
                    tmuxy_core::debug_log::log(&format!("[monitor] {}", msg));
                    emitter.emit_error(msg);

                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        let final_msg = format!(
                            "tmux disconnects immediately after handshake; giving up after {} attempts. Connection lived {:?} on the last try.",
                            MAX_CONSECUTIVE_FAILURES, lived
                        );
                        emit_fatal(&app, &final_msg);
                        tmuxy_core::debug_log::log(&format!("[monitor] FATAL: {}", final_msg));
                        return;
                    }
                }
            }
            Err(e) => {
                consecutive_failures += 1;
                emitter.emit_error(format!(
                    "Failed to connect to control mode (attempt {} of {}): {}",
                    consecutive_failures, MAX_CONSECUTIVE_FAILURES, e
                ));

                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    let final_msg = format!(
                        "Unable to connect to tmux after {} attempts; giving up. Last error: {}",
                        MAX_CONSECUTIVE_FAILURES, e
                    );
                    emit_fatal(&app, &final_msg);
                    tmuxy_core::debug_log::log(&format!("[monitor] FATAL: {}", final_msg));
                    return;
                }
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

/// Emit a terminal failure event to the frontend.
/// The UI should treat this as a non-recoverable state — the monitor loop has
/// stopped and no further state updates will arrive.
fn emit_fatal(app: &AppHandle, message: &str) {
    let payload = serde_json::json!({ "message": message });
    if let Err(e) = app.emit("tmux-fatal", &payload) {
        eprintln!("Failed to emit fatal: {}", e);
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
