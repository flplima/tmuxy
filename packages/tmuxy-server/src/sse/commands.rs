use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::sync::Arc;
use tmuxy_core::host::{
    self, ClientCommand, HostCtx, HostEvent, RuntimeConfig, SessionRuntime, Sink,
};
use tmuxy_core::CommandError;

use super::clients::open_client;
use super::SessionQuery;
use crate::state::AppState;

/// A command's answer. A failure is a `CommandError` instead —
/// `{ "error", "kind" }` — sent with a 4xx status.
#[derive(Debug, Serialize)]
pub(super) struct CommandResponse {
    pub(super) result: serde_json::Value,
}

pub(super) fn command_failure(status: StatusCode, error: CommandError) -> Response {
    (status, Json(error)).into_response()
}

const COMMANDS_MAX_BYTES: usize = 2 * 1024 * 1024;
const TRACE_MAX_BYTES: usize = 256 * 1024;

/// HTML `<form>` submissions and no-preflight `text/plain` fetches are
/// refused by this even without Fetch Metadata.
pub(crate) fn has_json_content_type(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(header::CONTENT_TYPE).iter();
    match (values.next(), values.next()) {
        (Some(only), None) => only
            .to_str()
            .ok()
            .and_then(|ct| ct.split(';').next())
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json")),
        _ => false,
    }
}

pub async fn commands_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let session = match query.session() {
        Ok(session) => session,
        Err(rejection) => return rejection.into_command_failure(),
    };
    if !has_json_content_type(&headers) {
        return command_failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            CommandError::invalid("Content-Type must be application/json"),
        );
    }
    let Ok(body) = axum::body::to_bytes(body, COMMANDS_MAX_BYTES).await else {
        return command_failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            CommandError::invalid("command payload too large"),
        );
    };

    // Every stream is handed its id in the `connection-info` greeting, so no
    // header means no stream. Not 0: that is a real id, and its viewport
    // entry would be overwritten.
    let conn_id: Option<u64> = headers
        .get("x-connection-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // The request leg of an action's trace (docs/TRACING.md); the id only,
    // never the content.
    if let Some(action_id) = headers.get("x-action-id").and_then(|v| v.to_str().ok()) {
        tracing::info!(target: "tmuxy_server::sse", action_id = %action_id, "client command");
    }

    // `ensure_session` is this door's own request, not a client command:
    // it creates the session `GET /events` will attach to, under the
    // server's session cap, and its refusals have HTTP statuses of their own.
    let value: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(e) => {
            return command_failure(
                StatusCode::BAD_REQUEST,
                CommandError::invalid(format!("invalid command payload: {e}")),
            );
        }
    };
    if value.get("cmd").and_then(serde_json::Value::as_str) == Some(ENSURE_SESSION) {
        return match super::clients::ensure_session(&state, &session).await {
            Ok(()) => (
                StatusCode::OK,
                Json(CommandResponse {
                    result: serde_json::Value::Null,
                }),
            )
                .into_response(),
            Err(rejection) => rejection.into_command_failure(),
        };
    }

    let cmd = match ClientCommand::from_value(value) {
        Ok(c) => c,
        Err(e) => {
            return command_failure(
                StatusCode::BAD_REQUEST,
                CommandError::invalid(format!("invalid command payload: {e}")),
            );
        }
    };

    // A numbered command waits for the ones its client issued before it; the
    // turn is held until this one is on the monitor's channel. One with no
    // number, or from a client with no open stream, runs as it arrives.
    let seq: Option<u64> = headers
        .get("x-command-seq")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());
    let _turn = match (conn_id, seq) {
        (Some(conn_id), Some(seq)) => match command_gate(&state, &session, conn_id).await {
            Some(gate) => match gate.enter(seq).await {
                Ok(turn) => Some(turn),
                Err(super::order::Full) => {
                    return command_failure(
                        StatusCode::TOO_MANY_REQUESTS,
                        CommandError::unavailable("too many commands waiting for their turn"),
                    );
                }
            },
            None => None,
        },
        _ => None,
    };

    match handle_command(cmd, &session, &state, conn_id).await {
        Ok(result) => (StatusCode::OK, Json(CommandResponse { result })).into_response(),
        Err(error) => command_failure(StatusCode::BAD_REQUEST, error),
    }
}

async fn command_gate(
    state: &Arc<AppState>,
    session: &str,
    conn_id: u64,
) -> Option<Arc<super::order::CommandGate>> {
    state
        .sessions
        .read()
        .await
        .get(session)
        .and_then(|conns| conns.command_gates.get(&conn_id).cloned())
}

/// The web door's own request: make `?session=` exist (with a monitor)
/// before `GET /events` attaches to it, so the stream itself stays free of
/// side effects.
pub(super) const ENSURE_SESSION: &str = "ensure_session";

/// Fails closed: with tracing off on this server the body is dropped whatever
/// the client believes, so a stale client flag cannot reopen the sink. Every
/// event is sanitized again here (`trace::record_client_batch`).
pub async fn trace_handler(headers: HeaderMap, body: Body) -> StatusCode {
    if !has_json_content_type(&headers) {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE;
    }
    let Ok(body) = axum::body::to_bytes(body, TRACE_MAX_BYTES).await else {
        return StatusCode::PAYLOAD_TOO_LARGE;
    };
    if !tmuxy_core::trace::is_enabled() {
        return StatusCode::NO_CONTENT;
    }
    let events: Vec<serde_json::Map<String, serde_json::Value>> =
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return StatusCode::BAD_REQUEST,
        };
    tmuxy_core::trace::record_client_batch(events);
    StatusCode::NO_CONTENT
}

/// A command's view of the web host: the session's runtime, and the client
/// when its stream is open. The web serves the socket it was started on, so
/// it switches no servers, detaches no one and opens nothing on its own
/// machine: those answer `unavailable` (`HostCtx`'s defaults).
struct WebCtx {
    runtime: Arc<SessionRuntime>,
    client: Option<u64>,
}

impl HostCtx for WebCtx {
    fn runtime(&self) -> &SessionRuntime {
        &self.runtime
    }

    fn client(&self) -> Option<u64> {
        self.client
    }
}

struct Unwatched;

impl Sink for Unwatched {
    fn emit(&self, _event: HostEvent) {}
}

pub(super) async fn handle_command(
    cmd: ClientCommand,
    session: &str,
    state: &Arc<AppState>,
    conn_id: Option<u64>,
) -> Result<serde_json::Value, CommandError> {
    // A session no stream watches has no monitor: a command that needs one
    // is refused at once, and the rest (the themes, the snapshots, the trace
    // switch) are answered all the same.
    let runtime = match state.runtime(session).await {
        Some(runtime) => runtime,
        None => {
            let runtime = SessionRuntime::new(
                RuntimeConfig {
                    session: session.to_string(),
                    preview: Arc::clone(&state.preview_pages),
                    preview_scope: session.to_string(),
                    restore: false,
                },
                Arc::new(Unwatched),
            );
            runtime.set_down();
            runtime
        }
    };
    let ctx = WebCtx {
        runtime,
        client: open_client(state, session, conn_id).await,
    };
    host::handle(cmd, &ctx).await
}
