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

/// Maximum request body accepted on `POST /commands` (2 MiB).
const COMMANDS_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Maximum request body accepted on `POST /trace` (256 KiB).
const TRACE_MAX_BYTES: usize = 256 * 1024;

/// Require a single `Content-Type: application/json` header (with optional
/// parameters such as `; charset=utf-8`) so HTML `<form>` submissions and
/// no-preflight `text/plain` fetches are refused even without Fetch Metadata.
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

// ============================================
// Commands Handler (POST /commands)
// ============================================

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

    // Decode into the typed enum. A malformed payload — a misspelt field, a
    // pane id that is not one — is a 400 of kind `invalid`.
    let cmd = match ClientCommand::from_value(value) {
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

/// The web door's own request: make `?session=` exist (with a monitor)
/// before `GET /events` attaches to it, so the stream itself stays free of
/// side effects.
pub(super) const ENSURE_SESSION: &str = "ensure_session";

// ============================================
// Trace Ingest Handler (POST /trace)
// ============================================

/// Ingest client-originated trace events (browser/Tauri tracer) into the shared
/// NDJSON file. **Fails closed**: if tracing is not enabled on this server the
/// body is dropped regardless of what the client believes, so a stale client
/// flag can never reopen the sink. Every event is re-sanitized server-side
/// (`trace::record_client_batch`) before it touches the file.
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

// ============================================
// Command Handler
// ============================================

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

/// Where the events of a session the server does not watch go: nowhere.
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
