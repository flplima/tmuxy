use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

fn app() -> Router {
    api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(Arc::new(AppState::new()))
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

fn preview_page_request(site: &'static str) -> Request<Body> {
    Request::get("/api/preview/7?v=1")
        .header("host", "localhost:9000")
        .header("sec-fetch-site", site)
        .header("sec-fetch-dest", "iframe")
        .body(Body::empty())
        .unwrap()
}

/// A preview's page is served under its own policy whoever loads it: an
/// opaque origin (`sandbox` without `allow-same-origin`), offline unless the
/// preview was opened with `--net`, never sniffed or cached.
#[tokio::test]
async fn a_staged_page_is_served_sandboxed_and_offline() {
    let state = Arc::new(AppState::new());
    state
        .preview_pages
        .stage(
            tmuxy_core::PaneId::parse("%7").unwrap(),
            "<h1>page</h1>".into(),
            false,
        )
        .unwrap();
    let app = api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(state);

    let response = app
        .clone()
        .oneshot(preview_page_request("same-origin"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let csp = header("content-security-policy");
    assert!(csp.starts_with("sandbox allow-scripts;"), "{csp}");
    assert!(!csp.contains("allow-same-origin"), "{csp}");
    assert!(csp.contains("connect-src 'none'"), "{csp}");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_eq!(header("cache-control"), "no-store");
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], b"<h1>page</h1>");

    // Asked for from the page itself — an opaque origin, so `cross-site` —
    // or any other page, the guard refuses it like every API route.
    let response = app
        .clone()
        .oneshot(preview_page_request("cross-site"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // A pane with nothing staged has no page.
    let missing = Request::get("/api/preview/8")
        .header("host", "localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(missing).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// Staging asks tmux whether the pane is a preview at all; with no session
/// to ask, nothing is staged.
#[tokio::test]
async fn a_page_is_not_staged_for_a_pane_tmux_has_not_authorised() {
    let state = Arc::new(AppState::new());
    let app = api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(state.clone());
    let request = Request::post("/api/preview/3")
        .header("host", "localhost:9000")
        .header("origin", "http://localhost:9000")
        .header("sec-fetch-site", "same-origin")
        .body(Body::from("<script>evil()</script>"))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // Nor from a page on another origin, which the guard turns away first.
    let forged = Request::post("/api/preview/3")
        .header("host", "localhost:9000")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("content-type", "text/plain")
        .body(Body::from("<script>evil()</script>"))
        .unwrap();
    let response = app.oneshot(forged).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(state
        .preview_pages
        .page(&tmuxy_core::PaneId::parse("%3").unwrap())
        .is_none());
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
    ("/api/preview/{pane_id}", "/api/preview/1"),
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

/// The route table as `api_routes` declares it, read out of this file's own
/// source.
///
/// The guard is the `.layer()` in `api_routes`, and it covers the routes
/// declared above it. A route added anywhere else
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

mod session_start_dir {
    use super::super::handlers::session_start_dir_from;
    use std::path::PathBuf;

    #[test]
    fn a_checkout_wins_so_the_dev_loop_starts_in_the_repo() {
        let dir = session_start_dir_from(
            Some(PathBuf::from("/src/tmuxy")),
            Some(PathBuf::from("/home/u")),
            Some(PathBuf::from("/tmp/.mount_tmuxyAb12/usr")),
        );
        assert_eq!(dir, PathBuf::from("/src/tmuxy"));
    }

    #[test]
    fn outside_a_checkout_the_home_directory_not_the_process_cwd() {
        let dir = session_start_dir_from(
            None,
            Some(PathBuf::from("/home/u")),
            Some(PathBuf::from("/tmp/.mount_tmuxyAb12/usr")),
        );
        assert_eq!(dir, PathBuf::from("/home/u"));
    }

    #[test]
    fn with_no_home_the_cwd_is_what_is_left() {
        let dir = session_start_dir_from(None, None, Some(PathBuf::from("/")));
        assert_eq!(dir, PathBuf::from("/"));
    }
}
