use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};
use tokio::time::interval;
use tmuxy_core::control_mode::{MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor};
use tmuxy_core::{executor, session, StateUpdate, TmuxError};

use crate::{AppState, SessionConnections};

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
    fn emit_state(&self, update: StateUpdate) {
        // Send StateUpdate directly - frontend will handle full vs delta
        let msg = ServerMessage::Event {
            name: "tmux-state-update".to_string(),
            payload: serde_json::to_value(&update).unwrap(),
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
    #[serde(rename = "connection_info")]
    ConnectionInfo { connection_id: u64, is_primary: bool },
    #[serde(rename = "primary_changed")]
    PrimaryChanged { is_primary: bool },
}

pub async fn handle_socket(socket: WebSocket, state: Arc<AppState>, session: String) {
    let (mut sender, mut receiver) = socket.split();

    // Generate unique connection ID
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::SeqCst);

    // Channel for sending direct messages to this connection (for primary_changed notifications)
    let (direct_tx, mut direct_rx) = mpsc::channel::<String>(100);

    // Ensure the session exists BEFORE starting monitor (prevents race condition)
    if let Err(e) = session::create_or_attach(&session) {
        eprintln!("Failed to create/attach session '{}': {}", session, e);
    }

    // Register connection and get/create shared session resources
    // Spawning monitor is done inside the lock to prevent race conditions
    let (is_primary, session_rx) = {
        let mut sessions = state.sessions.write().await;
        let session_conns = sessions.entry(session.clone()).or_insert_with(SessionConnections::new);

        // First connection becomes primary
        let is_primary = session_conns.primary_id.is_none();
        if is_primary {
            session_conns.primary_id = Some(conn_id);
        }
        session_conns.connections.push(conn_id);
        session_conns.connection_channels.insert(conn_id, direct_tx.clone());

        // Subscribe to shared session state channel
        let session_rx = session_conns.state_tx.subscribe();

        // Start monitor if not already running (atomic with registration to prevent races)
        if session_conns.monitor_handle.is_none() {
            let monitor_session = session.clone();
            let monitor_state = state.clone();
            let monitor_tx = session_conns.state_tx.clone();

            let handle = tokio::spawn(async move {
                start_monitoring(monitor_tx, monitor_session, monitor_state).await;
            });
            session_conns.monitor_handle = Some(handle);
            eprintln!("[handle_socket] Started monitor for session '{}'", session);
        }

        (is_primary, session_rx)
    };

    // Send connection_info to client
    let conn_info_msg = ServerMessage::ConnectionInfo {
        connection_id: conn_id,
        is_primary,
    };
    if sender.send(Message::Text(serde_json::to_string(&conn_info_msg).unwrap().into())).await.is_err() {
        // Connection failed immediately, cleanup
        cleanup_connection(&state, &session, conn_id).await;
        return;
    }

    // Channel for sending responses back to this specific client
    let (response_tx, mut response_rx) = mpsc::channel::<String>(100);

    // Need mutable session_rx for recv()
    let mut session_rx = session_rx;

    // Task to forward messages to the WebSocket (session state, direct responses, and direct messages)
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Handle session-specific state changes (shared across all clients in this session)
                result = session_rx.recv() => {
                    match result {
                        Ok(msg) => {
                            if sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // Client fell behind, skip missed messages and continue
                            eprintln!("[ws] Client {} lagged by {} messages", conn_id, n);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            // Channel closed - session monitor stopped
                            break;
                        }
                    }
                }
                // Handle direct responses to this client (command responses)
                Some(msg) = response_rx.recv() => {
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                // Handle direct messages to this client (primary_changed notifications)
                Some(msg) = direct_rx.recv() => {
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                // All channels closed - exit gracefully
                else => break,
            }
        }
    });

    // Clone session for use in command handler
    let cmd_session = session.clone();
    let cmd_state = state.clone();
    let cmd_conn_id = conn_id;

    // Task to handle incoming messages
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    let response = handle_command(client_msg, &cmd_session, &cmd_state, cmd_conn_id).await;
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

    // Cleanup connection and potentially promote new primary
    // (monitor is stopped when last client disconnects, not per-connection)
    cleanup_connection(&state, &session, conn_id).await;
}

/// Remove a connection and promote next primary if needed.
/// Recomputes the minimum client size and resizes the tmux session.
/// Stops the session monitor when the last client disconnects.
async fn cleanup_connection(state: &Arc<AppState>, session: &str, conn_id: u64) {
    let (notify_primary, resize_to, command_tx, monitor_handle) = {
        let mut sessions = state.sessions.write().await;

        let mut notify: Option<(mpsc::Sender<String>, String)> = None;
        let mut resize = None;
        let mut cmd_tx = None;
        let mut handle: Option<tokio::task::JoinHandle<()>> = None;

        if let Some(session_conns) = sessions.get_mut(session) {
            // Remove this connection
            session_conns.connections.retain(|&id| id != conn_id);
            session_conns.connection_channels.remove(&conn_id);
            let had_size = session_conns.client_sizes.remove(&conn_id).is_some();

            // If this was the primary, promote the next connection
            if session_conns.primary_id == Some(conn_id) {
                session_conns.primary_id = None;

                if let Some(&next_primary_id) = session_conns.connections.first() {
                    session_conns.primary_id = Some(next_primary_id);

                    // Prepare notification (sent outside the lock)
                    if let Some(channel) = session_conns.connection_channels.get(&next_primary_id) {
                        let msg = ServerMessage::PrimaryChanged { is_primary: true };
                        notify = Some((channel.clone(), serde_json::to_string(&msg).unwrap()));
                    }
                }
            }

            // Clean up empty sessions
            if session_conns.connections.is_empty() {
                // Last client disconnected - take monitor resources for graceful shutdown
                handle = session_conns.monitor_handle.take();
                cmd_tx = session_conns.monitor_command_tx.take();
                eprintln!("[cleanup] Last client for session '{}' disconnected, stopping monitor (handle={:?}, cmd_tx={})",
                    session, handle.is_some(), cmd_tx.is_some());
                sessions.remove(session);
            } else if had_size && !session_conns.client_sizes.is_empty() {
                // Recompute minimum size after removing this client
                resize = Some(compute_min_client_size(&session_conns.client_sizes));
                cmd_tx = session_conns.monitor_command_tx.clone();
            }
        }

        (notify, resize, cmd_tx, handle)
    }; // Lock dropped here

    // Stop the monitor if this was the last client
    // Use graceful shutdown to avoid crashing tmux 3.3a
    if let Some(handle) = monitor_handle {
        // Try graceful shutdown first (sends detach-client and waits)
        if let Some(ref tx) = command_tx {
            eprintln!("[cleanup] Sending graceful shutdown to monitor");
            let _ = tx.send(MonitorCommand::Shutdown).await;
            // Wait a bit for the monitor to process the shutdown
            tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;
        }
        // If still running, abort the task
        if !handle.is_finished() {
            handle.abort();
            eprintln!("[cleanup] Monitor task aborted (shutdown timed out)");
        } else {
            eprintln!("[cleanup] Monitor task finished gracefully");
        }
        // Don't try to resize after stopping the monitor
        return;
    }

    // Send primary changed notification outside the lock
    if let Some((channel, msg)) = notify_primary {
        let _ = channel.send(msg).await;
    }

    // Resize tmux session to new minimum (may grow if the smallest client left)
    if let Some((min_cols, min_rows)) = resize_to {
        if let Some(tx) = command_tx {
            let _ = tx.send(MonitorCommand::ResizeWindow { cols: min_cols, rows: min_rows }).await;
        } else {
            let _ = executor::resize_window(session, min_cols, min_rows);
        }
    }
}

/// Compute the minimum (cols, rows) across all connected clients.
/// Like native tmux, the session is sized to the smallest client.
fn compute_min_client_size(sizes: &std::collections::HashMap<u64, (u32, u32)>) -> (u32, u32) {
    let min_cols = sizes.values().map(|(c, _)| *c).min().unwrap_or(80);
    let min_rows = sizes.values().map(|(_, r)| *r).min().unwrap_or(24);
    (min_cols, min_rows)
}

/// Store a client's viewport size and resize the tmux session to the minimum across all clients.
async fn set_client_size(state: &Arc<AppState>, session: &str, conn_id: u64, cols: u32, rows: u32) {
    eprintln!("[size] Client {} set size: {}x{}", conn_id, cols, rows);
    let (min_size, command_tx) = {
        let mut sessions = state.sessions.write().await;
        if let Some(session_conns) = sessions.get_mut(session) {
            session_conns.client_sizes.insert(conn_id, (cols, rows));
            let sizes = &session_conns.client_sizes;
            eprintln!("[size] All clients: {:?}", sizes);
            (Some(compute_min_client_size(sizes)), session_conns.monitor_command_tx.clone())
        } else {
            (None, None)
        }
    };

    if let Some((min_cols, min_rows)) = min_size {
        eprintln!("[size] Resizing to min: {}x{}", min_cols, min_rows);
        // Try to send resize via monitor's control mode connection (preferred)
        if let Some(tx) = command_tx {
            match tx.send(MonitorCommand::ResizeWindow { cols: min_cols, rows: min_rows }).await {
                Ok(_) => eprintln!("[size] Resize command sent via monitor"),
                Err(e) => {
                    eprintln!("[size] Monitor channel error: {}, falling back to executor", e);
                    let _ = executor::resize_window(session, min_cols, min_rows);
                }
            }
        } else {
            // No monitor channel yet - skip resize (will be handled when monitor connects)
            // Don't use executor fallback as it can cause issues during control mode setup
            eprintln!("[size] No monitor channel yet, skipping resize");
        }
    }
}

/// Resize all windows in the session to the current minimum client size.
/// Called after new-window to ensure newly created windows match the viewport.
async fn resize_all_windows(state: &Arc<AppState>, session: &str) {
    let (min_size, command_tx) = {
        let sessions = state.sessions.read().await;
        sessions
            .get(session)
            .filter(|s| !s.client_sizes.is_empty())
            .map(|s| (compute_min_client_size(&s.client_sizes), s.monitor_command_tx.clone()))
            .unwrap_or(((80, 24), None))
    };

    let (min_cols, min_rows) = min_size;
    // Try to send resize via monitor's control mode connection (preferred)
    if let Some(tx) = command_tx {
        let _ = tx.send(MonitorCommand::ResizeWindow { cols: min_cols, rows: min_rows }).await;
    } else {
        // Fallback to executor
        let _ = executor::resize_window(session, min_cols, min_rows);
    }
}

/// Send a tmux command through control mode.
/// All commands should go through control mode per tmux documentation:
/// https://github.com/tmux/tmux/wiki/Control-Mode
async fn send_via_control_mode(state: &Arc<AppState>, session: &str, command: &str) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        sessions.get(session).and_then(|s| s.monitor_command_tx.clone())
    };

    if let Some(tx) = command_tx {
        tx.send(MonitorCommand::RunCommand { command: command.to_string() })
            .await
            .map_err(|e| format!("Monitor channel error: {}", e))
    } else {
        Err("No monitor connection available".to_string())
    }
}

async fn handle_command(msg: ClientMessage, session: &str, state: &Arc<AppState>, conn_id: u64) -> ServerMessage {
    match msg {
        ClientMessage::Invoke { id, cmd, args } => {
            match cmd.as_str() {
                "send_keys_to_tmux" => {
                    let keys = args.get("keys")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    // All commands via control mode (short form: send)
                    let cmd = format!("send -t {} {}", session, keys);
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "process_key" => {
                    // Process key through root keybindings first, then send-keys
                    // This allows `bind -n` keybindings to work through the web interface
                    let key = args.get("key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    match tmuxy_core::process_key(session, key) {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "get_initial_state" => {
                    // Apply client size before capturing state (prevents initial size flash)
                    let cols = args.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let rows = args.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    if cols > 0 && rows > 0 {
                        set_client_size(state, session, conn_id, cols, rows).await;
                    }

                    match tmuxy_core::capture_window_state_for_session(session) {
                        Ok(state) => ServerMessage::Response {
                            id,
                            result: serde_json::to_value(state).unwrap(),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "set_client_size" => {
                    let cols = args.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let rows = args.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    if cols > 0 && rows > 0 {
                        set_client_size(state, session, conn_id, cols, rows).await;
                    }
                    ServerMessage::Response {
                        id,
                        result: serde_json::json!(null),
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
                    let cmd = format!("splitw -t {} -h", session);
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "split_pane_vertical" => {
                    let cmd = format!("splitw -t {} -v", session);
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "new_window" => {
                    let cmd = format!("neww -t {}", session);
                    match send_via_control_mode(state, session, &cmd).await {
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
                    let dir_flag = match direction {
                        "up" => "-U",
                        "down" => "-D",
                        "left" => "-L",
                        "right" | _ => "-R",
                    };
                    let cmd = format!("selectp -t {} {}", session, dir_flag);
                    match send_via_control_mode(state, session, &cmd).await {
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
                    let cmd = format!("selectw -t {}:{}", session, window);
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "next_window" => {
                    let cmd = format!("next -t {}", session);
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "previous_window" => {
                    let cmd = format!("prev -t {}", session);
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "kill_pane" => {
                    let cmd = format!("killp -t {}", session);
                    match send_via_control_mode(state, session, &cmd).await {
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
                    let cmd = format!("selectp -t {}", pane_id);
                    match send_via_control_mode(state, session, &cmd).await {
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
                    // Enter copy mode first, then scroll
                    let scroll_cmd = if direction == "up" { "scroll-up" } else { "scroll-down" };
                    let cmd = format!("copy-mode -t {} ; send -t {} -X {} -N {}", pane_id, pane_id, scroll_cmd, amount);
                    match send_via_control_mode(state, session, &cmd).await {
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

                    // Map prefix key to tmux command - all routed through control mode
                    // Using short command forms per tmux documentation
                    let cmd = match key {
                        // Window operations
                        "c" => format!("neww -t {}", session),
                        "n" => format!("next -t {}", session),
                        "p" => format!("prev -t {}", session),
                        "l" => format!("last -t {}", session),
                        "&" => format!("killw -t {}", session),
                        // Pane operations
                        "\"" => format!("splitw -t {} -v", session),
                        "%" => format!("splitw -t {} -h", session),
                        "-" => format!("splitw -t {} -v", session),
                        "|" => format!("splitw -t {} -h", session),
                        "z" => format!("resizep -t {} -Z", session),
                        "x" => format!("killp -t {}", session),
                        "o" => format!("selectp -t {} -t :.+", session),
                        ";" => format!("selectp -t {} -l", session),
                        "!" => format!("breakp -t {}", session),
                        // Arrow navigation
                        "Up" | "ArrowUp" => format!("selectp -t {} -U", session),
                        "Down" | "ArrowDown" => format!("selectp -t {} -D", session),
                        "Left" | "ArrowLeft" => format!("selectp -t {} -L", session),
                        "Right" | "ArrowRight" => format!("selectp -t {} -R", session),
                        // Window selection by number
                        "0" => format!("selectw -t {}:0", session),
                        "1" => format!("selectw -t {}:1", session),
                        "2" => format!("selectw -t {}:2", session),
                        "3" => format!("selectw -t {}:3", session),
                        "4" => format!("selectw -t {}:4", session),
                        "5" => format!("selectw -t {}:5", session),
                        "6" => format!("selectw -t {}:6", session),
                        "7" => format!("selectw -t {}:7", session),
                        "8" => format!("selectw -t {}:8", session),
                        "9" => format!("selectw -t {}:9", session),
                        // Copy mode (no short form)
                        "[" => format!("copy-mode -t {}", session),
                        // Layout
                        " " => format!("nextl -t {}", session),
                        _ => {
                            // Unknown key - try sending as-is
                            eprintln!("[ws] Unknown prefix key: {}", key);
                            return ServerMessage::Error { id, error: format!("Unknown prefix key: {}", key) };
                        }
                    };
                    match send_via_control_mode(state, session, &cmd).await {
                        Ok(_) => ServerMessage::Response {
                            id,
                            result: serde_json::json!(null),
                        },
                        Err(e) => ServerMessage::Error { id, error: e },
                    }
                }
                "kill_window" => {
                    let cmd = format!("killw -t {}", session);
                    match send_via_control_mode(state, session, &cmd).await {
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

                    // ALL commands must go through control mode per tmux documentation:
                    // https://github.com/tmux/tmux/wiki/Control-Mode
                    // "tmux commands or command sequences may be sent to the control mode client"
                    let command_tx = {
                        let sessions = state.sessions.read().await;
                        sessions.get(session).and_then(|s| s.monitor_command_tx.clone())
                    };

                    if let Some(tx) = command_tx {
                        match tx.send(MonitorCommand::RunCommand { command: command.to_string() }).await {
                            Ok(_) => {
                                eprintln!("[ws] Sent command via control mode: {}", command);
                                ServerMessage::Response {
                                    id,
                                    result: serde_json::json!(null),
                                }
                            }
                            Err(e) => ServerMessage::Error { id, error: format!("Monitor channel error: {}", e) },
                        }
                    } else {
                        ServerMessage::Error { id, error: "No monitor connection available".to_string() }
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
                    let cmd = format!("resizep -t {} -{} {}", pane_id, direction, adjustment);
                    match send_via_control_mode(state, session, &cmd).await {
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

                    // Route through monitor to ensure it works with control mode attached
                    let command_tx = {
                        let sessions = state.sessions.read().await;
                        sessions.get(session).and_then(|s| s.monitor_command_tx.clone())
                    };

                    if let Some(tx) = command_tx {
                        match tx.send(MonitorCommand::ResizeWindow { cols, rows }).await {
                            Ok(_) => ServerMessage::Response {
                                id,
                                result: serde_json::json!({"success": true}),
                            },
                            Err(e) => ServerMessage::Error { id, error: format!("Monitor channel error: {}", e) },
                        }
                    } else {
                        // Fallback to external command (may not work with control mode)
                        match executor::resize_window(session, cols, rows) {
                            Ok(_) => ServerMessage::Response {
                                id,
                                result: serde_json::json!({"success": true}),
                            },
                            Err(e) => ServerMessage::Error { id, error: e },
                        }
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
                "list_directory" => {
                    let path = args.get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or(".");

                    match list_directory(path) {
                        Ok(entries) => ServerMessage::Response {
                            id,
                            result: serde_json::to_value(entries).unwrap(),
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

/// Directory entry for file picker
#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// List directory contents for file picker
pub fn list_directory(path: &str) -> Result<Vec<DirectoryEntry>, String> {
    let path = std::path::Path::new(path);

    // Resolve to absolute path
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to get cwd: {}", e))?
            .join(path)
    };

    // Canonicalize to resolve symlinks in path components
    let canonical = abs_path.canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;

    let mut entries = Vec::new();

    let dir = std::fs::read_dir(&canonical)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;

        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files by default (can be made configurable)
        if name.starts_with('.') {
            continue;
        }

        let entry_path = entry.path();
        let path_str = entry_path.to_string_lossy().to_string();

        entries.push(DirectoryEntry {
            name,
            path: path_str,
            is_dir: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
        });
    }

    // Sort: directories first, then files, alphabetically
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
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
                    .map(|p| format!("{}:{}:{}", p.id, p.active, tmuxy_core::content_to_hash_string(&p.content)))
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
pub async fn start_monitoring_control_mode(tx: broadcast::Sender<String>, session: String, state: Arc<AppState>) {
    let emitter = WebSocketEmitter::new(tx.clone());

    let config = MonitorConfig {
        session: session.clone(),
        sync_interval: Duration::from_millis(500),
        create_session: true, // Auto-create session if it doesn't exist (e.g., after external kill)
        // Adaptive throttling: emit immediately for low-frequency events (typing),
        // throttle at 16ms (~60fps) when high-frequency output detected (cat large_file)
        throttle_interval: Duration::from_millis(16),
        throttle_threshold: 20,  // >20 events per 100ms triggers throttling
        rate_window: Duration::from_millis(100),
    };

    // Keep trying to connect with exponential backoff
    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);

    loop {
        match TmuxMonitor::connect(config.clone()).await {
            Ok((mut monitor, command_tx)) => {
                // Store the command_tx in AppState for use by set_client_size
                {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        eprintln!("[monitor] Storing command_tx for session '{}'", session);
                        session_conns.monitor_command_tx = Some(command_tx);
                    } else {
                        eprintln!("[monitor] WARNING: Session '{}' not found in AppState, cannot store command_tx", session);
                    }
                }

                backoff = Duration::from_millis(100); // Reset on success
                monitor.run(&emitter).await;

                // Connection closed - clear the command_tx
                {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        session_conns.monitor_command_tx = None;
                    }
                }
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
pub async fn start_monitoring(tx: broadcast::Sender<String>, session: String, state: Arc<AppState>) {
    // Try control mode first (set TMUXY_USE_POLLING=1 to use polling instead)
    let use_control_mode = std::env::var("TMUXY_USE_POLLING")
        .map(|v| v != "1" && v != "true")
        .unwrap_or(true);

    if use_control_mode {
        start_monitoring_control_mode(tx, session, state).await;
    } else {
        start_monitoring_polling(tx).await;
    }
}
