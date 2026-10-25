//! `/api/preview/{pane}`: the page a `preview` pane frames.
//!
//! The client composes the page — the document's resources inlined, the
//! theme and the bridge added — and POSTs it here; the pane's frame then loads
//! it with a GET. Serving it from a URL rather than a `srcdoc` is what lets the
//! page carry its own policy as a response header (`tmuxy_core::preview::page_csp`):
//! `sandbox` gives it an opaque origin whoever loads the URL, so it never runs
//! as the app.
//!
//! Staging re-asks tmux whether the pane is a preview of an HTML document, and
//! takes the page's network permission from tmux too, so a client cannot stage
//! an online page for an offline preview (`tmuxy_core::preview::stage_page`).

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use tmuxy_core::preview::stage_page;
use tmuxy_core::{CommandError, PaneId};

use super::commands::command_failure;
use super::SessionQuery;
use crate::state::AppState;

/// The route's `{pane}` is the pane's number, as `/api/images` takes it.
fn pane_from_path(number: &str) -> Result<PaneId, CommandError> {
    PaneId::parse(&format!("%{number}")).map_err(CommandError::from)
}

/// `POST /api/preview/{pane}`: stage the pane's page.
pub async fn stage_preview_handler(
    State(state): State<Arc<AppState>>,
    Path(number): Path<String>,
    Query(query): Query<SessionQuery>,
    html: String,
) -> Response {
    let session = match query.session() {
        Ok(session) => session,
        Err(rejection) => return rejection.into_command_failure(),
    };
    let pane = match pane_from_path(&number) {
        Ok(pane) => pane,
        Err(error) => return command_failure(StatusCode::BAD_REQUEST, error),
    };
    let staged = async {
        let tx = state.monitor_tx(&session).await?;
        stage_page(&tx, &state.preview_pages, pane, html).await
    }
    .await;
    match staged {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => command_failure(StatusCode::FORBIDDEN, error),
    }
}

/// `GET /api/preview/{pane}`: the pane's staged page, under its policy
/// (`StagedPage::headers`).
pub async fn preview_page_handler(
    State(state): State<Arc<AppState>>,
    Path(number): Path<String>,
) -> Response {
    let pane = match pane_from_path(&number) {
        Ok(pane) => pane,
        Err(error) => return command_failure(StatusCode::BAD_REQUEST, error),
    };
    let Some(page) = state.preview_pages.page(&pane) else {
        return (StatusCode::NOT_FOUND, "no page is staged for this pane\n").into_response();
    };
    let mut builder = Response::builder().status(StatusCode::OK);
    for (name, value) in page.headers() {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(page.html))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
