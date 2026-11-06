use axum::{
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::sync::Arc;

use super::AppState;

/// Build an HTTP response from a status, content-type, and body.
///
/// `Response::builder().body()` only returns `Err` when a header value contains
/// invalid bytes (control characters, non-ASCII, etc.). All callers in this
/// module pass static `&'static str` mime types, so the unwrap path is
/// effectively unreachable — but if a future caller somehow injects a bad
/// header value we'd rather return a 500 than panic the server thread.
pub(crate) fn build_response(status: StatusCode, mime: &str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .body(body.into())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Convenience: build a `application/json` response from a serializable value.
/// Serialization errors round-trip as a 500 with a plain-text fallback body.
fn json_response(status: StatusCode, value: &serde_json::Value) -> Response {
    match serde_json::to_string(value) {
        Ok(body) => build_response(status, "application/json", body),
        Err(_) => build_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            "internal server error: failed to serialize JSON response",
        ),
    }
}

pub(super) async fn image_handler(
    State(state): State<Arc<AppState>>,
    Path((pane_id, image_id)): Path<(String, u32)>,
) -> Response {
    // Each session keeps its own pictures, and the URL names only the pane:
    // pane ids are unique on the socket, so the one session holding it is
    // the one that drew it.
    let image = match tmuxy_core::PaneId::parse(&format!("%{pane_id}")) {
        Ok(pane_id) => state
            .sessions
            .read()
            .await
            .values()
            .find_map(|conns| conns.runtime.image(&pane_id, image_id)),
        Err(_) => None,
    };
    match image {
        Some(img) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", &img.mime_type)
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", "default-src 'none'; sandbox")
            .header("Cross-Origin-Resource-Policy", "same-origin")
            // Never cached. The id is a per-pane counter that starts again at
            // zero every time the server does, so an hour-long cache serves the
            // PREVIOUS run's picture at the same URL — a restarted tmuxy shows
            // a stale frame where the new one should be. Nothing here is worth
            // caching anyway: a live preview mints a new id per frame, and a
            // still image is fetched once per mount over a local socket.
            .header("Cache-Control", "no-store")
            .body(Body::from(img.data))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": "image not found" }),
        ),
    }
}

/// The repository root when the server runs from a checkout (the directory
/// whose package.json declares "workspaces"), else the process's cwd. Dev mode
/// serves the frontend from here.
pub fn find_workspace_root() -> std::path::PathBuf {
    tmuxy_core::host::checkout_root().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    })
}
