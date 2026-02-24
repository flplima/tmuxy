use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::stream::Stream;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::control_mode::{MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor};
use tmuxy_core::{executor, session, StateUpdate};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::web::{AppState, SessionConnections};

// ============================================
// SSE State Emitter (Adapter Pattern)
// ============================================

/// Emitter that broadcasts state changes to SSE clients
pub struct SseEmitter {
    tx: broadcast::Sender<String>,
}

impl SseEmitter {
    pub fn new(tx: broadcast::Sender<String>) -> Self {
        Self { tx }
    }
}

impl StateEmitter for SseEmitter {
    fn emit_state(&self, update: StateUpdate) {
        let event = SseEvent::StateUpdate(Box::new(update));
        let _ = self.tx.send(serde_json::to_string(&event).unwrap());
    }

    fn emit_error(&self, error: String) {
        let event = SseEvent::Error { message: error };
        let _ = self.tx.send(serde_json::to_string(&event).unwrap());
    }
}

// ============================================
// SSE Event Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyBindings {
    pub prefix_key: String,
    pub prefix_bindings: Vec<tmuxy_core::KeyBinding>,
    pub root_bindings: Vec<tmuxy_core::KeyBinding>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
enum SseEvent {
    #[serde(rename = "connection-info")]
    ConnectionInfo {
        connection_id: u64,
        session_token: String,
        default_shell: String,
    },
    #[serde(rename = "state-update")]
    StateUpdate(Box<StateUpdate>),
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "keybindings")]
    KeyBindings(KeyBindings),
}

// ============================================
// Command Types
// ============================================

#[derive(Debug, Deserialize)]
pub struct CommandRequest {
    cmd: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct CommandResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ============================================
// Query Parameters
// ============================================

#[derive(Debug, Deserialize)]
pub struct SessionQuery {
    session: Option<String>,
}

/// Generate a random session token (32 hex chars)
fn generate_session_token() -> String {
    let bytes: [u8; 16] = rand::thread_rng().gen();
    hex::encode(bytes)
}

// ============================================
// SSE Handler (GET /events)
// ============================================

pub async fn sse_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let session = query
        .session
        .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());

    // Generate unique connection ID and session token
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::SeqCst);
    let session_token = generate_session_token();

    // Ensure the session exists BEFORE starting monitor
    if let Err(e) = session::create_or_attach(&session) {
        eprintln!("Failed to create/attach session '{}': {}", session, e);
    }

    // Register connection and get/create shared session resources
    let session_rx = {
        let mut sessions = state.sessions.write().await;
        let session_conns = sessions
            .entry(session.clone())
            .or_insert_with(SessionConnections::new);

        session_conns.connections.push(conn_id);

        // Subscribe to shared session state channel
        let session_rx = session_conns.state_tx.subscribe();

        // Start monitor if not already running
        if session_conns.monitor_handle.is_none() {
            let monitor_session = session.clone();
            let monitor_state = state.clone();
            let monitor_tx = session_conns.state_tx.clone();

            let handle = tokio::spawn(async move {
                start_monitoring(monitor_tx, monitor_session, monitor_state).await;
            });
            session_conns.monitor_handle = Some(handle);
            eprintln!("[sse] Started monitor for session '{}'", session);
        }

        session_rx
    };

    // Store the session token
    {
        let mut tokens = state.sse_tokens.write().await;
        tokens.insert(session_token.clone(), (conn_id, session.clone()));
    }

    // Create the SSE stream
    //
    // IMPORTANT: When the SSE client disconnects, Axum detects the broken connection
    // on the next keepalive write and DROPS the stream generator. The generator is
    // suspended at `session_rx.recv().await`, so any cleanup code after the loop
    // never executes. We use a oneshot channel: the sender lives inside the generator,
    // and when the generator is dropped, the sender is dropped, signaling the cleanup task.
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();

    // Spawn cleanup task that fires when the stream is dropped (client disconnect)
    {
        let cleanup_state = state.clone();
        let cleanup_session = session.clone();
        let cleanup_token = session_token.clone();
        tokio::spawn(async move {
            // Wait for the stream to be dropped (sender dropped = Err)
            let _ = drop_rx.await;
            eprintln!(
                "[sse] Client {} disconnected from session '{}', running cleanup",
                conn_id, cleanup_session
            );
            cleanup_connection(&cleanup_state, &cleanup_session, conn_id, &cleanup_token).await;
        });
    }

    let stream = async_stream::stream! {
        // Keep the drop sender alive for the lifetime of the stream.
        // When this generator is dropped (client disconnect), _drop_guard is dropped,
        // which drops drop_tx, signaling the cleanup task.
        let _drop_guard = drop_tx;

        // Send connection info as first event
        let default_shell = std::env::var("SHELL")
            .ok()
            .and_then(|s| s.rsplit('/').next().map(String::from))
            .unwrap_or_else(|| "bash".to_string());
        let conn_info = SseEvent::ConnectionInfo {
            connection_id: conn_id,
            session_token: session_token.clone(),
            default_shell,
        };
        yield Ok(Event::default()
            .event("connection-info")
            .data(serde_json::to_string(&conn_info).unwrap()));

        // Send keybindings to each new client (loaded from tmux config)
        let keybindings = KeyBindings {
            prefix_key: tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".into()),
            prefix_bindings: tmuxy_core::get_prefix_bindings().unwrap_or_default(),
            root_bindings: tmuxy_core::get_root_bindings().unwrap_or_default(),
        };
        let kb_event = SseEvent::KeyBindings(keybindings);
        yield Ok(Event::default()
            .event("keybindings")
            .data(serde_json::to_string(&kb_event).unwrap()));

        let mut session_rx = session_rx;

        loop {
            tokio::select! {
                // Handle session-specific state changes
                result = session_rx.recv() => {
                    match result {
                        Ok(msg) => {
                            // Parse the message to extract delta seq for Last-Event-Id
                            if let Ok(event) = serde_json::from_str::<SseEvent>(&msg) {
                                let event_type = match &event {
                                    SseEvent::StateUpdate(_) => "state-update",
                                    SseEvent::Error { .. } => "error",
                                    SseEvent::ConnectionInfo { .. } => "connection-info",
                                    SseEvent::KeyBindings(_) => "keybindings",
                                };

                                // For state updates, use delta seq as event ID
                                if let SseEvent::StateUpdate(ref update) = event {
                                    if let StateUpdate::Delta { delta, .. } = update.as_ref() {
                                        yield Ok(Event::default()
                                            .event(event_type)
                                            .id(delta.seq.to_string())
                                            .data(msg));
                                    } else {
                                        yield Ok(Event::default()
                                            .event(event_type)
                                            .data(msg));
                                    }
                                } else {
                                    yield Ok(Event::default()
                                        .event(event_type)
                                        .data(msg));
                                }
                            } else {
                                // Fallback for unparseable messages
                                yield Ok(Event::default()
                                    .event("state-update")
                                    .data(msg));
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("[sse] Client {} lagged by {} messages", conn_id, n);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default().interval(Duration::from_secs(1)))
}

// ============================================
// Commands Handler (POST /commands)
// ============================================

pub async fn commands_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
    headers: HeaderMap,
    Json(request): Json<CommandRequest>,
) -> Response {
    // Validate session token
    let session_token = match headers.get("x-session-token") {
        Some(value) => value.to_str().unwrap_or(""),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(CommandResponse {
                    result: None,
                    error: Some("Missing X-Session-Token header".to_string()),
                }),
            )
                .into_response();
        }
    };

    // Look up connection ID from token
    let (conn_id, token_session) = {
        let tokens = state.sse_tokens.read().await;
        match tokens.get(session_token) {
            Some((id, sess)) => (*id, sess.clone()),
            None => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(CommandResponse {
                        result: None,
                        error: Some("Invalid session token".to_string()),
                    }),
                )
                    .into_response();
            }
        }
    };

    // Use session from query param or fall back to token's session
    let session = query.session.unwrap_or(token_session);

    // Handle the command
    match handle_command(&request.cmd, request.args, &session, &state, conn_id).await {
        Ok(result) => (
            StatusCode::OK,
            Json(CommandResponse {
                result: Some(result),
                error: None,
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(CommandResponse {
                result: None,
                error: Some(error),
            }),
        )
            .into_response(),
    }
}

// ============================================
// Command Handler (migrated from websocket.rs)
// ============================================

async fn handle_command(
    cmd: &str,
    args: serde_json::Value,
    session: &str,
    state: &Arc<AppState>,
    conn_id: u64,
) -> Result<serde_json::Value, String> {
    match cmd {
        "send_keys_to_tmux" => {
            let keys = args.get("keys").and_then(|v| v.as_str()).unwrap_or("");
            let cmd = format!("send -t {} {}", session, keys);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "process_key" => {
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            tmuxy_core::process_key(session, key)?;
            Ok(serde_json::json!(null))
        }
        "get_initial_state" => {
            // Apply client size before capturing state
            let cols = args.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let rows = args.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if cols > 0 && rows > 0 {
                set_client_size(state, session, conn_id, cols, rows).await;
            }
            let state = tmuxy_core::capture_window_state_for_session(session)?;
            Ok(serde_json::to_value(state).unwrap())
        }
        "set_client_size" => {
            let cols = args.get("cols").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let rows = args.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if cols > 0 && rows > 0 {
                set_client_size(state, session, conn_id, cols, rows).await;
            }
            Ok(serde_json::json!(null))
        }
        "initialize_session" => {
            session::create_or_attach(session)?;
            Ok(serde_json::json!(null))
        }
        "get_scrollback_history" => {
            let history = executor::capture_pane_with_history(session)?;
            Ok(serde_json::json!(history))
        }
        "get_buffer" => {
            let buffer = executor::show_buffer()?;
            Ok(serde_json::json!(buffer))
        }
        "split_pane_horizontal" => {
            let cmd = format!("splitw -t {} -h", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "split_pane_vertical" => {
            let cmd = format!("splitw -t {} -v", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "new_window" => {
            let cmd = format!("neww -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "select_pane" => {
            let direction = args
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("right");
            let dir_flag = match direction {
                "up" => "-U",
                "down" => "-D",
                "left" => "-L",
                _ => "-R",
            };
            let cmd = format!("selectp -t {} {}", session, dir_flag);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "select_window" => {
            let window = args.get("window").and_then(|v| v.as_str()).unwrap_or("1");
            let cmd = format!("selectw -t {}:{}", session, window);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "next_window" => {
            let cmd = format!("next -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "previous_window" => {
            let cmd = format!("prev -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "kill_pane" => {
            let cmd = format!("killp -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "select_pane_by_id" => {
            let pane_id = args.get("paneId").and_then(|v| v.as_str()).unwrap_or("%0");
            let cmd = format!("selectp -t {}", pane_id);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "scroll_pane" => {
            let pane_id = args.get("paneId").and_then(|v| v.as_str()).unwrap_or("%0");
            let direction = args
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("down");
            let amount = args.get("amount").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let scroll_cmd = if direction == "up" {
                "scroll-up"
            } else {
                "scroll-down"
            };
            let cmd = format!(
                "copy-mode -t {} ; send -t {} -X {} -N {}",
                pane_id, pane_id, scroll_cmd, amount
            );
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "send_mouse_event" => {
            let pane_id = args.get("paneId").and_then(|v| v.as_str()).unwrap_or("%0");
            let event_type = args
                .get("eventType")
                .and_then(|v| v.as_str())
                .unwrap_or("press");
            let button = args.get("button").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let x = args.get("x").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let y = args.get("y").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            executor::send_mouse_event(pane_id, event_type, button, x, y)?;
            Ok(serde_json::json!(null))
        }
        "execute_prefix_binding" => {
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");

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
                // Copy mode
                "[" => format!("copy-mode -t {}", session),
                // Layout
                " " => format!("nextl -t {}", session),
                _ => {
                    return Err(format!("Unknown prefix key: {}", key));
                }
            };
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "kill_window" => {
            let cmd = format!("killw -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "run_tmux_command" => {
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");

            // Block raw resize-window commands from clients — resize must go through
            // set_client_size to prevent stale SSE connections from overriding sizes.
            if command.starts_with("resize-window") || command.starts_with("resizew") {
                eprintln!(
                    "[sse] Client {} blocked resize command (use set_client_size): {}",
                    conn_id, command
                );
                return Ok(serde_json::json!(null));
            }

            let command_tx = {
                let sessions = state.sessions.read().await;
                sessions
                    .get(session)
                    .and_then(|s| s.monitor_command_tx.clone())
            };

            if let Some(tx) = command_tx {
                tx.send(MonitorCommand::RunCommand {
                    command: command.to_string(),
                })
                .await
                .map_err(|e| format!("Monitor channel error: {}", e))?;
                eprintln!(
                    "[sse] Client {} sent command via control mode: {}",
                    conn_id, command
                );
                Ok(serde_json::json!(null))
            } else {
                Err("No monitor connection available".to_string())
            }
        }
        "resize_pane" => {
            let pane_id = args.get("paneId").and_then(|v| v.as_str()).unwrap_or("%0");
            let direction = args
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("R");
            let adjustment = args.get("adjustment").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let cmd = format!("resizep -t {} -{} {}", pane_id, direction, adjustment);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        "resize_window" => {
            let cols = args.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u32;
            let rows = args.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u32;

            let command_tx = {
                let sessions = state.sessions.read().await;
                sessions
                    .get(session)
                    .and_then(|s| s.monitor_command_tx.clone())
            };

            if let Some(tx) = command_tx {
                tx.send(MonitorCommand::ResizeWindow { cols, rows })
                    .await
                    .map_err(|e| format!("Monitor channel error: {}", e))?;
                Ok(serde_json::json!({"success": true}))
            } else {
                executor::resize_window(session, cols, rows)?;
                Ok(serde_json::json!({"success": true}))
            }
        }
        "get_key_bindings" => {
            let bindings = tmuxy_core::get_prefix_bindings()?;
            let prefix = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".to_string());
            Ok(serde_json::json!({
                "prefix": prefix,
                "bindings": bindings
            }))
        }
        "get_scrollback_cells" => {
            let pane_id = args.get("paneId").and_then(|v| v.as_str()).unwrap_or("%0");
            let start = args.get("start").and_then(|v| v.as_i64()).unwrap_or(-200);
            let end = args.get("end").and_then(|v| v.as_i64()).unwrap_or(-1);

            // Get pane width from display-message
            let width_output = executor::execute_tmux_command(&[
                "display-message",
                "-t",
                pane_id,
                "-p",
                "#{pane_width}",
            ])
            .map_err(|e| format!("Failed to get pane width: {}", e))?;
            let width: u32 = width_output.trim().parse().unwrap_or(80);

            // Get history size
            let history_output = executor::execute_tmux_command(&[
                "display-message",
                "-t",
                pane_id,
                "-p",
                "#{history_size}",
            ])
            .map_err(|e| format!("Failed to get history size: {}", e))?;
            let history_size: u32 = history_output.trim().parse().unwrap_or(0);

            // Capture the range
            let raw = executor::capture_pane_range(pane_id, start, end)
                .map_err(|e| format!("Failed to capture pane range: {}", e))?;

            // Parse into cells
            let cells = tmuxy_core::parse_scrollback_to_cells(&raw, width);

            Ok(serde_json::json!({
                "cells": cells,
                "historySize": history_size,
                "start": start,
                "end": end,
                "width": width
            }))
        }
        "list_directory" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let entries = list_directory(path)?;
            Ok(serde_json::to_value(entries).unwrap())
        }
        "ping" => {
            // No-op for keepalive
            Ok(serde_json::json!(null))
        }
        _ => Err(format!("Unknown command: {}", cmd)),
    }
}

// ============================================
// Helper Functions (migrated from websocket.rs)
// ============================================

/// Send a tmux command through control mode
async fn send_via_control_mode(
    state: &Arc<AppState>,
    session: &str,
    command: &str,
) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        sessions
            .get(session)
            .and_then(|s| s.monitor_command_tx.clone())
    };

    if let Some(tx) = command_tx {
        tx.send(MonitorCommand::RunCommand {
            command: command.to_string(),
        })
        .await
        .map_err(|e| format!("Monitor channel error: {}", e))
    } else {
        Err("No monitor connection available".to_string())
    }
}

/// Compute the minimum (cols, rows) across all connected clients
fn compute_min_client_size(sizes: &HashMap<u64, (u32, u32)>) -> (u32, u32) {
    let min_cols = sizes.values().map(|(c, _)| *c).min().unwrap_or(80);
    let min_rows = sizes.values().map(|(_, r)| *r).min().unwrap_or(24);
    (min_cols, min_rows)
}

/// Store a client's viewport size and resize the tmux session.
/// Skips the resize command if the computed minimum is the same as the last resize
/// to prevent feedback loops when multiple clients have different viewport sizes.
async fn set_client_size(state: &Arc<AppState>, session: &str, conn_id: u64, cols: u32, rows: u32) {
    eprintln!("[size] Client {} set size: {}x{}", conn_id, cols, rows);
    let (min_size, command_tx) = {
        let mut sessions = state.sessions.write().await;
        if let Some(session_conns) = sessions.get_mut(session) {
            session_conns.client_sizes.insert(conn_id, (cols, rows));
            let sizes = &session_conns.client_sizes;
            let min = compute_min_client_size(sizes);
            // Skip if the minimum size hasn't changed since the last resize
            if session_conns.last_resize == Some(min) {
                return;
            }
            session_conns.last_resize = Some(min);
            eprintln!("[size] All clients: {:?}", sizes);
            (Some(min), session_conns.monitor_command_tx.clone())
        } else {
            (None, None)
        }
    };

    if let Some((min_cols, min_rows)) = min_size {
        eprintln!("[size] Resizing to min: {}x{}", min_cols, min_rows);
        if let Some(tx) = command_tx {
            match tx
                .send(MonitorCommand::ResizeWindow {
                    cols: min_cols,
                    rows: min_rows,
                })
                .await
            {
                Ok(_) => eprintln!("[size] Resize command sent via monitor"),
                Err(e) => {
                    eprintln!(
                        "[size] Monitor channel error: {}, falling back to executor",
                        e
                    );
                    let _ = executor::resize_window(session, min_cols, min_rows);
                }
            }
        } else {
            eprintln!("[size] No monitor channel yet, skipping resize");
        }
    }
}

/// Remove a connection and resize tmux to remaining clients' minimum viewport
async fn cleanup_connection(
    state: &Arc<AppState>,
    session: &str,
    conn_id: u64,
    session_token: &str,
) {
    // Remove session token
    {
        let mut tokens = state.sse_tokens.write().await;
        tokens.remove(session_token);
    }

    let (resize_to, command_tx, monitor_handle) = {
        let mut sessions = state.sessions.write().await;

        let mut resize = None;
        let mut cmd_tx = None;
        let mut handle: Option<JoinHandle<()>> = None;

        if let Some(session_conns) = sessions.get_mut(session) {
            // Remove this connection
            session_conns.connections.retain(|&id| id != conn_id);
            let had_size = session_conns.client_sizes.remove(&conn_id).is_some();

            // Clean up empty sessions
            if session_conns.connections.is_empty() {
                handle = session_conns.monitor_handle.take();
                cmd_tx = session_conns.monitor_command_tx.take();
                eprintln!(
                    "[cleanup] Last client for session '{}' disconnected, stopping monitor",
                    session
                );
                sessions.remove(session);
            } else if had_size && !session_conns.client_sizes.is_empty() {
                // Recompute minimum size for remaining clients
                let new_min = compute_min_client_size(&session_conns.client_sizes);
                // Reset last_resize so the new min will be applied
                session_conns.last_resize = Some(new_min);
                resize = Some(new_min);
                cmd_tx = session_conns.monitor_command_tx.clone();
            }
        }

        (resize, cmd_tx, handle)
    };

    // Stop the monitor if this was the last client
    if let Some(handle) = monitor_handle {
        if let Some(ref tx) = command_tx {
            eprintln!("[cleanup] Sending graceful shutdown to monitor");
            let _ = tx.send(MonitorCommand::Shutdown).await;
            // Wait for the monitor to finish gracefully. The monitor sends
            // detach-client and waits up to 3s for the process to exit.
            // Never abort the handle — that drops the ControlModeConnection
            // which would orphan/kill the child process, crashing tmux 3.5a.
            tokio::time::sleep(Duration::from_millis(4000)).await;
        }
        if !handle.is_finished() {
            eprintln!(
                "[cleanup] Monitor task still running after graceful shutdown (not aborting)"
            );
        } else {
            eprintln!("[cleanup] Monitor task finished gracefully");
        }
        return;
    }

    // Resize tmux session to new minimum viewport
    if let Some((min_cols, min_rows)) = resize_to {
        if let Some(tx) = command_tx {
            let _ = tx
                .send(MonitorCommand::ResizeWindow {
                    cols: min_cols,
                    rows: min_rows,
                })
                .await;
        } else {
            let _ = executor::resize_window(session, min_cols, min_rows);
        }
    }
}

// ============================================
// Directory Listing
// ============================================

#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

pub fn list_directory(path: &str) -> Result<Vec<DirectoryEntry>, String> {
    let path = std::path::Path::new(path);

    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to get cwd: {}", e))?
            .join(path)
    };

    let canonical = abs_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;

    let mut entries = Vec::new();

    let dir =
        std::fs::read_dir(&canonical).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;

        let name = entry.file_name().to_string_lossy().to_string();

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

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

// ============================================
// Monitoring (Control Mode)
// ============================================

pub async fn start_monitoring(
    tx: broadcast::Sender<String>,
    session: String,
    state: Arc<AppState>,
) {
    let use_control_mode = std::env::var("TMUXY_USE_POLLING")
        .map(|v| v != "1" && v != "true")
        .unwrap_or(true);

    if use_control_mode {
        start_monitoring_control_mode(tx, session, state).await;
    } else {
        start_monitoring_polling(tx).await;
    }
}

async fn start_monitoring_control_mode(
    tx: broadcast::Sender<String>,
    session: String,
    state: Arc<AppState>,
) {
    let emitter = SseEmitter::new(tx.clone());

    let config = MonitorConfig {
        session: session.clone(),
        sync_interval: Duration::from_millis(500),
        create_session: true,
        throttle_interval: Duration::from_millis(16),
        throttle_threshold: 20,
        rate_window: Duration::from_millis(100),
    };

    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);

    loop {
        // Stop reconnecting if session was cleaned up (no more clients)
        {
            let sessions = state.sessions.read().await;
            if !sessions.contains_key(&session) {
                eprintln!(
                    "[monitor] Session '{}' removed, stopping monitor loop",
                    session
                );
                break;
            }
        }

        match TmuxMonitor::connect(config.clone()).await {
            Ok((mut monitor, command_tx)) => {
                // Store command_tx so cleanup_connection can send Shutdown
                let stored = {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        eprintln!("[monitor] Storing command_tx for session '{}'", session);
                        session_conns.monitor_command_tx = Some(command_tx);
                        true
                    } else {
                        // Session was cleaned up between connect and now
                        eprintln!(
                            "[monitor] Session '{}' gone before storing command_tx, stopping",
                            session
                        );
                        false
                    }
                };

                if !stored {
                    break;
                }

                backoff = Duration::from_millis(100);
                monitor.run(&emitter).await;

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

        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

async fn start_monitoring_polling(tx: broadcast::Sender<String>) {
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let mut previous_hash = String::new();

    loop {
        interval.tick().await;

        match tmuxy_core::capture_window_state() {
            Ok(state) => {
                let pane_hash: String = state
                    .panes
                    .iter()
                    .map(|p| {
                        format!(
                            "{}:{}:{}",
                            p.id,
                            p.active,
                            tmuxy_core::content_to_hash_string(&p.content)
                        )
                    })
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
                    let event = SseEvent::StateUpdate(Box::new(StateUpdate::Full { state }));
                    let _ = tx.send(serde_json::to_string(&event).unwrap());
                    previous_hash = current_hash;
                }
            }
            Err(e) => {
                let event = SseEvent::Error { message: e };
                let _ = tx.send(serde_json::to_string(&event).unwrap());
            }
        }
    }
}
