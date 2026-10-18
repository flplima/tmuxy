use axum::{
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use tmuxy_core::mime::{
    content_type_for_path, read_served_file, ServeRefusal, FILE_SANDBOX_CSP, MAX_SERVED_FILE_BYTES,
};

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

/// Serve a local file at a path-shaped URL: `/api/browse/Users/me/doc/index.html`.
///
/// The browser widget frames this route, and a framed page's relative links
/// (`./style.css`, `../img/logo.png`) resolve against the URL it was loaded
/// from — which is why the path lives in the URL rather than a query string,
/// which would send every subresource to `/api/style.css`. Axum has already
/// percent-decoded the captured path; the leading `/` it strips is put back so
/// the absolute path on disk round-trips.
///
/// This reads anywhere the server process can, gated by the optional
/// `--password` Basic auth and absent from a `--read-only` server
/// (`viewer_routes`). See docs/SECURITY.md.
pub(super) async fn browse_handler(Path(path): Path<String>) -> Response {
    read_file_offthread(format!("/{}", path.trim_start_matches('/'))).await
}

/// `read_file_response` on the blocking pool.
///
/// The read is synchronous and can be slow (a cold 64 MiB file, a network
/// mount that hangs), and a Tokio worker thread blocked in it serves nothing
/// else — including the SSE streams every other client is on.
async fn read_file_offthread(path: String) -> Response {
    match tokio::task::spawn_blocking(move || read_file_response(&path)).await {
        Ok(response) => response,
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({ "error": format!("file read task failed: {e}") }),
        ),
    }
}

/// A local file, served so the browser widget can frame it in any build.
///
/// The checks before the read are `tmuxy_core::mime::read_served_file`'s,
/// shared with the desktop app's `tmuxyfile:` scheme; each refusal maps to
/// its status here.
///
/// The Vite dev server serves the app cross-origin-isolated (COOP
/// `same-origin`, COEP `require-corp`), and under that policy a framed
/// document is blocked unless it opts in too: the widget showed the browser's
/// broken-page placeholder for every local HTML file. `credentialless` is that
/// opt-in without the cost `require-corp` would carry — a page's own
/// cross-origin scripts and images still load, just without credentials — and
/// `Cross-Origin-Resource-Policy` lets the file itself be embedded. Outside an
/// isolated parent both headers change nothing.
fn read_file_response(path: &str) -> Response {
    let content = match read_served_file(path) {
        Ok(content) => content,
        Err(refusal) => {
            let (status, error) = match refusal {
                ServeRefusal::NotFound(e) => (StatusCode::NOT_FOUND, e),
                ServeRefusal::NotRegular => {
                    (StatusCode::BAD_REQUEST, "not a regular file".to_string())
                }
                ServeRefusal::TooLarge { .. } => (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("file is larger than {MAX_SERVED_FILE_BYTES} bytes"),
                ),
            };
            return json_response(status, &serde_json::json!({ "error": error }));
        }
    };
    let mut response = build_response(StatusCode::OK, content_type_for_path(path), content);
    let headers = response.headers_mut();
    headers.insert(
        axum::http::header::HeaderName::from_static("cross-origin-embedder-policy"),
        axum::http::HeaderValue::from_static("credentialless"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("cross-origin-resource-policy"),
        axum::http::HeaderValue::from_static("cross-origin"),
    );
    // Rendered with the server's origin, an HTML file could POST tmux commands
    // like the app does. `sandbox` gives it an opaque origin of its own,
    // whether the browser widget frames it or someone opens its URL directly.
    headers.insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        axum::http::HeaderValue::from_static(FILE_SANDBOX_CSP),
    );
    response
}

pub(super) async fn image_handler(
    State(state): State<Arc<AppState>>,
    Path((pane_id, image_id)): Path<(String, u32)>,
) -> Response {
    let store = state.image_store.read().await;
    let image = tmuxy_core::PaneId::parse(&format!("%{pane_id}"))
        .ok()
        .and_then(|pane_id| store.get(&pane_id, image_id));
    match image {
        Some(img) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", &img.mime_type)
            // Never cached. The id is a per-pane counter that starts again at
            // zero every time the server does, so an hour-long cache serves the
            // PREVIOUS run's picture at the same URL — a restarted tmuxy shows
            // a stale frame where the new one should be. Nothing here is worth
            // caching anyway: a live preview mints a new id per frame, and a
            // still image is fetched once per mount over a local socket.
            .header("Cache-Control", "no-store")
            .body(Body::from(img.data.clone()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": "image not found" }),
        ),
    }
}

/// Find the workspace root (directory with package.json containing "workspaces")
pub fn find_workspace_root() -> std::path::PathBuf {
    std::env::current_dir()
        .ok()
        .and_then(|p| {
            let mut current = p;
            loop {
                let pkg_json = current.join("package.json");
                if pkg_json.exists() {
                    if let Ok(content) = std::fs::read_to_string(&pkg_json) {
                        if content.contains("\"workspaces\"") {
                            return Some(current);
                        }
                    }
                }
                if !current.pop() {
                    break;
                }
            }
            None
        })
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod file_route_tests {
    use super::*;

    /// SEC-02. The path is the client's, and `std::fs::read` on a character
    /// device never ends: `/api/browse/dev/zero` grew the server until the
    /// OS killed it. A FIFO is worse — the read blocks a Tokio worker forever.
    #[test]
    fn a_file_that_is_not_a_regular_file_is_refused_rather_than_read() {
        for path in ["/dev/zero", "/dev/null", "/tmp"] {
            if !std::path::Path::new(path).exists() {
                continue;
            }
            let response = read_file_response(path);
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{path} should be refused as not a regular file"
            );
        }
    }

    /// SEC-02. The realistic case is accidental — the widget pointed at a
    /// multi-gigabyte log — and it takes the server down just the same.
    #[test]
    fn a_file_over_the_cap_is_refused_before_it_is_read() {
        let path = std::env::temp_dir().join(format!("tmuxy-big-{}.bin", std::process::id()));
        let file = std::fs::File::create(&path).unwrap();
        // Sparse: the length is what the check reads, and nothing writes 64 MiB.
        file.set_len(MAX_SERVED_FILE_BYTES + 1).unwrap();
        drop(file);

        let response = read_file_response(path.to_str().unwrap());
        std::fs::remove_file(&path).ok();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn a_file_at_the_cap_is_still_served() {
        let path = std::env::temp_dir().join(format!("tmuxy-atcap-{}.txt", std::process::id()));
        std::fs::write(&path, b"small enough").unwrap();

        let response = read_file_response(path.to_str().unwrap());
        std::fs::remove_file(&path).ok();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn a_served_file_can_be_framed_by_a_cross_origin_isolated_app() {
        // The dev app is served with COEP `require-corp`; a frame that does
        // not opt in is replaced by the browser's broken-page placeholder.
        let path = std::env::temp_dir().join(format!("tmuxy-browse-{}.html", std::process::id()));
        std::fs::write(&path, "<h1>framed</h1>").unwrap();
        let response = read_file_response(path.to_str().unwrap());
        std::fs::remove_file(&path).ok();

        assert_eq!(response.status(), StatusCode::OK);
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        assert_eq!(
            header("cross-origin-embedder-policy").as_deref(),
            Some("credentialless")
        );
        assert_eq!(
            header("cross-origin-resource-policy").as_deref(),
            Some("cross-origin")
        );
        // Sandboxed: an HTML file never runs with the server's origin.
        let csp = header("content-security-policy").unwrap_or_default();
        assert!(csp.starts_with("sandbox "), "{csp}");
        assert!(!csp.contains("allow-same-origin"), "{csp}");
    }

    #[test]
    fn a_missing_file_is_a_404() {
        let response = read_file_response("/tmp/tmuxy-no-such-file-for-the-browse-route.html");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
