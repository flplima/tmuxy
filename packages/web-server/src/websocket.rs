use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::time::interval;
use tmuxy_core::control_mode::{MonitorConfig, StateEmitter, TmuxMonitor};
use tmuxy_core::{executor, session, TmuxError, TmuxState};

use crate::AppState;

// ============================================
// WebSocket State Emitter (Adapter Pattern)
// ============================================

/// Emitter that broadcasts state changes to WebSocket clients
pub struct WebSocketEmitter {
    tx: broadcast::Sender<String>,
}

impl WebSocketEmitter {
    pub fn new(tx: broadcast::Sender<String>) -> Self {
        Self { tx }
    }
}

impl StateEmitter for WebSocketEmitter {
    fn emit_state(&self, state: TmuxState) {
        let msg = ServerMessage::Event {
            name: "tmux-state-changed".to_string(),
            payload: serde_json::to_value(&state).unwrap(),
        };
        let _ = self.tx.send(serde_json::to_string(&msg).unwrap());
    }

    fn emit_error(&self, error: String) {
        let msg = ServerMessage::Event {
            name: "tmux-error".to_string(),
            payload: serde_json::to_value(TmuxError { message: error }).unwrap(),
        };
        let _ = self.tx.send(serde_json::to_string(&msg).unwrap());
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "invoke")]
    Invoke { id: String, cmd: String, args: serde_json::Value },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "response")]
    Response { id: String, result: serde_json::Value },
    #[serde(rename = "error")]
    Error { id: String, error: String },
    #[serde(rename = "event")]
    Event { name: String, payload: serde_json::Value },
}

pub async fn handle_socket(socket: WebSocket, _state: Arc<AppState>, session: String) {
    let (mut sender, mut receiver) = socket.split();

    // Create per-connection broadcast channel for this session's state updates
    let (session_tx, mut session_rx) = broadcast::channel::<String>(100);

    // Ensure the session exists (create if needed)
    if let Err(e) = session::create_or_attach(&session) {
        eprintln!("Failed to create/attach session '{}': {}", session, e);
    }

    // Start monitoring for this specific session
    let monitor_session = session.clone();
    let monitor_tx = session_tx.clone();
    let monitor_handle = tokio::spawn(async move {
        start_monitoring(monitor_tx, monitor_session).await;
    });

    // Channel for sending responses back to this specific client
    let (response_tx, mut response_rx) = tokio::sync::mpsc::channel::<String>(100);

    // Task to forward messages to the WebSocket (both session state and direct responses)
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Handle session-specific state changes
                Ok(msg) = session_rx.recv() => {
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                // Handle direct responses to this client
                Some(msg) = response_rx.recv() => {
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Clone session for use in command handler
    let cmd_session = session.clone();

    // Task to handle incoming messages
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    let response = handle_command(client_msg, &cmd_session).await;
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap()).await;
                }
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    };

    // Abort the monitor task when connection closes
    monitor_handle.abort();
}

async fn handle_command(msg: ClientMessage, session: &str) -> ServerMessage {
    match msg {
        ClientMessage::Invoke { id, cmd, args } => {
            match cmd.as_str() {
                "send_keys_to_tmux" => {
                    let keys = args.get("keys")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    match executor::send_keys(session, keys) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "get_initial_state" => {
                    match tmuxy_core::capture_window_state_for_session(session) {
                        Ok(state) => ServerMessage::Response {
                            id,
                            result: serde_json::to_value(state).unwrap(),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "initialize_session" => {
                    match session::create_or_attach(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "get_scrollback_history" => {
                    match executor::capture_pane_with_history(session) {
                        Ok(history) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(history),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "split_pane_horizontal" => {
                    match executor::split_pane_horizontal(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "split_pane_vertical" => {
                    match executor::split_pane_vertical(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "new_window" => {
                    match executor::new_window(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "select_pane" => {
                    let direction = args.get("direction")
                        .and_then(|v| v.as_str())
                        .unwrap_or("right");
                    match executor::select_pane(session, direction) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "select_window" => {
                    let window = args.get("window")
                        .and_then(|v| v.as_str())
                        .unwrap_or("1");
                    match executor::select_window(session, window) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "next_window" => {
                    match executor::next_window(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "previous_window" => {
                    match executor::previous_window(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "kill_pane" => {
                    match executor::kill_pane(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "select_pane_by_id" => {
                    let pane_id = args.get("paneId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("%0");
                    match executor::select_pane_by_id(pane_id) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "scroll_pane" => {
                    let pane_id = args.get("paneId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("%0");
                    let direction = args.get("direction")
                        .and_then(|v| v.as_str())
                        .unwrap_or("down");
                    let amount = args.get("amount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1) as u32;
                    match executor::scroll_pane(pane_id, direction, amount) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "send_mouse_event" => {
                    let pane_id = args.get("paneId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("%0");
                    let event_type = args.get("eventType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("press");
                    let button = args.get("button")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    let x = args.get("x")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    let y = args.get("y")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    match executor::send_mouse_event(pane_id, event_type, button, x, y) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "execute_prefix_binding" => {
                    let key = args.get("key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    match executor::execute_prefix_binding(session, key) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "kill_window" => {
                    match executor::kill_window(session) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "run_tmux_command" => {
                    let command = args.get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    match executor::run_tmux_command_for_session(session, command) {
                        Ok(output) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(output),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "resize_pane" => {
                    let pane_id = args.get("paneId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("%0");
                    let direction = args.get("direction")
                        .and_then(|v| v.as_str())
                        .unwrap_or("R");
                    let adjustment = args.get("adjustment")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1) as u32;
                    match executor::resize_pane(pane_id, direction, adjustment) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "resize_window" => {
                    let cols = args.get("cols")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(80) as u32;
                    let rows = args.get("rows")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(24) as u32;
                    match executor::resize_window(session, cols, rows) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!({"success": true}),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "get_key_bindings" => {
                    match tmuxy_core::get_prefix_bindings() {
                        Ok(bindings) => {
                            let prefix = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".to_string());
                            ServerMessage::Response {
                                id,
                                result: serde_json::json!({
                                    "prefix": prefix,
                                    "bindings": bindings
                                }),
                            }
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                _ => ServerMessage::Error {
                    id,
                    error: format!("Unknown command: {}", cmd),
                },
            }
        }
    }
}

/// Polling-based monitoring (legacy fallback)
pub async fn start_monitoring_polling(tx: broadcast::Sender<String>) {
    let mut interval = interval(Duration::from_millis(100));
    let mut previous_hash = String::new();

    loop {
        interval.tick().await;

        match tmuxy_core::capture_window_state() {
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
                    let msg = ServerMessage::Event {
                        name: "tmux-state-changed".to_string(),
                        payload: serde_json::to_value(&state).unwrap(),
                    };
                    let _ = tx.send(serde_json::to_string(&msg).unwrap());
                    previous_hash = current_hash;
                }
            }
            Err(e) => {
                let msg = ServerMessage::Event {
                    name: "tmux-error".to_string(),
                    payload: serde_json::to_value(TmuxError { message: e }).unwrap(),
                };
                let _ = tx.send(serde_json::to_string(&msg).unwrap());
            }
        }
    }
}

/// Control mode monitoring (event-driven, supports raw escape sequences)
pub async fn start_monitoring_control_mode(tx: broadcast::Sender<String>, session: String) {
    let emitter = WebSocketEmitter::new(tx.clone());

    let config = MonitorConfig {
        session,
        sync_interval: Duration::from_millis(500),
        create_session: false,
    };

    // Keep trying to connect with exponential backoff
    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);

    loop {
        match TmuxMonitor::connect(config.clone()).await {
            Ok(mut monitor) => {
                backoff = Duration::from_millis(100); // Reset on success
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

/// Start monitoring with automatic mode selection.
/// Uses control mode if available, falls back to polling.
pub async fn start_monitoring(tx: broadcast::Sender<String>, session: String) {
    // Try control mode first (set TMUXY_USE_POLLING=1 to use polling instead)
    let use_control_mode = std::env::var("TMUXY_USE_POLLING")
        .map(|v| v != "1" && v != "true")
        .unwrap_or(true);

    if use_control_mode {
        start_monitoring_control_mode(tx, session).await;
    } else {
        start_monitoring_polling(tx).await;
    }
}
