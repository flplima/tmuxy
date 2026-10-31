use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::sync::Arc;
use tmuxy_core::command_router::Route;
use tmuxy_core::transport::{self, to_json};
use tmuxy_core::CommandError;
use tracing::trace;

use super::clients::{new_window_client_size, note_client_activity, set_client_size};
use super::emitter::{broadcast_theme_settings, refresh_keybindings, theme_settings_for};
pub(super) use super::server_commands::wait_for_monitor;
use super::server_commands::{
    handle_connect_server, handle_list_servers, initial_state_for_size, query_via_control_mode,
};
use super::SessionQuery;
use crate::command::ClientCommand;
use crate::state::AppState;

// ============================================
// Command Types
// ============================================

/// A command's answer. A failure is a `CommandError` instead —
/// `{ "error", "kind" }` — sent with a 4xx status.
#[derive(Debug, Serialize)]
pub(super) struct CommandResponse {
    pub(super) result: serde_json::Value,
}

/// A failed command, as `POST /commands` answers it.
pub(super) fn command_failure(status: StatusCode, error: CommandError) -> Response {
    (status, Json(error)).into_response()
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
    let session = match query.session() {
        Ok(session) => session,
        Err(rejection) => return rejection.into_command_failure(),
    };

    // Connection ID from the header. Every SSE client is handed its own id in
    // the `connection-info` greeting, so a missing header means the caller
    // never opened a stream. Keep it as None rather than defaulting to 0 —
    // 0 is a real allocated id, and header-less callers used to overwrite that
    // connection's viewport entry and skew the min-size computation.
    let conn_id: Option<u64> = headers
        .get("x-connection-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // Action tracing (docs/TRACING.md): if the client tagged this command with
    // an action id, record it so the trace can correlate the request leg
    // (client send → server receive) exactly. Content-free — just the id.
    if let Some(action_id) = headers.get("x-action-id").and_then(|v| v.to_str().ok()) {
        tracing::info!(target: "tmuxy_server::sse", action_id = %action_id, "client command");
    }

    // Decode into the typed enum. A malformed payload — a misspelt field, a
    // pane id that is not one — is a 400 of kind `invalid`.
    let cmd: ClientCommand = match ClientCommand::decode(&body) {
        Ok(c) => c,
        Err(e) => {
            return command_failure(
                StatusCode::BAD_REQUEST,
                CommandError::invalid(format!("invalid command payload: {e}")),
            );
        }
    };

    match handle_command(cmd, &session, &state, conn_id).await {
        Ok(result) => (StatusCode::OK, Json(CommandResponse { result })).into_response(),
        Err(error) => command_failure(StatusCode::BAD_REQUEST, error),
    }
}

// ============================================
// Trace Ingest Handler (POST /trace)
// ============================================

/// Max client events accepted per request (a second cap behind the route's
/// body-size limit) — a hostile client can't fill the disk in one call.
const TRACE_MAX_EVENTS: usize = 1000;

/// Ingest client-originated trace events (browser/Tauri tracer) into the shared
/// NDJSON file. **Fails closed**: if tracing is not enabled on this server the
/// body is dropped regardless of what the client believes, so a stale client
/// flag can never reopen the sink. Every event is re-sanitized server-side
/// (`trace::record_client_event`) before it touches the file.
pub async fn trace_handler(body: axum::body::Bytes) -> StatusCode {
    if !tmuxy_core::trace::is_enabled() {
        return StatusCode::NO_CONTENT;
    }
    let events: Vec<serde_json::Map<String, serde_json::Value>> =
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return StatusCode::BAD_REQUEST,
        };
    for obj in events.into_iter().take(TRACE_MAX_EVENTS) {
        tmuxy_core::trace::record_client_event(obj);
    }
    StatusCode::NO_CONTENT
}

// ============================================
// Command Handler
// ============================================

pub(super) async fn handle_command(
    cmd: ClientCommand,
    session: &str,
    state: &Arc<AppState>,
    conn_id: Option<u64>,
) -> Result<serde_json::Value, CommandError> {
    match cmd {
        ClientCommand::GetInitialState { cols, rows } => {
            // Apply client size before capturing state.
            if let (Some(c), Some(r)) = (cols, rows) {
                if c > 0 && r > 0 {
                    set_client_size(state, session, conn_id, c, r).await;
                }
            }
            let snapshot = initial_state_for_size(state, session).await?;
            to_json(snapshot, "state")
        }
        ClientCommand::SetClientSize { cols, rows } => {
            if cols > 0 && rows > 0 {
                set_client_size(state, session, conn_id, cols, rows).await;
            }
            Ok(serde_json::json!(null))
        }
        ClientCommand::RunTmuxCommand { command } => {
            note_client_activity(state, session, conn_id).await;
            // Policy and sequence live in tmuxy-core (`run_client_command`)
            // and are shared with the desktop app; only the channel and the
            // re-broadcast after a `source-file` are ours.
            let tx = state.monitor_tx(session).await?;
            transport::run_client_command(
                &tx,
                &command,
                session,
                new_window_client_size(state, session).await,
                || async {
                    refresh_keybindings(state, session).await;
                    broadcast_theme_settings(state, session).await;
                },
            )
            .await?;
            trace!(
                ?conn_id,
                command = %tmuxy_core::trace::redact_command(&command),
                "client sent command via control mode"
            );
            Ok(serde_json::json!(null))
        }
        ClientCommand::QueryTmux { command } => {
            let routed = match transport::route(
                &command,
                session,
                new_window_client_size(state, session).await,
            ) {
                Route::Blocked(reason) => {
                    return Err(CommandError::forbidden(reason));
                }
                Route::ControlMode(cmd) => cmd,
            };
            let output = query_via_control_mode(state, session, &routed).await?;
            Ok(serde_json::json!(output))
        }
        ClientCommand::GetScrollbackCells {
            pane_id,
            start,
            end,
        } => {
            let tx = state.monitor_tx(session).await?;
            transport::scrollback_cells(&tx, &pane_id, start, end).await
        }
        ClientCommand::ReadPreview { pane_id, path } => {
            let tx = state.monitor_tx(session).await?;
            tmuxy_core::preview::read_preview(&tx, &pane_id, path).await
        }
        ClientCommand::GetThemeSettings => theme_settings_for(state, session).await,
        ClientCommand::SetTheme { name, mode } => {
            let tx = state.monitor_tx(session).await?;
            tmuxy_core::theme::set_theme(&tx, &name, mode.as_deref()).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SetCursorBlink { enabled } => {
            let tx = state.monitor_tx(session).await?;
            tmuxy_core::theme::set_cursor_blink(&tx, enabled).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::SetSendAsk { enabled } => {
            let tx = state.monitor_tx(session).await?;
            tmuxy_core::theme::set_send_ask(&tx, enabled).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::GetThemesList => Ok(tmuxy_core::theme::get_themes_list()),
        ClientCommand::ListGitWorktrees => {
            let tx = state.monitor_tx(session).await?;
            transport::git_worktrees_json(&tx).await
        }
        ClientCommand::SetThemeMode { mode } => {
            let tx = state.monitor_tx(session).await?;
            tmuxy_core::theme::set_theme_mode(&tx, &mode).await?;
            Ok(serde_json::json!(null))
        }
        ClientCommand::ListSnapshots => transport::list_snapshots_json().await,
        // Through THIS session's client: a new session made from inside a
        // control-mode client is how the server already creates one.
        ClientCommand::RestoreSession { session: name } => {
            let tx = state.monitor_tx(session).await?;
            transport::restore_named(&name, &tx).await?;
            Ok(serde_json::json!(null))
        }
        // Debug menu (docs/TRACING.md). The trace file lives on THIS host, so
        // a browser client can read the switch and the path but cannot open the
        // file — the in-app menu hides that item off the desktop.
        ClientCommand::GetTraceSettings => Ok(transport::trace_settings_json()),
        ClientCommand::SetTraceEnabled { enabled } => {
            Ok(serde_json::json!(tmuxy_core::trace::set_enabled(enabled)))
        }
        ClientCommand::SetTraceLevel { level } => {
            Ok(serde_json::json!(transport::set_trace_level(&level)))
        }
        ClientCommand::ListServers => handle_list_servers(state, session).await,
        ClientCommand::ConnectServer {
            id,
            session: session_override,
        } => handle_connect_server(id, session_override).await,
        ClientCommand::DetachClient => Ok(serde_json::json!(null)),
    }
}
