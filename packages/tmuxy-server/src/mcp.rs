//! The MCP endpoint: `POST /mcp`, the Model Context Protocol's Streamable
//! HTTP transport, answered with plain JSON (the server never opens an event
//! stream, which the transport allows).
//!
//! An MCP client (Claude Code, Cursor, Zed, …) sees and drives the tmux
//! session tmuxy shows, with one tool per CLI command (`tools`). It is an API
//! route like `/commands`: behind the same Basic auth and the same
//! `request_guard` (a page on another origin cannot call it), and every tmux
//! command it runs goes down the session's control-mode connection through
//! `command_router`'s policy — never a `tmux` subprocess beside it.
//!
//! `?session=<name>` picks the session (the default one otherwise), and
//! `?read-only` lists only the tools that change nothing. Typing into a pane
//! asks the user there first, as `tmuxy pane send -t` does (`ask`).
//!
//! See docs/MCP.md.

mod ask;
mod tmux;
mod tools;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use tmuxy_core::session::SessionName;

use crate::state::AppState;

/// The protocol revisions this endpoint speaks, newest first. A client asking
/// for one of them gets it; any other is answered with the newest.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// The header a session id travels in, both ways.
const SESSION_HEADER: &str = "mcp-session-id";

/// The most bytes of one JSON-RPC message the endpoint reads.
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// What an agent is told about the server when it connects.
const INSTRUCTIONS: &str =
    "tmuxy shows a tmux session in a browser or desktop window. These tools \
see and drive the session the user is looking at. Panes are named by their tmux id (%3) or by \
their label; tabs by their id (@2). pane_send_keys types into a pane only once the user allows it \
there, and blocks until they answer. Wait for output with pane_wait_for rather than polling \
pane_capture.";

#[derive(Debug, Deserialize)]
pub struct McpQuery {
    session: Option<String>,
    #[serde(rename = "read-only")]
    read_only: Option<String>,
}

impl McpQuery {
    /// `?read-only` (or `?read-only=1`), not `?read-only=0`.
    fn read_only(&self) -> bool {
        self.read_only
            .as_deref()
            .is_some_and(|v| !matches!(v, "0" | "false" | "no" | "off"))
    }
}

/// The names connected clients introduced themselves with, by session id:
/// what the question over a pane says is asking. Bounded, oldest first out —
/// a client that is forgotten is only named generically.
#[derive(Default)]
pub struct Clients {
    names: StdMutex<VecDeque<(String, String)>>,
}

/// How many client names the server remembers.
const MAX_CLIENTS: usize = 64;

impl Clients {
    /// Remember `name` and hand back the session id it is known by.
    fn register(&self, name: String) -> String {
        let id = format!("{:016x}{:016x}", random_u64(), random_u64());
        if let Ok(mut names) = self.names.lock() {
            if names.len() == MAX_CLIENTS {
                names.pop_front();
            }
            names.push_back((id.clone(), name));
        }
        id
    }

    fn name(&self, id: &str) -> Option<String> {
        let names = self.names.lock().ok()?;
        names
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, name)| name.clone())
    }
}

/// 64 bits nobody on the socket can work out in advance: std's hasher keys
/// are seeded from the OS's randomness.
pub(crate) fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    hasher.finish()
}

/// A JSON-RPC error: the code and the message.
#[derive(Debug, PartialEq)]
struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    const PARSE: i64 = -32700;
    const INVALID_REQUEST: i64 = -32600;
    const METHOD_NOT_FOUND: i64 = -32601;
    const INVALID_PARAMS: i64 = -32602;

    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn rpc_error_response(status: StatusCode, id: Value, error: RpcError) -> Response {
    (
        status,
        Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": error.code, "message": error.message },
        })),
    )
        .into_response()
}

/// Who a request comes from, and what it may do.
pub(crate) struct Caller {
    /// The session the endpoint URL names.
    session: SessionName,
    /// `?read-only`: only the tools that change nothing.
    read_only: bool,
    /// The name the client introduced itself with, if it did.
    name: Option<String>,
}

impl Caller {
    /// The name the question over a pane gives the sender.
    fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or("an MCP client")
    }
}

pub async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<McpQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let read_only = query.read_only();
    let Some(session) = SessionName::parse(
        query
            .session
            .as_deref()
            .unwrap_or(tmuxy_core::DEFAULT_SESSION_NAME),
    ) else {
        return (StatusCode::BAD_REQUEST, "invalid session name\n").into_response();
    };
    if !crate::sse::has_json_content_type(&headers) {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type must be application/json\n",
        )
            .into_response();
    }
    let Ok(body) = axum::body::to_bytes(body, MAX_MESSAGE_BYTES).await else {
        return (StatusCode::PAYLOAD_TOO_LARGE, "message too large\n").into_response();
    };
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(e) => {
            return rpc_error_response(
                StatusCode::BAD_REQUEST,
                Value::Null,
                RpcError::new(RpcError::PARSE, format!("not JSON: {e}")),
            )
        }
    };
    let Some(message) = message.as_object() else {
        return rpc_error_response(
            StatusCode::BAD_REQUEST,
            Value::Null,
            RpcError::new(
                RpcError::INVALID_REQUEST,
                "one JSON-RPC message per request (batches are not supported)",
            ),
        );
    };
    // A notification (no id) or a response to something the server asked
    // (no method — it never asks) is acknowledged and that is all.
    let (Some(method), Some(id)) = (
        message.get("method").and_then(Value::as_str),
        message.get("id").cloned(),
    ) else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    if method == "initialize" {
        let (result, session_id) = initialize(&state, &params);
        let mut response =
            Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response();
        if let Ok(value) = HeaderValue::from_str(&session_id) {
            response.headers_mut().insert(SESSION_HEADER, value);
        }
        return response;
    }

    let caller = Caller {
        session,
        read_only,
        name: headers
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .and_then(|id| state.mcp_clients.name(id)),
    };
    match dispatch(&state, &caller, method, &params).await {
        Ok(result) => Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response(),
        Err(error) => rpc_error_response(StatusCode::OK, id, error),
    }
}

/// The handshake: the protocol revision both sides speak, what the server
/// offers, and a session id carrying the client's name for later requests.
fn initialize(state: &AppState, params: &Value) -> (Value, String) {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|v| PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    let name = params
        .pointer("/clientInfo/name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.chars().filter(|c| !c.is_control()).take(64).collect())
        .unwrap_or_else(|| "an MCP client".to_string());
    let session_id = state.mcp_clients.register(name);
    let result = json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "tmuxy", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    });
    (result, session_id)
}

async fn dispatch(
    state: &Arc<AppState>,
    caller: &Caller,
    method: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    match method {
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::listed(caller.read_only) })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).ok_or_else(|| {
                RpcError::new(RpcError::INVALID_PARAMS, "tools/call needs a name")
            })?;
            let tool = tools::find(name, caller.read_only).ok_or_else(|| {
                RpcError::new(RpcError::INVALID_PARAMS, format!("unknown tool: {name}"))
            })?;
            let arguments = match params.get("arguments") {
                None | Some(Value::Null) => json!({}),
                Some(args @ Value::Object(_)) => args.clone(),
                Some(_) => {
                    return Err(RpcError::new(
                        RpcError::INVALID_PARAMS,
                        "arguments must be an object",
                    ))
                }
            };
            Ok(tool_result(
                tools::call(tool, state, caller, &arguments).await,
            ))
        }
        _ => Err(RpcError::new(
            RpcError::METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        )),
    }
}

/// A tool's answer as MCP carries it: the JSON as text for every client, and
/// as `structuredContent` for those that read it. A failure is a result too,
/// marked `isError`, so the model sees why.
fn tool_result(outcome: Result<Value, tmuxy_core::CommandError>) -> Value {
    match outcome {
        Ok(value) => {
            let text = serde_json::to_string(&value).unwrap_or_default();
            let mut result = json!({ "content": [{ "type": "text", "text": text }] });
            if value.is_object() {
                result["structuredContent"] = value;
            }
            result
        }
        Err(error) => json!({
            "content": [{ "type": "text", "text": error.error }],
            "isError": true,
        }),
    }
}
