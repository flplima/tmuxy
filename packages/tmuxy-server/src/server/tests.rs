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
    // A wildcard bind knows no address of its own, so there is nothing to
    // compare a `Host` against beyond an allowed list.
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
/// `--allowed-host` (and `TMUXY_ALLOWED_HOSTS`, which the public demo
/// builds it from) silently did nothing on the routable bind that actually
/// needed it — while `deploy/public-demo/README.md` said every other call
/// would answer 403.
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

/// SEC-11/12: a viewer's server shows the session it was started for and
/// refuses the rest. A writable one stays unpinned — its client can run
/// `new-session` itself, and switching sessions is the feature.
#[test]
fn only_a_read_only_server_is_pinned_to_one_session() {
    assert_eq!(
        resolve_session_pin(Some("shared".into()), true),
        Ok(Some("shared".to_string()))
    );
    assert_eq!(
        resolve_session_pin(None, true),
        Ok(Some(tmuxy_core::DEFAULT_SESSION_NAME.to_string()))
    );
    assert_eq!(resolve_session_pin(Some("shared".into()), false), Ok(None));
    assert_eq!(resolve_session_pin(None, false), Ok(None));
    // A pin no `?session=` could ever match is refused up front.
    assert!(resolve_session_pin(Some("shared session".into()), true).is_err());
}

#[test]
fn a_blank_session_flag_falls_back_to_the_default_name() {
    assert_eq!(
        resolve_session_pin(Some("   ".into()), true),
        Ok(Some(tmuxy_core::DEFAULT_SESSION_NAME.to_string()))
    );
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
    let app = crate::state::api_routes(loopback(vec![]), false)
        .fallback(serve_embedded)
        .with_state(Arc::new(AppState::new()));
    with_optional_auth(app, password.map(str::to_string))
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

#[tokio::test]
async fn with_no_password_the_layer_is_not_installed() {
    use tower::ServiceExt;
    let response = served_app(None)
        .oneshot(probe("/api/images/1/0", None))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
}
