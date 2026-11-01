use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;
use std::sync::Arc;
use tokio::signal;
use tracing::{error, warn};

use super::DEFAULT_PORT;
use crate::dev;
use crate::state::{build_response, AppState};

#[derive(Embed)]
#[folder = "../tmuxy-ui/dist/"]
struct FrontendAssets;

/// The user's stylesheets — `/themes/<name>.css` and `/custom.css` — from
/// the config dir, as `session::resolve_user_css` reads them (a built-in
/// theme name falls back to the bundled copy). `None` for any other path. Not
/// cached: a save is meant to show on the next fetch.
pub(super) fn serve_user_css(path: &str) -> Option<Response> {
    let path = path.trim_start_matches('/');
    if path != "custom.css" && !path.starts_with("themes/") {
        return None;
    }
    Some(match tmuxy_core::session::resolve_user_css(path) {
        Some(data) => {
            let mut response = build_response(StatusCode::OK, "text/css; charset=utf-8", data);
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

/// The policy the built app is served under. Everything the app loads comes
/// from its own origin: the bundle, its fonts, the user's stylesheets,
/// `/events`, `/commands` and `/api/images`. Remote images are
/// the one exception, for a markdown preview opened with `--net`. `frame-src`
/// is what keeps a preview's page inside its frame: the page is served from
/// `/api/preview/{pane}`, and the embedder's `frame-src` is checked on every
/// navigation of the frame, so a page that sets its own `location` to another
/// host is refused instead of carrying the files inlined into it there.
/// `frame-ancestors` stops another site from framing the app to steer its
/// clicks.
pub(super) const APP_CSP: &str = "default-src 'self'; script-src 'self'; \
     style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; \
     font-src 'self' data:; connect-src 'self'; frame-src 'self'; \
     frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

/// `--dev`: the framing rules of [`APP_CSP`] only. Vite's page carries an inline
/// script (React's refresh preamble) and its HMR socket goes straight to the
/// Vite port, neither of which the full policy allows.
pub(super) const DEV_CSP: &str =
    "frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/// Put the app's security headers on a response for one of its own files.
/// Not for `/api/preview/{pane}`, which is framed by the app and carries a
/// policy of its own.
pub(super) fn with_app_headers(mut response: Response, csp: &'static str) -> Response {
    use axum::http::{header, HeaderValue};
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(csp),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// Serve files from embedded frontend assets (SPA with index.html fallback),
/// under [`APP_CSP`].
pub(super) async fn serve_embedded(uri: axum::http::Uri) -> Response {
    with_app_headers(embedded_file(uri.path()), APP_CSP)
}

/// `--dev`: the app from Vite, under [`DEV_CSP`]. The user's stylesheets are
/// the server's to serve in dev mode too: Vite only knows the bundled copies
/// under `public/`.
pub(super) async fn serve_dev(req: axum::extract::Request) -> Response {
    let response = match serve_user_css(req.uri().path()) {
        Some(response) => response,
        None => dev::proxy_to_vite(req).await,
    };
    with_app_headers(response, DEV_CSP)
}

fn embedded_file(path: &str) -> Response {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // Response::builder().body() returns Err only for invalid header values, which
    // none of these literal mime types can produce — fall back to a 500 on the
    // off-chance the embedded asset's mime string somehow becomes invalid.
    if let Some(response) = serve_user_css(path) {
        response
    } else if let Some(file) = FrontendAssets::get(path) {
        let mime = tmuxy_core::mime::content_type_for_path(path);
        build_response(StatusCode::OK, mime, file.data.into_owned())
    } else if let Some(index) = FrontendAssets::get("index.html") {
        // SPA fallback
        build_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            index.data.into_owned(),
        )
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

// ============================================
// PID file management
// ============================================

/// One pid file per port, so a second server beside the first neither
/// overwrites its pid nor gets stopped in its place. In the state dir, with
/// the rest of this machine's runtime files; the default port keeps the
/// historical name.
pub(super) fn pid_file_path(port: u16) -> std::path::PathBuf {
    pid_file_in(&tmuxy_core::paths::state_dir(), port)
}

/// Where a build before the state dir held its pid files, `~/.tmuxy`. Read so
/// `stop` and `status` still find a server that build started; never written.
fn legacy_pid_file_path(port: u16) -> Option<std::path::PathBuf> {
    Some(pid_file_in(
        &tmuxy_core::paths::resolved_home_dir().join(".tmuxy"),
        port,
    ))
}

fn pid_file_in(dir: &std::path::Path, port: u16) -> std::path::PathBuf {
    if port == DEFAULT_PORT {
        dir.join("tmuxy.pid")
    } else {
        dir.join(format!("tmuxy-{port}.pid"))
    }
}

pub(super) fn write_pid_file(port: u16) {
    let pid = std::process::id();
    let path = pid_file_path(port);
    if let Some(dir) = path.parent() {
        let _ = tmuxy_core::private_files::create_dir_all(dir);
    }
    let _ = tmuxy_core::private_files::write(&path, pid.to_string());
}

/// Remove the port's pid file if it still names `pid`.
///
/// The file outlives the process that wrote it by a moment: a server told to
/// stop removes it on its way out, by which time a replacement on the same
/// port may already have written its own. Removing unconditionally deleted
/// the new server's file, and `stop` then reported a running server as gone.
pub(super) fn remove_pid_file(port: u16, pid: u32) {
    remove_pid_file_at(&pid_file_path(port), pid);
    if let Some(legacy) = legacy_pid_file_path(port) {
        remove_pid_file_at(&legacy, pid);
    }
}

pub(super) fn remove_pid_file_at(path: &std::path::Path, pid: u32) {
    let names_pid = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        == Some(pid);
    if names_pid {
        std::fs::remove_file(path).ok();
    }
}

/// The pid the port's pid file names: the state dir's, else the one an older
/// build wrote under `~/.tmuxy`.
fn read_pid_file(port: u16) -> Option<u32> {
    std::iter::once(pid_file_path(port))
        .chain(legacy_pid_file_path(port))
        .find_map(|path| {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|s| parse_pid(&s))
        })
}

/// The pid a pid file names, if it names one other process. To kill(2), `0`
/// is the caller's own process group and a negative `pid_t` (what `u32::MAX`
/// becomes) is every process the user owns; `1` is init.
fn parse_pid(text: &str) -> Option<u32> {
    text.trim()
        .parse::<i32>()
        .ok()
        .filter(|&pid| pid > 1)
        .and_then(|pid| u32::try_from(pid).ok())
}

/// `pid` as kill(2) takes it, for a pid `parse_pid` accepted.
#[cfg(unix)]
fn signal_target(pid: u32) -> Option<nix::unistd::Pid> {
    i32::try_from(pid)
        .ok()
        .filter(|&pid| pid > 1)
        .map(nix::unistd::Pid::from_raw)
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    signal_target(pid).is_some_and(|pid| nix::sys::signal::kill(pid, None).is_ok())
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    false
}

fn matches_tmuxy_command(text: &str) -> bool {
    text.to_ascii_lowercase().contains("tmuxy")
}

#[cfg(target_os = "linux")]
fn is_tmuxy_process(pid: u32) -> bool {
    let comm_matches = std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|s| matches_tmuxy_command(&s))
        .unwrap_or(false);
    if comm_matches {
        return true;
    }
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| {
            let text = String::from_utf8_lossy(&bytes);
            matches_tmuxy_command(&text)
        })
        .unwrap_or(false)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_tmuxy_process(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .is_some_and(|out| matches_tmuxy_command(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(unix))]
fn is_tmuxy_process(_pid: u32) -> bool {
    false
}

pub(super) fn stop_server(port: u16) {
    match read_pid_file(port) {
        Some(pid) => {
            if !is_process_alive(pid) || !is_tmuxy_process(pid) {
                println!("Server is not running (stale PID file for pid {})", pid);
                remove_pid_file(port, pid);
                return;
            }

            #[cfg(unix)]
            {
                use nix::sys::signal::{self, Signal};
                let Some(target) = signal_target(pid) else {
                    error!(pid, "refusing to signal a pid that is not one process");
                    return;
                };
                match signal::kill(target, Signal::SIGTERM) {
                    Ok(_) => {
                        println!("Sent SIGTERM to server (pid {})", pid);
                        remove_pid_file(port, pid);
                    }
                    Err(e) => error!(pid, error = %e, "failed to stop server"),
                }
            }

            #[cfg(not(unix))]
            error!("Stop not supported on this platform");
        }
        None => println!("Server is not running (no PID file found)"),
    }
}

pub(super) fn server_status(port: u16) {
    match read_pid_file(port) {
        Some(pid) => {
            if is_process_alive(pid) && is_tmuxy_process(pid) {
                println!("Server is running (pid {})", pid);
            } else {
                println!("Server is not running (stale PID file for pid {})", pid);
                remove_pid_file(port, pid);
            }
        }
        None => println!("Server is not running"),
    }
}

/// How many seconds a server waits for its port to come free. A server told
/// to stop keeps the port until its shutdown is done, which can take a final
/// snapshot per session and a bounded drain (`FINAL_SNAPSHOT_TIMEOUT`,
/// `SHUTDOWN_DRAIN_TIMEOUT`); an upgrade starts the new server straight after
/// the `stop`, so the wait has to outlast the old one's slowest exit.
pub(super) const BIND_RETRIES: u32 = 15;

/// Bind to addr, retrying up to `max_retries` times with 1s delay if port is in use.
pub(super) async fn bind_with_retry(
    addr: std::net::SocketAddr,
    max_retries: u32,
) -> tokio::net::TcpListener {
    for attempt in 0..=max_retries {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => return listener,
            Err(e) if attempt < max_retries => {
                warn!(
                    port = addr.port(),
                    attempt = attempt + 1,
                    max_retries,
                    error = %e,
                    "port in use, retrying in 1s"
                );
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(e) => {
                panic!("Failed to bind to {}: {}", addr, e);
            }
        }
    }
    unreachable!()
}

/// How long shutdown waits for tracked tasks to finish before giving up.
const SHUTDOWN_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long the final snapshot of a session may hold up shutdown.
const FINAL_SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

pub(super) async fn shutdown_signal(state: Arc<AppState>, vite: Option<dev::ViteChild>) {
    // Signal handler installation only fails on platforms without sigaction (none we
    // target) or when the process has already taken too many file descriptors —
    // either way, a server that can't react to Ctrl+C is unusable, so panic is
    // the right call.
    #[allow(clippy::expect_used)]
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    #[allow(clippy::expect_used)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    println!("\nShutting down...");

    // The last snapshot of every session, before anything is torn down: a
    // graceful shutdown is the common way a machine goes down, and the
    // autosave's debounce may be holding the final change.
    if !tmuxy_core::session_snapshot::autosave_disabled() {
        let dir = tmuxy_core::session_snapshot::default_dir();
        let targets: Vec<(String, tmuxy_core::control_mode::MonitorCommandSender)> = {
            let sessions = state.sessions.read().await;
            sessions
                .iter()
                // A session still being rebuilt is half of what its snapshot
                // says; the snapshot it is being rebuilt FROM is the one to keep.
                .filter(|(_, conns)| {
                    !conns
                        .snapshot_keeper
                        .as_ref()
                        .is_some_and(|keeper| keeper.restoring())
                })
                .filter_map(|(name, conns)| {
                    conns
                        .monitor_command_tx
                        .clone()
                        .map(|tx| (name.clone(), tx))
                })
                .collect()
        };
        for (name, tx) in targets {
            let _ = tokio::time::timeout(
                FINAL_SNAPSHOT_TIMEOUT,
                tmuxy_core::session_snapshot::save_now(&name, &dir, &tx),
            )
            .await;
        }
    }

    // Structured shutdown: broadcast cancellation, then drain every tracked
    // background task. Tasks already check `state.shutdown.cancelled()` in
    // their select branches so the cancel fires the actual exit; the drain
    // here is just a join-to-completion safety net.
    state.shutdown.cancel();
    let mut join_set = state.join_set.lock().await;
    let mut drained = 0usize;
    // Bounded: a task that misses the cancellation must not keep the process
    // alive. Whatever is left is abandoned when the runtime goes down.
    let drain = async {
        while let Some(res) = join_set.join_next().await {
            if let Err(e) = res {
                tracing::warn!(error = %e, "joined task exited with error");
            }
            drained += 1;
        }
    };
    if tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, drain)
        .await
        .is_err()
    {
        tracing::warn!(tasks = drained, "shutdown drain timed out; exiting anyway");
    } else {
        tracing::info!(tasks = drained, "structured shutdown complete");
    }

    if let Some(vite) = vite {
        vite.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::{is_tmuxy_process, matches_tmuxy_command, parse_pid};

    #[test]
    fn a_pid_file_naming_no_single_process_is_ignored() {
        assert_eq!(parse_pid("4242\n"), Some(4242));
        for broadcast in ["0", "1", "-1", "4294967295", "2147483648", "", "abc"] {
            assert_eq!(parse_pid(broadcast), None, "{broadcast:?}");
        }
    }

    #[test]
    fn process_identity_guard_recognizes_tmuxy_and_rejects_unrelated_processes() {
        assert!(matches_tmuxy_command("tmuxy-server\n"));
        assert!(matches_tmuxy_command("/usr/local/bin/tmuxy\0--port\09000"));
        assert!(!matches_tmuxy_command("systemd\n"));
        assert!(!matches_tmuxy_command("postgres\n"));
        // The cargo test binary itself (`tmuxy_server-*`) matches, whereas init (PID 1) does not.
        assert!(is_tmuxy_process(std::process::id()));
        assert!(!is_tmuxy_process(1));
    }
}
