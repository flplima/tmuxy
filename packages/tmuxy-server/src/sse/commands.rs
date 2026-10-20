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
use tracing::{trace, warn};

use super::clients::{new_window_client_size, set_client_size};
use super::emitter::{broadcast_theme_settings, refresh_keybindings, theme_settings_for};
pub(super) use super::server_commands::wait_for_monitor;
use super::server_commands::{
    handle_connect_server, handle_list_servers, initial_state_for_size, query_via_control_mode,
    send_via_control_mode, viewer_scrollback,
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
    let session = match query.session(&state) {
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

    // A viewer's server has its own, total dispatch: `serve_viewer` names
    // every command a viewer is served and refuses the rest, so the writable
    // implementation below is never reached on this server at all.
    let outcome = if state.read_only {
        match serve_viewer(cmd, &session, &state).await {
            Some(result) => result,
            None => {
                return command_failure(
                    StatusCode::FORBIDDEN,
                    CommandError::forbidden("read-only server"),
                );
            }
        }
    } else {
        handle_command(cmd, &session, &state, conn_id).await
    };

    match outcome {
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

/// Everything a viewer's server serves, and nothing else.
///
/// SEC-11. The role used to be ten `state.read_only` branches scattered
/// through a router, a dispatch and a monitor loop, with a separate allowlist
/// deciding what was refused — so a command added to that allowlist fell
/// straight into the writable implementation, and a command added to neither
/// was decided by whichever branch happened to notice.
///
/// This match is the whole answer instead. `None` is a refusal (403), and it
/// is what an unlisted command gets, so a variant added later is viewer-safe
/// by default and is served only when someone writes down how.
///
/// Note what is NOT here: no viewport is recorded, because recording one
/// would resize the session under whoever is writing; nothing runs a tmux
/// subprocess or a `git`, because a viewer's request must cost the watched
/// host nothing.
pub(super) async fn serve_viewer(
    cmd: ClientCommand,
    session: &str,
    state: &Arc<AppState>,
) -> Option<Result<serde_json::Value, CommandError>> {
    Some(match cmd {
        // The viewport that arrives with it is ignored, deliberately.
        ClientCommand::GetInitialState { .. } => match initial_state_for_size(state, session).await
        {
            Ok(snapshot) => to_json(snapshot, "state"),
            Err(e) => Err(e),
        },
        // From the monitor's own history, never from tmux.
        ClientCommand::GetScrollbackCells {
            pane_id,
            start,
            end,
        } => viewer_scrollback(state, session, pane_id, start, end).await,
        // Read from tmux once per server, not once per request.
        ClientCommand::GetThemeSettings => theme_settings_for(state, session).await,
        // A static list compiled in; no tmux, no host.
        ClientCommand::GetThemesList => Ok(tmuxy_core::theme::get_themes_list()),
        // A viewer is shown one session's screen, not the working directory of
        // every pane on the socket, and never makes the host run `git`.
        ClientCommand::ListGitWorktrees => Ok(serde_json::json!([])),
        _ => return None,
    })
}

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
            // Policy lives in tmuxy-core (`transport::route`) and is shared
            // with the desktop app; only the channel write is ours.
            let routed = match transport::route(
                &command,
                session,
                new_window_client_size(state, session).await,
            ) {
                Route::Blocked(reason) => {
                    warn!(?conn_id, %command, reason, "blocked command");
                    return Ok(serde_json::json!(null));
                }
                Route::ControlMode(cmd) => cmd,
            };

            let is_source_file = transport::is_source_file(&routed);

            send_via_control_mode(state, session, &routed).await?;
            trace!(?conn_id, command = %routed, "client sent command via control mode");

            // After source-file, re-broadcast keybindings (prefix key may have
            // changed) and theme settings (theme/appearance options may have).
            if is_source_file {
                tokio::time::sleep(transport::SOURCE_FILE_SETTLE).await;
                refresh_keybindings(state, session).await;
                broadcast_theme_settings(state, session).await;
            }

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
        // A pinned server reports only its own session's repositories —
        // otherwise a viewer learns the repo path and branch of every pane
        // on the tmux server, including the writer's.
        ClientCommand::ListGitWorktrees => {
            let tx = state.monitor_tx(session).await?;
            transport::git_worktrees_json(&tx, state.session_pin.as_deref()).await
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
