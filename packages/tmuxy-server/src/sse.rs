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
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::constants::tmux_options;
use tmuxy_core::control_mode::{
    LogKind, LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor,
};
use tmuxy_core::{executor, StateUpdate};
use tokio::sync::broadcast;
use tracing::{debug, error, info, instrument, trace, warn};

use crate::command::ClientCommand;
use crate::state::{find_workspace_root, AppState, SessionConnections};

// ============================================
// SSE State Emitter (Adapter Pattern)
// ============================================

/// Extract the SSE `event:` discriminator from an already-serialised JSON
/// payload. We peek at the `event` field rather than deserialising into the
/// full `SseEvent` enum because the discriminator is the only thing we need
/// and StateUpdate / Box<...> deserialisation is expensive on the hot path.
/// Falls back to `"state-update"` for unknown shapes to match the legacy
/// fallback behaviour.
fn sse_event_type(payload: &str) -> &'static str {
    // serde_json::from_str is faster than a full enum decode because we stop
    // at the first matching field, but we still avoid building a Value if we
    // can — match the literal `"event":"..."` substring.
    if let Some(idx) = payload.find("\"event\":\"") {
        let rest = &payload[idx + "\"event\":\"".len()..];
        if let Some(end) = rest.find('"') {
            return match &rest[..end] {
                "state-update" => "state-update",
                "error" => "error",
                "connection-info" => "connection-info",
                "keybindings" => "keybindings",
                "log" => "log",
                "fatal" => "fatal",
                "clipboard" => "clipboard",
                _ => "state-update",
            };
        }
    }
    "state-update"
}

/// Serialize an `SseEvent` (or compatible serde value) into a wire-format
/// JSON string, logging — rather than panicking — on failure.
///
/// `serde_json::to_string` only fails on `serde::Serialize` impls that error
/// out, which our event types can't do (every field is a plain type). If a
/// future variant ever does, we'd rather drop one message than crash the
/// monitor task that owns the broadcast channel.
fn encode_event<T: Serialize>(event: &T) -> Option<String> {
    match serde_json::to_string(event) {
        Ok(s) => Some(s),
        Err(e) => {
            error!(error = %e, "failed to serialize SSE event");
            None
        }
    }
}

/// Emitter that broadcasts state changes to SSE clients
pub struct SseEmitter {
    broadcast: Arc<crate::state::SessionBroadcast>,
    app_state: Arc<AppState>,
}

impl SseEmitter {
    pub fn new(broadcast: Arc<crate::state::SessionBroadcast>, app_state: Arc<AppState>) -> Self {
        Self {
            broadcast,
            app_state,
        }
    }

    /// Encode + broadcast in one shot — drops the message on serialize failure
    /// (already logged by `encode_event`).
    fn send_event(&self, event: &SseEvent) {
        if let Some(s) = encode_event(event) {
            self.broadcast.broadcast(s);
        }
    }
}

impl LogSink for SseEmitter {
    fn log(&self, kind: LogKind, message: String) {
        self.send_event(&SseEvent::Log { kind, message });
    }
}

impl StateEmitter for SseEmitter {
    fn emit_state(&self, update: StateUpdate) {
        // Garbage-collect orphaned images when we have a full state snapshot
        if let StateUpdate::Full { ref state } = update {
            let active_pane_ids: std::collections::HashSet<&str> =
                state.panes.iter().map(|p| p.tmux_id.as_str()).collect();
            if let Ok(mut guard) = self.app_state.image_store.try_write() {
                guard.retain(|(pane_id, _), _| active_pane_ids.contains(pane_id.as_str()));
            }
        }
        self.send_event(&SseEvent::StateUpdate(Box::new(update)));
    }

    fn emit_error(&self, error: String) {
        self.send_event(&SseEvent::Error { message: error });
    }

    fn on_initial_sync_complete(&self) {
        // Broadcast keybindings now that config has been sourced and settings enforced.
        let keybindings = KeyBindings {
            prefix_key: tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".into()),
            prefix_bindings: tmuxy_core::get_prefix_bindings().unwrap_or_default(),
            root_bindings: tmuxy_core::get_root_bindings().unwrap_or_default(),
        };
        self.send_event(&SseEvent::KeyBindings(keybindings));
    }

    fn store_images(
        &self,
        pane_id: &str,
        images: Vec<(u32, tmuxy_core::control_mode::StoredImage)>,
    ) {
        let pane_id = pane_id.to_string();
        // Use try_write to avoid blocking the monitor loop; drop images if contended
        if let Ok(mut guard) = self.app_state.image_store.try_write() {
            for (id, img) in images {
                guard.insert((pane_id.clone(), id), img);
            }
        }
    }

    fn write_clipboard(&self, pane_id: &str, text: String) {
        self.send_event(&SseEvent::Clipboard {
            pane_id: pane_id.to_string(),
            text,
        });
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
        default_shell: String,
    },
    #[serde(rename = "state-update")]
    StateUpdate(Box<StateUpdate>),
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "keybindings")]
    KeyBindings(KeyBindings),
    #[serde(rename = "log")]
    Log { kind: LogKind, message: String },
    #[serde(rename = "fatal")]
    Fatal { message: String },
    /// OSC 52 clipboard request from a terminal application.
    /// Frontend mirrors the text into the system clipboard via navigator.clipboard.
    #[serde(rename = "clipboard")]
    Clipboard { pane_id: String, text: String },
}

// ============================================
// Command Types
// ============================================

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

// ============================================
// SSE Handler (GET /events)
// ============================================

pub async fn sse_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
    headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let session = query
        .session
        .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());

    // Browser passes the id of the last event it received via the standard
    // `Last-Event-Id` header on reconnect. If we can find it in the per-session
    // ring buffer, we replay the missing events. If the id is older than the
    // buffer head (or absent), the live stream takes over from the next event.
    let last_event_id: Option<u64> = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // Generate unique connection ID
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::SeqCst);

    // Session creation is handled by TmuxMonitor::connect() with create_session=true.
    // It spawns `tmux -CC new-session -s <name>` which safely creates a new session
    // with its own control mode connection, without routing through an existing monitor
    // (which would trigger %session-changed and contaminate the original session's state).

    // Register connection and get/create shared session resources
    let (session_rx, session_broadcast) = {
        let mut sessions = state.sessions.write().await;
        let session_conns = sessions
            .entry(session.clone())
            .or_insert_with(SessionConnections::new);

        session_conns.connections.push(conn_id);

        // Subscribe to shared session state channel
        let session_rx = session_conns.broadcast.subscribe();
        let session_broadcast = session_conns.broadcast.clone();

        // Start monitor if not already running, or restart if it died
        let needs_monitor = match &session_conns.monitor_handle {
            None => {
                debug!(%session, "no monitor handle yet");
                true
            }
            Some(handle) => {
                let finished = handle.is_finished();
                trace!(%session, finished, "monitor handle status");
                finished
            }
        };
        if needs_monitor {
            if session_conns.monitor_handle.is_some() {
                warn!(%session, "monitor died, restarting");
                session_conns.monitor_handle = None;
                session_conns.monitor_command_tx = None;
            }
            let monitor_session = session.clone();
            let monitor_state = state.clone();
            let monitor_broadcast = session_conns.broadcast.clone();
            // Track in the structured `JoinSet` so `shutdown_signal` drains it
            // on Ctrl+C. We also keep a `JoinHandle` separately on the
            // `SessionConnections` so the deferred-cleanup path can poll
            // `is_finished` / drive graceful shutdown of just one session.
            let handle = tokio::spawn(async move {
                start_monitoring(monitor_broadcast, monitor_session, monitor_state).await;
            });
            session_conns.monitor_handle = Some(handle);
            info!(%session, "started monitor");
        }

        (session_rx, session_broadcast)
    };

    // Create the SSE stream
    //
    // IMPORTANT: When the SSE client disconnects, Axum detects the broken connection
    // on the next keepalive write and DROPS the stream generator. The generator is
    // suspended at `session_rx.recv().await`, so any cleanup code after the loop
    // never executes. We use a oneshot channel: the sender lives inside the generator,
    // and when the generator is dropped, the sender is dropped, signaling the cleanup task.
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();

    // Spawn cleanup task that fires when the stream is dropped (client disconnect).
    // Tracked in `AppState::join_set` so server shutdown drains it instead of
    // leaving it dangling on Ctrl+C.
    {
        let cleanup_state = state.clone();
        let cleanup_session = session.clone();
        let shutdown = state.shutdown.clone();
        state
            .spawn(async move {
                tokio::select! {
                    _ = drop_rx => {
                        info!(conn_id, session = %cleanup_session, "client disconnected, running cleanup");
                        cleanup_connection(&cleanup_state, &cleanup_session, conn_id).await;
                    }
                    _ = shutdown.cancelled() => {
                        // Server shutting down — skip the cleanup chore; the
                        // monitor's own shutdown path will tear down the session.
                    }
                }
            })
            .await;
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
            default_shell,
        };
        if let Some(s) = encode_event(&conn_info) {
            yield Ok(Event::default().event("connection-info").data(s));
        }

        // Send keybindings to each new SSE client. For reconnecting clients
        // (monitor already running, config already sourced), this is the only
        // chance to receive them. The monitor also broadcasts updated keybindings
        // via on_initial_sync_complete() after sourcing config for the first time.
        let keybindings = KeyBindings {
            prefix_key: tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".into()),
            prefix_bindings: tmuxy_core::get_prefix_bindings().unwrap_or_default(),
            root_bindings: tmuxy_core::get_root_bindings().unwrap_or_default(),
        };
        let kb_event = SseEvent::KeyBindings(keybindings);
        if let Some(s) = encode_event(&kb_event) {
            yield Ok(Event::default().event("keybindings").data(s));
        }

        let mut session_rx = session_rx;

        // Last-Event-Id replay: if the client reconnected with a known seq,
        // dump everything in the ring buffer above that seq before entering the
        // live loop. If the requested seq is older than the buffer head (or no
        // header at all), we can't fill the gap from cache alone — the live
        // stream will just resume from the next event, and the client falls
        // back to its full state on the next StateUpdate::Full broadcast.
        let mut last_replayed: u64 = last_event_id.unwrap_or(0);
        let oldest = session_broadcast.oldest_seq();
        let buffer_can_serve = match (last_event_id, oldest) {
            (Some(le), Some(old)) => le >= old.saturating_sub(1),
            _ => false,
        };
        if buffer_can_serve {
            let replay = session_broadcast.replay_since(last_event_id.unwrap_or(0));
            for (seq, msg) in replay {
                let event_type = sse_event_type(&msg);
                last_replayed = seq;
                yield Ok(Event::default()
                    .event(event_type)
                    .id(seq.to_string())
                    .data(msg));
            }
        }

        loop {
            tokio::select! {
                // Handle session-specific state changes
                result = session_rx.recv() => {
                    match result {
                        Ok((seq, msg)) => {
                            // Dedupe against the replay window — broadcast subscription
                            // happens before we read the ring buffer, so the receiver
                            // may queue messages already yielded above.
                            if seq <= last_replayed {
                                continue;
                            }
                            last_replayed = seq;
                            let event_type = sse_event_type(&msg);
                            yield Ok(Event::default()
                                .event(event_type)
                                .id(seq.to_string())
                                .data(msg));
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!(conn_id, lagged = n, "client lagged behind broadcast");
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
    body: axum::body::Bytes,
) -> Response {
    // Get session from query param (required)
    let session = query
        .session
        .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());

    // Get connection ID from header (used by set_client_size; default to 0)
    let conn_id: u64 = headers
        .get("x-connection-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Decode into the typed enum. A parse failure still returns 400 with the
    // serde error in the body — the existing wire contract (`{ "error": ... }`)
    // is preserved so the TS adapter keeps working.
    let cmd: ClientCommand = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(CommandResponse {
                    result: None,
                    error: Some(format!("invalid command payload: {}", e)),
                }),
            )
                .into_response();
        }
    };

    // Handle the command
    match handle_command(cmd, &session, &state, conn_id).await {
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
// Command Handler
// ============================================

async fn handle_command(
    cmd: ClientCommand,
    session: &str,
    state: &Arc<AppState>,
    conn_id: u64,
) -> Result<serde_json::Value, String> {
    match cmd {
        ClientCommand::SendKeysToTmux { keys } => {
            let cmd = format!("send -t {} {}", session, keys);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::ProcessKey { key } => {
            tmuxy_core::process_key(session, &key)?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::GetInitialState { cols, rows } => {
            // Apply client size before capturing state
            if let (Some(c), Some(r)) = (cols, rows) {
                if c > 0 && r > 0 {
                    set_client_size(state, session, conn_id, c, r).await;
                }
            }
            let snapshot = tmuxy_core::capture_window_state_for_session(session)?;
            serde_json::to_value(snapshot).map_err(|e| format!("Failed to serialize state: {}", e))
        }
        ClientCommand::SetClientSize { cols, rows } => {
            if cols > 0 && rows > 0 {
                set_client_size(state, session, conn_id, cols, rows).await;
            }
            Ok(serde_json::json!(null))
        }
        ClientCommand::InitializeSession => {
            // Session is already created by TmuxMonitor::connect() when the SSE handler starts.
            // No-op: avoid calling session::create_or_attach() which spawns external tmux commands
            // that crash tmux 3.5a when control mode is attached.
            Ok(serde_json::json!(null))
        }
        ClientCommand::GetScrollbackHistory => {
            let history = executor::capture_pane_with_history(session)?;
            Ok(serde_json::json!(history))
        }
        ClientCommand::GetBuffer => {
            let buffer = executor::show_buffer()?;
            Ok(serde_json::json!(buffer))
        }
        ClientCommand::SplitPaneHorizontal => {
            let cmd = format!("splitw -t {} -h", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SplitPaneVertical => {
            let cmd = format!("splitw -t {} -v", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::NewWindow => {
            let cmd = build_new_window_command(state, session).await;
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SelectPane { direction } => {
            let cmd = format!("selectp -t {} {}", session, direction.flag());
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SelectWindow { window } => {
            let cmd = format!("selectw -t {}:{}", session, window);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::NextWindow => {
            let cmd = format!("next -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::PreviousWindow => {
            let cmd = format!("prev -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::KillPane => {
            let cmd = format!("killp -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SelectPaneById { pane_id } => {
            let cmd = format!("selectp -t {}", pane_id);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::ScrollPane {
            pane_id,
            direction,
            amount,
        } => {
            let cmd = format!(
                "copy-mode -t {} ; send -t {} -X {} -N {}",
                pane_id,
                pane_id,
                direction.tmux_cmd(),
                amount
            );
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SendMouseEvent {
            pane_id,
            event_type,
            button,
            x,
            y,
        } => {
            executor::send_mouse_event(&pane_id, &event_type, button, x, y)?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::ExecutePrefixBinding { key } => {
            // neww crashes tmux 3.5a control mode — use split+break workaround
            if key == "c" {
                let cmd = build_new_window_command(state, session).await;
                send_via_control_mode(state, session, &cmd).await?;
                return Ok(serde_json::json!(null));
            }

            let cmd = match key.as_str() {
                // Window operations
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
                "o" => format!("selectp -t {}:.+", session),
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
        ClientCommand::KillWindow => {
            let cmd = format!("killw -t {}", session);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::RefreshKeybindings => {
            // Re-fetch keybindings from tmux and broadcast to all clients.
            // Called after source-file or other config changes.
            broadcast_keybindings(state, session).await;
            Ok(serde_json::json!(null))
        }
        ClientCommand::RunTmuxCommand { command } => {
            // Block raw resize-window commands from clients — resize must go through
            // set_client_size to prevent stale SSE connections from overriding sizes.
            if command.starts_with("resize-window") || command.starts_with("resizew") {
                warn!(conn_id, %command, "blocked resize command (use set_client_size)");
                return Ok(serde_json::json!(null));
            }

            // neww crashes tmux 3.5a control mode — use split+break workaround
            if command.starts_with("new-window") || command.starts_with("neww") {
                let cmd = build_new_window_command(state, session).await;
                send_via_control_mode(state, session, &cmd).await?;
                return Ok(serde_json::json!(null));
            }

            // Detect source-file commands — keybindings may change
            let is_source_file =
                command.starts_with("source-file") || command.starts_with("source ");

            let command_tx = {
                let sessions = state.sessions.read().await;
                sessions
                    .get(session)
                    .and_then(|s| s.monitor_command_tx.clone())
            };

            if let Some(tx) = command_tx {
                tx.send(MonitorCommand::RunCommand {
                    command: command.clone(),
                })
                .await
                .map_err(|e| format!("Monitor channel error: {}", e))?;
                trace!(conn_id, %command, "client sent command via control mode");

                // After source-file, re-broadcast keybindings (prefix key may have changed)
                if is_source_file {
                    // Brief delay to let tmux process the source-file
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    broadcast_keybindings(state, session).await;
                }

                Ok(serde_json::json!(null))
            } else {
                Err("No monitor connection available".to_string())
            }
        }
        ClientCommand::ResizePane {
            pane_id,
            direction,
            adjustment,
        } => {
            let cmd = format!("resizep -t {} {} {}", pane_id, direction.flag(), adjustment);
            send_via_control_mode(state, session, &cmd).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::ResizeWindow { cols, rows } => {
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
        ClientCommand::GetKeyBindings => {
            let bindings = tmuxy_core::get_prefix_bindings()?;
            let prefix = tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".to_string());
            Ok(serde_json::json!({
                "prefix": prefix,
                "bindings": bindings
            }))
        }
        ClientCommand::GetScrollbackCells {
            pane_id,
            start,
            end,
        } => {
            // Route the three queries that build one scrollback response through
            // the Tower stack — picks up the standard retry policy, a 5s
            // per-call deadline, and tracing in one place. Capture-pane in
            // particular sometimes races a pending layout change and returns
            // transient io::Error; the retry layer absorbs those.
            let policy = tmuxy_core::RetryPolicy::standard();
            let width_output = state
                .tmux_call_with_policy(
                    vec![
                        "display-message".into(),
                        "-t".into(),
                        pane_id.clone(),
                        "-p".into(),
                        "#{pane_width}".into(),
                    ],
                    "scrollback:pane_width",
                    policy,
                )
                .await
                .map_err(|e| format!("Failed to get pane width: {}", e))?;
            let width: u32 = width_output.trim().parse().unwrap_or(80);

            let history_output = state
                .tmux_call_with_policy(
                    vec![
                        "display-message".into(),
                        "-t".into(),
                        pane_id.clone(),
                        "-p".into(),
                        "#{history_size}".into(),
                    ],
                    "scrollback:history_size",
                    policy,
                )
                .await
                .map_err(|e| format!("Failed to get history size: {}", e))?;
            let history_size: u32 = history_output.trim().parse().unwrap_or(0);

            // capture-pane wants the special `-S start -E end` form built
            // inline so dispatch directly through the stack rather than the
            // sync `capture_pane_range` helper.
            let start_s = start.to_string();
            let end_s = end.to_string();
            let raw = state
                .tmux_call_with_policy(
                    vec![
                        "capture-pane".into(),
                        "-t".into(),
                        pane_id.clone(),
                        "-p".into(),
                        "-e".into(),
                        "-S".into(),
                        start_s,
                        "-E".into(),
                        end_s,
                    ],
                    "scrollback:capture",
                    policy,
                )
                .await
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
        ClientCommand::ListDirectory { path } => {
            let entries = list_directory(&path)?;
            serde_json::to_value(entries)
                .map_err(|e| format!("Failed to serialize directory entries: {}", e))
        }
        ClientCommand::GetThemeSettings => {
            let theme = state
                .tmux_call(
                    vec![
                        "show-options".into(),
                        "-gqv".into(),
                        tmux_options::THEME.into(),
                    ],
                    "theme:get",
                )
                .await
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let mode = state
                .tmux_call(
                    vec![
                        "show-options".into(),
                        "-gqv".into(),
                        tmux_options::THEME_MODE.into(),
                    ],
                    "theme-mode:get",
                )
                .await
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            Ok(serde_json::json!({
                "theme": if theme.is_empty() { "default".to_string() } else { theme },
                "mode": if mode.is_empty() { "dark".to_string() } else { mode },
            }))
        }
        ClientCommand::SetTheme { name, mode } => {
            state
                .tmux_call(
                    vec![
                        "set-option".into(),
                        "-g".into(),
                        tmux_options::THEME.into(),
                        name.clone(),
                    ],
                    "theme:set",
                )
                .await
                .map_err(|e| format!("Failed to set theme: {}", e))?;
            if let Some(ref m) = mode {
                state
                    .tmux_call(
                        vec![
                            "set-option".into(),
                            "-g".into(),
                            tmux_options::THEME_MODE.into(),
                            m.clone(),
                        ],
                        "theme-mode:set",
                    )
                    .await
                    .map_err(|e| format!("Failed to set theme mode: {}", e))?;
            }
            // Persist so the choice survives a tmux server restart.
            if let Err(e) = tmuxy_core::session::write_managed_state(Some(&name), mode.as_deref()) {
                warn!(error = %e, "could not persist theme to tmuxy.state.conf");
            }
            Ok(serde_json::json!(null))
        }
        ClientCommand::GetThemesList => {
            // Read available theme CSS files from the themes directory
            let workspace_root = find_workspace_root();
            let themes_dir = workspace_root.join("packages/tmuxy-ui/public/themes");
            let mut names: Vec<String> = std::fs::read_dir(&themes_dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    name.strip_suffix(".css").map(|n| n.to_string())
                })
                .collect();
            names.sort();

            let themes: Vec<serde_json::Value> = names
                .into_iter()
                .map(|name| {
                    let display_name = name
                        .split('-')
                        .map(|word| {
                            let mut chars = word.chars();
                            match chars.next() {
                                None => String::new(),
                                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    serde_json::json!({ "name": name, "displayName": display_name })
                })
                .collect();

            Ok(serde_json::json!(themes))
        }
        ClientCommand::SetThemeMode { mode } => {
            state
                .tmux_call(
                    vec![
                        "set-option".into(),
                        "-g".into(),
                        tmux_options::THEME_MODE.into(),
                        mode.clone(),
                    ],
                    "theme-mode:set",
                )
                .await
                .map_err(|e| format!("Failed to set theme mode: {}", e))?;
            if let Err(e) = tmuxy_core::session::write_managed_state(None, Some(&mode)) {
                warn!(error = %e, "could not persist theme mode to tmuxy.state.conf");
            }
            Ok(serde_json::json!(null))
        }
        ClientCommand::Ping => {
            // No-op for keepalive
            Ok(serde_json::json!(null))
        }
    }
}

// ============================================
// Helper Functions
// ============================================

/// Re-fetch keybindings from tmux and broadcast to all SSE clients for a session.
async fn broadcast_keybindings(state: &Arc<AppState>, session: &str) {
    let keybindings = KeyBindings {
        prefix_key: tmuxy_core::get_prefix_key().unwrap_or_else(|_| "C-b".into()),
        prefix_bindings: tmuxy_core::get_prefix_bindings().unwrap_or_default(),
        root_bindings: tmuxy_core::get_root_bindings().unwrap_or_default(),
    };
    let kb_event = SseEvent::KeyBindings(keybindings);
    let Some(msg) = encode_event(&kb_event) else {
        return;
    };
    let sessions = state.sessions.read().await;
    if let Some(session_conn) = sessions.get(session) {
        session_conn.broadcast.broadcast(msg);
        debug!(%session, "broadcast refreshed keybindings");
    }
}

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

/// Build the `new-window` rewrite (splitw + breakp + resizew + window-tag).
/// `resizew` targets the current window, which is the new one after `breakp`,
/// so the new window matches the viewport at creation rather than inheriting
/// the half-width post-split size or the 200x50 control-mode PTY default.
async fn build_new_window_command(state: &Arc<AppState>, session: &str) -> String {
    let resize = {
        let sessions = state.sessions.read().await;
        sessions.get(session).and_then(|s| {
            if s.client_sizes.is_empty() {
                None
            } else {
                Some(compute_min_client_size(&s.client_sizes))
            }
        })
    };
    if let Some((cols, rows)) = resize {
        format!(
            "splitw -t {} ; breakp ; resizew -x {} -y {} ; set-option -w @tmuxy-window-type tab",
            session, cols, rows
        )
    } else {
        format!(
            "splitw -t {} ; breakp ; set-option -w @tmuxy-window-type tab",
            session
        )
    }
}

/// Store a client's viewport size and resize the tmux session.
/// Skips the resize command if the computed minimum is the same as the last resize
/// to prevent feedback loops when multiple clients have different viewport sizes.
#[instrument(skip(state), fields(%session))]
async fn set_client_size(state: &Arc<AppState>, session: &str, conn_id: u64, cols: u32, rows: u32) {
    trace!(conn_id, cols, rows, "client set size");
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
            trace!(?sizes, "all client sizes");
            (Some(min), session_conns.monitor_command_tx.clone())
        } else {
            (None, None)
        }
    };

    if let Some((min_cols, min_rows)) = min_size {
        debug!(min_cols, min_rows, "resizing to min");
        if let Some(tx) = command_tx {
            match tx
                .send(MonitorCommand::ResizeWindow {
                    cols: min_cols,
                    rows: min_rows,
                })
                .await
            {
                Ok(_) => trace!("resize command sent via monitor"),
                Err(e) => {
                    warn!(error = %e, "monitor channel error, falling back to executor");
                    let _ = executor::resize_window(session, min_cols, min_rows);
                }
            }
        } else {
            debug!("no monitor channel yet, skipping resize");
        }
    }
}

/// Remove a connection and resize tmux to remaining clients' minimum viewport
async fn cleanup_connection(state: &Arc<AppState>, session: &str, conn_id: u64) {
    let (resize_to, command_tx, needs_deferred_cleanup) = {
        let mut sessions = state.sessions.write().await;

        let mut resize = None;
        let mut cmd_tx = None;
        let mut deferred = false;

        if let Some(session_conns) = sessions.get_mut(session) {
            // Remove this connection
            session_conns.connections.retain(|&id| id != conn_id);
            let had_size = session_conns.client_sizes.remove(&conn_id).is_some();

            if session_conns.connections.is_empty() {
                // Don't immediately kill the monitor — a page reload will reconnect
                // within a few seconds. Defer cleanup to give new clients a chance.
                info!(%session, "last client disconnected, deferring monitor cleanup (2s grace period)");
                deferred = true;
            } else if had_size && !session_conns.client_sizes.is_empty() {
                // Recompute minimum size for remaining clients
                let new_min = compute_min_client_size(&session_conns.client_sizes);
                // Reset last_resize so the new min will be applied
                session_conns.last_resize = Some(new_min);
                resize = Some(new_min);
                cmd_tx = session_conns.monitor_command_tx.clone();
            }
        }

        (resize, cmd_tx, deferred)
    };

    // Defer monitor cleanup: wait 2 seconds, then check if clients reconnected.
    // Tracked in `AppState::join_set` so the grace-period sleep doesn't survive
    // server shutdown. The grace period itself is a UX feature (page reload
    // reconnects within ~1s) — kept for that reason, not as orphan-prevention.
    if needs_deferred_cleanup {
        let state_owned = state.clone();
        let session = session.to_string();
        let shutdown = state.shutdown.clone();
        state
            .spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    _ = shutdown.cancelled() => {
                        debug!(%session, "shutdown signalled during grace period, aborting cleanup");
                        return;
                    }
                }
                let state = state_owned;

            let (cmd_tx, monitor_handle) = {
                let mut sessions = state.sessions.write().await;
                if let Some(session_conns) = sessions.get_mut(&session) {
                    if session_conns.connections.is_empty() {
                        // Still no clients after grace period — clean up for real
                        info!(%session, "no clients reconnected after grace period, stopping monitor");
                        let handle = session_conns.monitor_handle.take();
                        let tx = session_conns.monitor_command_tx.take();
                        sessions.remove(&session);
                        (tx, handle)
                    } else {
                        debug!(%session, "client reconnected during grace period, keeping monitor alive");
                        (None, None)
                    }
                } else {
                    (None, None)
                }
            };

            // Stop the monitor if cleanup proceeded
            if let Some(handle) = monitor_handle {
                if handle.is_finished() {
                    debug!("monitor task already finished (session was killed)");
                } else if let Some(ref tx) = cmd_tx {
                    info!("sending graceful shutdown to monitor");
                    let _ = tx.send(MonitorCommand::Shutdown).await;
                    // Poll for completion instead of fixed sleep
                    for _ in 0..20 {
                        if handle.is_finished() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    if !handle.is_finished() {
                        warn!("monitor task still running after graceful shutdown (not aborting)");
                    } else {
                        debug!("monitor task finished gracefully");
                    }
                }
            }
            })
            .await;
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
    broadcast: Arc<crate::state::SessionBroadcast>,
    session: String,
    state: Arc<AppState>,
) {
    let use_control_mode = std::env::var("TMUXY_USE_POLLING")
        .map(|v| v != "1" && v != "true")
        .unwrap_or(true);

    if use_control_mode {
        start_monitoring_control_mode(broadcast, session, state).await;
    } else {
        start_monitoring_polling(broadcast).await;
    }
}

async fn start_monitoring_control_mode(
    broadcast: Arc<crate::state::SessionBroadcast>,
    session: String,
    state: Arc<AppState>,
) {
    let emitter = Arc::new(SseEmitter::new(broadcast.clone(), Arc::clone(&state)));
    let log_sink: Arc<dyn LogSink> = emitter.clone();

    let config = MonitorConfig {
        session: session.clone(),
        sync_interval: Duration::from_millis(500),
        create_session: true,
        throttle_interval: Duration::from_millis(32),
        throttle_threshold: 20,
        rate_window: Duration::from_millis(100),
        working_dir: Some(crate::state::find_workspace_root()),
    };

    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    let mut is_first_connect = true;
    // Track whether monitor.run() ever processed events successfully.
    // If the connection dies before processing any events, we should retry
    // with create_session=true since the session may need to be recreated.
    let mut ever_ran_successfully = false;
    // Bound consecutive connect failures so we don't hammer a broken tmux
    // forever. Reset on successful long-running monitor.run().
    let mut consecutive_failures: u32 = 0;
    let shutdown = state.shutdown.clone();

    loop {
        // Server shutdown signalled — exit promptly instead of reconnecting.
        if shutdown.is_cancelled() {
            info!(%session, "shutdown signalled, stopping monitor loop");
            let mut sessions = state.sessions.write().await;
            sessions.remove(&session);
            break;
        }

        // Stop reconnecting if session was cleaned up (no more clients)
        let has_clients = {
            let sessions = state.sessions.read().await;
            if let Some(session_conns) = sessions.get(&session) {
                !session_conns.connections.is_empty()
            } else {
                false
            }
        };
        if !has_clients {
            info!(%session, "no clients, stopping monitor loop");
            // Clean up the session entry so a fresh monitor can start next time
            let mut sessions = state.sessions.write().await;
            sessions.remove(&session);
            break;
        }

        // On reconnect (not first connect), check if the tmux session still exists.
        // If it was intentionally destroyed (by test cleanup or user) AND we had
        // a successful run before, stop the monitor loop. If the session died
        // before ever running successfully (crash on startup), retry with
        // create_session=true to recreate it.
        let mut connect_config = config.clone();
        if !is_first_connect {
            let session_exists = tmuxy_core::session::tmux_command()
                .args(["has-session", "-t", &session])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if !session_exists {
                if ever_ran_successfully {
                    // Session was intentionally destroyed (e.g., kill-session from test cleanup)
                    info!(%session, "tmux session no longer exists (was running), stopping monitor loop");
                    break;
                }
                // Session died before ever running — recreate it
                warn!(%session, "tmux session died before running, will recreate");
                connect_config.create_session = true;
            } else {
                // Session exists, just attach
                connect_config.create_session = false;
            }
        }

        // If this session doesn't exist and needs creation, try to route the
        // `new-session -d` through an existing monitor's CC connection. Running
        // external `tmux new-session -d` while a CC client is attached crashes
        // tmux 3.5a. Routing through CC avoids this.
        if connect_config.create_session {
            let session_exists = tmuxy_core::session::tmux_command()
                .args(["has-session", "-t", &session])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if !session_exists {
                // Find an existing running monitor to route through
                let existing_tx = {
                    let sessions = state.sessions.read().await;
                    sessions.iter().find_map(|(name, conns)| {
                        if name == &session {
                            return None;
                        }
                        conns
                            .monitor_command_tx
                            .clone()
                            .map(|tx| (name.clone(), tx))
                    })
                };

                if let Some((via_session, tx)) = existing_tx {
                    let working_dir = connect_config
                        .working_dir
                        .as_ref()
                        .map(|d| format!(" -c '{}'", d.display()))
                        .unwrap_or_default();
                    let create_cmd = format!(
                        "new-session -d -s {} -x {} -y {}{}",
                        session,
                        tmuxy_core::control_mode::INITIAL_PTY_COLS,
                        tmuxy_core::control_mode::INITIAL_PTY_ROWS,
                        working_dir
                    );
                    info!(%session, %via_session, "creating session via existing CC client");
                    let _ = tx
                        .send(tmuxy_core::control_mode::MonitorCommand::RunCommand {
                            command: create_cmd,
                        })
                        .await;
                    // Wait for the session to actually exist before attaching CC.
                    // The RunCommand is async — it goes through the monitor's event
                    // loop and then tmux processes it. Poll has-session to confirm.
                    let mut created = false;
                    for _ in 0..50 {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        let exists = tmuxy_core::session::tmux_command()
                            .args(["has-session", "-t", &session])
                            .output()
                            .map(|o| o.status.success())
                            .unwrap_or(false);
                        if exists {
                            created = true;
                            info!(%session, "session created successfully via CC");
                            break;
                        }
                    }
                    if created {
                        // Session exists, just attach (no creation needed)
                        connect_config.create_session = false;
                    } else {
                        warn!(%session, "session creation via CC timed out, falling back to direct creation");
                        // Fall through with create_session still true
                    }
                }
            }
        }

        match TmuxMonitor::connect(connect_config, Some(&log_sink), state.ctx.clone()).await {
            Ok((mut monitor, command_tx)) => {
                // Store command_tx so cleanup_connection can send Shutdown
                let stored = {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        debug!(%session, "storing command_tx");
                        session_conns.monitor_command_tx = Some(command_tx);
                        true
                    } else {
                        // Session was cleaned up between connect and now
                        warn!(%session, "session gone before storing command_tx, stopping");
                        false
                    }
                };

                if !stored {
                    break;
                }

                backoff = Duration::from_millis(100);
                let run_start = std::time::Instant::now();
                monitor.run(emitter.as_ref()).await;
                // If the monitor ran for more than 2 seconds, consider it a successful run.
                // Short-lived runs indicate startup crashes that should retry with create_session.
                if run_start.elapsed() > Duration::from_secs(2) {
                    ever_ran_successfully = true;
                    consecutive_failures = 0;
                }

                {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        session_conns.monitor_command_tx = None;
                    }
                }
            }
            Err(e) => {
                // Variant-aware recovery:
                // - `SessionNotFound` after the session was already destroyed (e.g. external
                //   `tmux kill-session`) means the user intentionally tore it down. Surface
                //   and exit instead of looping forever trying to attach.
                // - Everything else (`Timeout`, `ProcessExited`, `Io`, generic `ControlMode`)
                //   is retried with exponential backoff up to `MAX_CONSECUTIVE_FAILURES`.
                if matches!(e, tmuxy_core::TmuxError::SessionNotFound { .. })
                    && ever_ran_successfully
                {
                    info!(%session, error = %e, "session destroyed externally, stopping monitor loop");
                    let mut sessions = state.sessions.write().await;
                    sessions.remove(&session);
                    return;
                }

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
                    let event = SseEvent::Fatal {
                        message: final_msg.clone(),
                    };
                    if let Some(s) = encode_event(&event) {
                        broadcast.broadcast(s);
                    }
                    error!(%session, msg = %final_msg, "monitor FATAL");
                    let mut sessions = state.sessions.write().await;
                    sessions.remove(&session);
                    return;
                }
            }
        }

        is_first_connect = false;
        // Cancellable backoff — Ctrl+C during retry shouldn't have to wait out
        // the full sleep before the next loop iteration sees the cancellation.
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.cancelled() => {}
        }
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

async fn start_monitoring_polling(broadcast: Arc<crate::state::SessionBroadcast>) {
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
                    if let Some(s) = encode_event(&event) {
                        broadcast.broadcast(s);
                    }
                    previous_hash = current_hash;
                }
            }
            Err(e) => {
                let event = SseEvent::Error {
                    message: e.to_string(),
                };
                if let Some(s) = encode_event(&event) {
                    broadcast.broadcast(s);
                }
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Round-trip the Clipboard variant so SSE consumers can rely on the
    /// `event=clipboard` discriminator + `{ pane_id, text }` payload shape.
    #[test]
    fn clipboard_event_serializes_with_expected_shape() {
        let evt = SseEvent::Clipboard {
            pane_id: "%4".to_string(),
            text: "hello world".to_string(),
        };
        let json = serde_json::to_string(&evt).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["event"], "clipboard");
        assert_eq!(parsed["data"]["pane_id"], "%4");
        assert_eq!(parsed["data"]["text"], "hello world");
    }
}
