use axum::http::StatusCode;

use super::*;

/// A scratch pid-file path unique to this test, cleaned up on drop.
struct PidFile(std::path::PathBuf);

impl PidFile {
    fn new(tag: &str) -> Self {
        Self(std::env::temp_dir().join(format!("tmuxy-pidfile-{}-{tag}.pid", std::process::id())))
    }
    fn write(&self, contents: &str) {
        std::fs::write(&self.0, contents).unwrap();
    }
    fn read(&self) -> Option<String> {
        std::fs::read_to_string(&self.0).ok()
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).ok();
    }
}

#[test]
fn a_stopping_server_leaves_its_replacements_pid_file_alone() {
    let file = PidFile::new("takeover");

    // The old server (pid 100) exits after its replacement (pid 200) has
    // already written the file for the same port.
    file.write("200");
    remove_pid_file_at(&file.0, 100);
    assert_eq!(file.read().as_deref(), Some("200"));

    // The replacement's own exit does remove it.
    remove_pid_file_at(&file.0, 200);
    assert!(!file.0.exists());

    // A file that is already gone, or holds no pid, is not an error.
    remove_pid_file_at(&file.0, 200);
    file.write("not a pid");
    remove_pid_file_at(&file.0, 200);
    assert!(file.0.exists());
}

/// The whole takeover sequence, in the order it happens on a restart:
/// the new server writes its pid while the old one is still shutting down,
/// and the old one's cleanup must be a no-op. Getting this wrong is how
/// `tmuxy server stop` came to report a live server as gone.
#[test]
fn a_restart_leaves_the_running_server_findable() {
    let file = PidFile::new("restart");
    let old_pid = 4242;
    let new_pid = 4343;

    // 1. The old server is running and owns the file.
    file.write(&old_pid.to_string());
    // 2. The replacement starts and takes the file over.
    file.write(&new_pid.to_string());
    // 3. The old server finishes shutting down and cleans up.
    remove_pid_file_at(&file.0, old_pid);

    // `stop`/`status` read the file next; it must still name the live one.
    let found: u32 = file.read().unwrap().trim().parse().unwrap();
    assert_eq!(
        found, new_pid,
        "a stopping server deleted its replacement's pid file"
    );
}

/// Trailing whitespace is what a shell redirect leaves behind, and the
/// comparison is on the parsed number, not the bytes.
#[test]
fn a_pid_file_written_with_a_trailing_newline_still_matches_its_owner() {
    let file = PidFile::new("newline");
    file.write("777\n");
    remove_pid_file_at(&file.0, 776);
    assert!(file.0.exists(), "a different pid removed the file");
    remove_pid_file_at(&file.0, 777);
    assert!(!file.0.exists(), "the owning pid did not remove the file");
}

/// Version skew, case 3 (see `tests/version_skew.rs`): two servers running
/// at once must not share a pid file, or stopping the second stops the
/// first.
///
/// They are the normal state of a dev machine — a released build on
/// `tmuxy`, the dev server on `tmuxy-dev`, the test suite on `tmuxy-test`
/// — and each writes its pid so `tmuxy server stop` and `status` can find
/// it. One shared file would mean the second server's write silently
/// replaces the first's, after which `stop` signals whichever pid was
/// written last, on whatever port the user asked about.
#[test]
fn each_port_owns_its_own_pid_file() {
    let default = pid_file_path(DEFAULT_PORT);
    let other = pid_file_path(DEFAULT_PORT + 1);
    assert_ne!(default, other);
    assert_ne!(other, pid_file_path(9999));
    // Stable, or a server cannot find the file it wrote itself.
    assert_eq!(default, pid_file_path(DEFAULT_PORT));
    // The default port keeps the historical name, which `stop` and every
    // existing install already look for.
    assert_eq!(default.file_name().unwrap(), "tmuxy.pid");
    assert_eq!(
        other.file_name().unwrap(),
        format!("tmuxy-{}.pid", DEFAULT_PORT + 1).as_str()
    );
}

fn loopback(allowed: Vec<String>) -> HostPolicy {
    HostPolicy::Loopback { allowed }
}

#[test]
fn loopback_is_served_without_a_password() {
    for host in ["127.0.0.1", "localhost", "::1", "[::1]"] {
        let listen = resolve_listen(host, false, false, vec![]).unwrap();
        assert!(listen.ip.is_loopback(), "{host}");
        assert_eq!(listen.policy, loopback(vec![]), "{host}");
    }
}

#[test]
fn a_routable_address_needs_a_password_or_no_auth() {
    assert!(resolve_listen("0.0.0.0", false, false, vec![]).is_err());
    // A wildcard bind knows no address of its own: `bound` is None, and the
    // guard accepts any IP literal in its place.
    assert_eq!(
        resolve_listen("0.0.0.0", true, false, vec![])
            .unwrap()
            .policy,
        HostPolicy::Bound {
            bound: None,
            allowed: vec![]
        }
    );
    assert_eq!(
        resolve_listen("192.168.1.20", false, true, vec![])
            .unwrap()
            .policy,
        HostPolicy::Bound {
            bound: Some("192.168.1.20".parse().unwrap()),
            allowed: vec![]
        }
    );
}

/// SEC-15: the allowed list was kept only on a loopback bind, so
/// `--allowed-host` (and `TMUXY_ALLOWED_HOSTS`) silently did nothing on the
/// routable bind that actually needed it, where every other `Host` should
/// answer 403.
#[test]
fn a_routable_bind_keeps_the_allowed_hosts_it_was_given() {
    let policy = resolve_listen("0.0.0.0", true, false, vec!["demo.example".into()])
        .unwrap()
        .policy;
    assert_eq!(
        policy,
        HostPolicy::Bound {
            bound: None,
            allowed: vec!["demo.example".to_string()]
        }
    );
}

#[test]
fn a_host_that_is_not_an_address_is_an_error_rather_than_every_interface() {
    assert!(resolve_listen("::1:9000", false, false, vec![]).is_err());
    assert!(resolve_listen("my-laptop", true, false, vec![]).is_err());
}

#[test]
fn allowed_hosts_ride_along_on_a_loopback_bind() {
    let listen =
        resolve_listen("127.0.0.1", false, false, vec!["tmux.example.com".into()]).unwrap();
    assert_eq!(listen.policy, loopback(vec!["tmux.example.com".into()]));
}

/// The app exactly as `serve` assembles it for the embedded frontend,
/// optionally behind the password layer.
fn served_app(password: Option<&str>) -> axum::Router {
    let app = crate::state::api_routes(loopback(vec![]))
        .fallback(serve_embedded)
        .with_state(Arc::new(AppState::new()));
    with_optional_auth(app, password.map(str::to_string), loopback(vec![]))
}

/// Every path a password is meant to cover — the API, the SSE stream and
/// the frontend itself. The layer wraps the whole router, so a route that
/// answered without credentials would be a hole in all three.
const AUTHED_TARGETS: &[&str] = &[
    "/events",
    "/commands",
    "/trace",
    "/api/images/1/0",
    "/",
    "/index.html",
];

fn probe(target: &str, auth: Option<&str>) -> axum::http::Request<axum::body::Body> {
    let mut request = axum::http::Request::get(target)
        .header("host", "localhost:9000")
        .body(axum::body::Body::empty())
        .unwrap();
    if let Some(value) = auth {
        request.headers_mut().insert(
            axum::http::header::AUTHORIZATION,
            axum::http::HeaderValue::from_str(value).unwrap(),
        );
    }
    // The auth layer rate-limits per peer address, so it extracts
    // `ConnectInfo` — which the server populates via
    // `into_make_service_with_connect_info` and a bare `oneshot` does not.
    // Without it every probe would 500 on a missing extension rather than
    // exercise the gate.
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            55555,
        ))));
    request
}

fn basic(user: &str, pass: &str) -> String {
    use base64::Engine as _;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
    )
}

#[tokio::test]
async fn with_a_password_every_route_challenges_an_anonymous_request() {
    use tower::ServiceExt;
    for target in AUTHED_TARGETS {
        let response = served_app(Some("s3cret"))
            .oneshot(probe(target, None))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{target} was served without credentials"
        );
        // Without the challenge the browser never prompts, and the app
        // looks broken rather than locked.
        assert!(response
            .headers()
            .get(axum::http::header::WWW_AUTHENTICATE)
            .is_some());
    }
}

#[tokio::test]
async fn a_wrong_password_is_refused_and_the_right_one_reaches_the_route() {
    use tower::ServiceExt;
    for target in AUTHED_TARGETS {
        let refused = served_app(Some("s3cret"))
            .oneshot(probe(target, Some(&basic("anyone", "wrong"))))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::UNAUTHORIZED, "{target}");

        // Any username is accepted — the browser prompt only has to carry
        // the shared password.
        let allowed = served_app(Some("s3cret"))
            .oneshot(probe(target, Some(&basic("whoever", "s3cret"))))
            .await
            .unwrap();
        assert_ne!(
            allowed.status(),
            StatusCode::UNAUTHORIZED,
            "{target} rejected the correct password"
        );
    }
}

/// A hostile page the user has open sends from the user's address. Its
/// anonymous requests are refused by origin before the password is looked at,
/// so they cannot spend the user's allowance and hold their next prompt.
#[tokio::test]
async fn cross_site_requests_are_refused_without_costing_the_user_their_allowance() {
    use tower::ServiceExt;
    let app = served_app(Some("s3cret"));
    for _ in 0..10 {
        let mut request = probe("/commands", None);
        let headers = request.headers_mut();
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        headers.insert("sec-fetch-mode", "no-cors".parse().unwrap());
        headers.insert("origin", "https://evil.example".parse().unwrap());
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let prompt = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        app.clone().oneshot(probe("/", None)),
    )
    .await
    .expect("the user's own prompt is not held back")
    .unwrap();
    assert_eq!(prompt.status(), StatusCode::UNAUTHORIZED);

    // Following a link to the server from another site still gets the prompt.
    let mut link = probe("/", None);
    let headers = link.headers_mut();
    headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
    headers.insert("sec-fetch-mode", "navigate".parse().unwrap());
    headers.insert("sec-fetch-dest", "document".parse().unwrap());
    let response = app.oneshot(link).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn with_no_password_the_layer_is_not_installed() {
    use tower::ServiceExt;
    let response = served_app(None)
        .oneshot(probe("/api/images/1/0", None))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
}

/// The value of one directive in a policy, `None` when it is absent.
fn directive<'a>(policy: &'a str, name: &str) -> Option<&'a str> {
    policy.split(';').map(str::trim).find_map(|d| {
        d.strip_prefix(name)
            .filter(|rest| rest.is_empty() || rest.starts_with(' '))
            .map(str::trim)
    })
}

/// What keeps a preview inside its frame and the app out of another site's.
/// A preview's page is served from this origin, so `'self'` is every frame
/// the app needs; anything else in `frame-src` is a host a page could carry
/// the files inlined into it to.
fn assert_framing_rules(policy: &str, what: &str) {
    assert_eq!(directive(policy, "frame-src"), Some("'self'"), "{what}");
    assert_eq!(
        directive(policy, "frame-ancestors"),
        Some("'none'"),
        "{what}"
    );
    assert_eq!(directive(policy, "object-src"), Some("'none'"), "{what}");
}

fn assert_app_headers(response: &axum::response::Response, csp: &str, what: &str) {
    let header = |name: axum::http::HeaderName| {
        response
            .headers()
            .get(&name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_else(|| panic!("{what} has no {name}"))
            .to_string()
    };
    assert_eq!(
        header(axum::http::header::CONTENT_SECURITY_POLICY),
        csp,
        "{what}"
    );
    assert_eq!(
        header(axum::http::header::X_FRAME_OPTIONS),
        "DENY",
        "{what}"
    );
    assert_eq!(
        header(axum::http::header::X_CONTENT_TYPE_OPTIONS),
        "nosniff",
        "{what}"
    );
}

#[test]
fn the_app_policy_frames_only_its_own_origin_and_runs_only_its_own_scripts() {
    assert_framing_rules(APP_CSP, "APP_CSP");
    assert_eq!(directive(APP_CSP, "default-src"), Some("'self'"));
    assert_eq!(directive(APP_CSP, "script-src"), Some("'self'"));
    assert_eq!(directive(APP_CSP, "connect-src"), Some("'self'"));
    // The dev policy gives up the script rules for Vite, never the framing.
    assert_framing_rules(DEV_CSP, "DEV_CSP");
}

/// Every file of the built app — the page, an SPA route, an asset, the
/// user's stylesheet, a miss — carries the policy, so no URL of the app can be
/// framed by another site or frame a page that left for another host.
#[tokio::test]
async fn every_file_of_the_app_is_served_under_its_policy() {
    use tower::ServiceExt;
    for target in [
        "/",
        "/index.html",
        "/a/route/only/the/app/knows",
        "/favicon.svg",
        "/themes/no-such-theme-for-this-test.css",
    ] {
        let response = served_app(None).oneshot(probe(target, None)).await.unwrap();
        assert_app_headers(&response, APP_CSP, target);
    }
}

#[tokio::test]
async fn the_dev_frontend_is_served_under_the_framing_rules() {
    let request = axum::http::Request::get("/themes/no-such-theme-for-this-test.css")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = serve_dev(request).await;
    assert_app_headers(&response, DEV_CSP, "dev");
}

/// The preview's page is the one thing the app frames: it keeps its own
/// sandboxing policy, and nothing forbids the app from framing it.
#[tokio::test]
async fn a_preview_page_keeps_its_own_policy_and_can_be_framed_by_the_app() {
    use tower::ServiceExt;
    let state = Arc::new(AppState::new());
    state
        .preview_pages
        .stage(
            tmuxy_core::PaneId::parse("%1").unwrap(),
            "<p>page</p>".to_string(),
            false,
        )
        .unwrap();
    let app = crate::state::api_routes(loopback(vec![]))
        .fallback(serve_embedded)
        .with_state(state);
    let response = app.oneshot(probe("/api/preview/1", None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let csp = response
        .headers()
        .get(axum::http::header::CONTENT_SECURITY_POLICY)
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(csp, tmuxy_core::preview::page_csp(false));
    assert!(response
        .headers()
        .get(axum::http::header::X_FRAME_OPTIONS)
        .is_none());
}
