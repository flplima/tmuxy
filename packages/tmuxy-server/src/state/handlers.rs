use axum::{
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::sync::Arc;

use super::AppState;

pub(crate) fn build_response(status: StatusCode, mime: &str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .body(body.into())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

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
            // The id is a per-pane counter that starts again at zero every
            // time the server does, so a cached response would show the
            // previous run's picture at the same URL.
            .header("Cache-Control", "no-store")
            .body(Body::from(img.data))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": "image not found" }),
        ),
    }
}

pub fn find_workspace_root() -> std::path::PathBuf {
    tmuxy_core::host::checkout_root().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    })
}
