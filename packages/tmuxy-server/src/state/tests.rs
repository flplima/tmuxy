use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

fn app() -> Router {
    api_routes(HostPolicy::Loopback { allowed: vec![] }, false)
        .with_state(Arc::new(AppState::new()))
}

/// The POST a hostile page can make without a preflight: `text/plain`,
/// `no-cors`, the command JSON as its body.
fn forged_command(origin: &'static str, site: &'static str) -> Request<Body> {
    Request::post("/commands")
        .header("host", "localhost:9000")
        .header("origin", origin)
        .header("sec-fetch-site", site)
        .header("content-type", "text/plain")
        .body(Body::from(
            r#"{"cmd":"run_tmux_command","args":{"command":"run-shell 'touch /tmp/pwned'"}}"#,
        ))
        .unwrap()
}

fn same_origin_command(body: &'static str) -> Request<Body> {
    Request::post("/commands")
        .header("host", "localhost:9000")
        .header("origin", "http://localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .header("content-type", "application/json")
        .header("x-connection-id", "1")
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn a_read_only_server_refuses_every_write() {
    let state = Arc::new(AppState::new().with_read_only(true));
    let app = api_routes(HostPolicy::Loopback { allowed: vec![] }, true).with_state(state);
    for body in [
        r#"{"cmd":"run_tmux_command","args":{"command":"kill-server"}}"#,
        r#"{"cmd":"query_tmux","args":{"command":"list-panes"}}"#,
        r#"{"cmd":"set_client_size","args":{"cols":10,"rows":5}}"#,
        r#"{"cmd":"set_cursor_blink","args":{"enabled":false}}"#,
        r#"{"cmd":"set_send_ask","args":{"enabled":false}}"#,
        // A read, but one that answers with the server's home path.
        r#"{"cmd":"get_trace_settings"}"#,
    ] {
        let response = app
            .clone()
            .oneshot(same_origin_command(body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{body}");
    }
    // A viewer's tree has no repositories: the answer is empty, and no
    // `git` ran for it.
    let response = app
        .clone()
        .oneshot(same_origin_command(r#"{"cmd":"list_git_worktrees"}"#))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["result"], serde_json::json!([]));
    // `/trace` writes to the server's disk; a viewer's server has no
    // such route at all.
    let trace = Request::post("/trace")
        .header("host", "localhost:9000")
        .header("origin", "http://localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .body(Body::from("[]"))
        .unwrap();
    let response = app.clone().oneshot(trace).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// The pictures that are part of the screen still have a route on a
/// read-only server (a missing one is a 404 from the handler, not from the
/// router; the point is that the route answers as itself).
#[tokio::test]
async fn a_read_only_server_still_serves_the_screens_pictures() {
    let state = Arc::new(AppState::new().with_read_only(true));
    let app = api_routes(HostPolicy::Loopback { allowed: vec![] }, true).with_state(state);

    let request = Request::get("/api/images/%251/1")
        .header("host", "localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_ne!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn a_page_on_another_origin_cannot_post_a_command() {
    for (origin, site) in [
        ("https://evil.example", "cross-site"),
        ("http://localhost:3000", "same-site"),
        ("null", "cross-site"),
    ] {
        let response = app().oneshot(forged_command(origin, site)).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
        assert!(response
            .headers()
            .get("access-control-allow-origin")
            .is_none());
    }
}

#[tokio::test]
async fn the_app_itself_reaches_the_handler() {
    // An empty body gets past the guard and is refused by the handler's
    // decoder — a 400, not the guard's 403.
    let request = Request::post("/commands")
        .header("host", "localhost:9000")
        .header("origin", "http://localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .body(Body::empty())
        .unwrap();
    let response = app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_session_name_that_would_split_the_command_line_is_refused() {
    for request in [
        Request::get("/events?session=x%0Arun-shell%20id").body(Body::empty()),
        Request::post("/commands?session=x%0Arun-shell%20id").body(Body::empty()),
    ] {
        let mut request = request.unwrap();
        request.headers_mut().insert(
            "host",
            axum::http::HeaderValue::from_static("localhost:9000"),
        );
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

/// Every API route, paired with a concrete URL to probe it with. The
/// enumeration test below asserts this table names exactly the routes
/// `api_routes` declares — no more, no fewer.
const COVERED_ROUTES: &[(&str, &str)] = &[
    ("/events", "/events"),
    ("/commands", "/commands"),
    ("/trace", "/trace"),
    ("/api/images/{pane_id}/{image_id}", "/api/images/1/0"),
];

/// A request for `route` in the shape a page on another origin sends one.
fn cross_origin_request_for(route: &str) -> Option<Request<Body>> {
    let (_, target) = COVERED_ROUTES.iter().find(|(name, _)| *name == route)?;
    let builder = if route == "/commands" || route == "/trace" {
        Request::post(*target)
    } else {
        Request::get(*target)
    };
    Some(
        builder
            .header("host", "localhost:9000")
            .header("origin", "https://evil.example")
            .header("sec-fetch-site", "cross-site")
            .body(Body::empty())
            .unwrap(),
    )
}

/// The route table as `api_routes` and the two builders under it declare
/// it, read out of this file's own source.
///
/// The guard is the `.layer()` in `api_routes`, and it covers whatever
/// `writable_routes` / `viewer_routes` built. A route added anywhere else
/// — or a whole new route nobody thought to test — is served with no
/// origin check at all, which on this API means a remote shell. So the
/// routes are enumerated rather than listed by hand: a new one that the
/// coverage table below does not know about fails this test by name.
fn declared_routes() -> Vec<String> {
    let source = include_str!("../state.rs");
    let start = source
        .find("pub fn api_routes")
        .expect("api_routes moved out of state.rs");
    let body = &source[start..];
    let end = body
        .find("// Internal Handlers")
        .expect("the route builders are no longer followed by the handlers");
    let body = &body[..end];

    // The literal is split so this scan does not find itself.
    let needle = concat!(".", "route(");
    let mut routes = Vec::new();
    let mut rest = body;
    while let Some(idx) = rest.find(needle) {
        rest = rest[idx + needle.len()..].trim_start();
        let rest_after_quote = rest
            .strip_prefix('"')
            .expect("a route's path is not a string literal");
        let close = rest_after_quote
            .find('"')
            .expect("unterminated route literal");
        routes.push(rest_after_quote[..close].to_string());
        rest = &rest_after_quote[close..];
    }
    assert!(!routes.is_empty(), "found no routes in api_routes");
    routes
}

#[tokio::test]
async fn every_route_the_router_declares_is_behind_the_guard() {
    let declared: std::collections::BTreeSet<String> = declared_routes().into_iter().collect();
    let covered: std::collections::BTreeSet<String> = COVERED_ROUTES
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect();
    assert_eq!(
        declared, covered,
        "the route table and COVERED_ROUTES disagree. A route added to api_routes must be \
         probed here, or it ships with nobody having checked the guard reaches it."
    );

    for route in declared {
        let request = cross_origin_request_for(&route).unwrap_or_else(|| {
            panic!(
                "route {route} is new and not covered by the guard test. \
                 Add it to `cross_origin_request_for` so a page on another \
                 origin is proven unable to reach it."
            )
        });
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "route {route} answered a cross-origin request — it is declared after the guard layer, or outside api_routes"
        );
    }
}

#[tokio::test]
async fn every_route_refuses_a_rebound_host_on_a_loopback_bind() {
    // DNS rebinding: the page looks same-origin to the browser, but the
    // Host header still carries the attacker's own domain.
    for route in declared_routes() {
        let mut request = cross_origin_request_for(&route).expect("covered above");
        let headers = request.headers_mut();
        headers.insert(
            "host",
            axum::http::HeaderValue::from_static("attacker.example:9000"),
        );
        headers.insert(
            "origin",
            axum::http::HeaderValue::from_static("http://attacker.example:9000"),
        );
        headers.insert(
            "sec-fetch-site",
            axum::http::HeaderValue::from_static("same-origin"),
        );
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "route {route} served a rebound domain"
        );
    }
}

/// Blocking the buttons in the UI is not enforcement: a viewer can POST
/// whatever it likes. Every write must be refused by the server.
#[tokio::test]
async fn a_read_only_server_refuses_keystrokes_and_resizes() {
    let state = Arc::new(AppState::new().with_read_only(true));
    let app = api_routes(HostPolicy::Loopback { allowed: vec![] }, true).with_state(state);
    for body in [
        // Typing into a pane — the write a viewer most obviously wants.
        r#"{"cmd":"run_tmux_command","args":{"command":"send-keys -t %1 'rm -rf ~' Enter"}}"#,
        r#"{"cmd":"run_tmux_command","args":{"command":"send-keys -l x"}}"#,
        // A read-shaped tmux command still rides the same channel, and
        // nothing here can tell a read from a write.
        r#"{"cmd":"query_tmux","args":{"command":"list-panes"}}"#,
        // Resizing changes the session under whoever is writing in it.
        r#"{"cmd":"set_client_size","args":{"cols":10,"rows":5}}"#,
        // Anything that writes a tmux option.
        r#"{"cmd":"set_theme","args":{"name":"nord"}}"#,
        r#"{"cmd":"set_theme_mode","args":{"mode":"dark"}}"#,
        r#"{"cmd":"set_trace_enabled","args":{"enabled":true}}"#,
    ] {
        let response = app
            .clone()
            .oneshot(same_origin_command(body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{body}");
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["error"], "read-only server", "{body}");
    }
}

/// The image route takes a pane id and an image id straight from the URL.
/// They index an in-memory map, never the filesystem — a traversal-shaped
/// id must come back empty rather than serving a file.
#[tokio::test]
async fn the_image_route_never_reads_from_disk() {
    for target in [
        "/api/images/..%2F..%2F..%2Fetc%2Fhosts/0",
        "/api/images/%2Fetc%2Fpasswd/0",
        "/api/images/1/0",
    ] {
        let request = Request::get(target)
            .header("host", "localhost:9000")
            .body(Body::empty())
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{target} did not 404"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["error"], "image not found", "{target}");
    }
}

/// The trace ingest writes to a file on this machine, so its body is
/// capped. Without the cap one request fills the disk.
#[tokio::test]
async fn an_oversized_trace_body_is_refused_before_it_is_read() {
    let oversized = "x".repeat(300 * 1024);
    let request = Request::post("/trace")
        .header("host", "localhost:9000")
        .header("origin", "http://localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .body(Body::from(oversized))
        .unwrap();
    let response = app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
