use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clap::{Args, Subcommand};
use rust_embed::Embed;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use tokio::signal;
use tracing::{error, warn};

use crate::dev;
use crate::request_guard::HostPolicy;
use crate::state::{build_response, AppState};

#[derive(Embed)]
#[folder = "../tmuxy-ui/dist/"]
struct FrontendAssets;

#[derive(Args)]
pub struct ServerArgs {
    #[command(subcommand)]
    pub action: Option<ServerAction>,

    /// Port to listen on
    #[arg(long, default_value_t = DEFAULT_PORT)]
    pub port: u16,

    /// Address to listen on. The default is reachable from this machine only
    /// (and through an SSH tunnel). Any other address needs --password, or
    /// --no-auth to serve it open.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// Require HTTP Basic auth with this password (any username is accepted).
    /// Falls back to the TMUXY_PASSWORD env var. Prefer TMUXY_PASSWORD to keep
    /// the secret out of `ps`.
    #[arg(long)]
    pub password: Option<String>,

    /// Serve a non-loopback --host with no password. Anyone who can reach the
    /// port gets a shell as you, so only on a network where that is already
    /// true of everyone on it (a container's published port, a private VPN).
    #[arg(long)]
    pub no_auth: bool,

    /// A hostname requests may be addressed to besides loopback ones — the
    /// public name of a reverse proxy that forwards its `Host`. Repeatable;
    /// also read from TMUXY_ALLOWED_HOSTS (comma-separated).
    #[arg(long = "allowed-host", value_name = "HOST")]
    pub allowed_hosts: Vec<String>,

    /// Serve viewers only: clients receive the state stream and navigate it
    /// locally, but every mutating command is refused and no client can
    /// resize the session. Also read from TMUXY_READ_ONLY.
    #[arg(long)]
    pub read_only: bool,

    /// The session a `--read-only` server shows, and the only one it will
    /// show — a viewer naming another gets a 404 rather than that session's
    /// screen. Defaults to `tmuxy`. Ignored without `--read-only`, where
    /// switching sessions is the feature. Also read from TMUXY_SESSION.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,

    /// Run in development mode (proxy to Vite dev server)
    #[arg(long)]
    pub dev: bool,

    /// Enable local action tracing to an NDJSON file (see docs/TELEMETRY.md).
    /// Pass a path to choose the file, or bare `--trace` for the default under
    /// the state dir. Off by default on release builds; the trace never leaves
    /// this machine. `DO_NOT_TRACK=1` or `TMUXY_NO_TRACE=1` force it off.
    #[arg(long, value_name = "PATH", num_args = 0..=1)]
    pub trace: Option<Option<String>>,
}

/// Resolve the auth password: `--password` wins, else the `TMUXY_PASSWORD` env
/// var; an empty value counts as unset (no auth).
fn resolve_password(flag: Option<String>) -> Option<String> {
    flag.or_else(|| std::env::var("TMUXY_PASSWORD").ok())
        .filter(|s| !s.is_empty())
}

/// The port `tmuxy server` listens on unless told otherwise.
const DEFAULT_PORT: u16 = 9000;

/// A boolean env switch: set to anything but an empty string or `0`.
fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0")
}

/// Wrap the router in the Basic-auth layer when a password is configured.
/// With no password the router is returned unchanged (server stays open).
fn with_optional_auth(app: axum::Router, password: Option<String>) -> axum::Router {
    match password {
        Some(pw) => app.layer(axum::middleware::from_fn_with_state(
            std::sync::Arc::new(crate::auth::AuthState {
                password: pw,
                throttle: crate::auth::AuthThrottle::new(),
            }),
            crate::auth::require_basic_auth,
        )),
        None => app,
    }
}

/// Where the server listens, and which `Host` names its API answers.
#[derive(Debug, PartialEq, Eq)]
struct Listen {
    ip: IpAddr,
    policy: HostPolicy,
}

/// Resolve `--host` against the auth settings. A loopback address is served as
/// it is. Any other address puts a shell on the network, so it needs a
/// password — or `--no-auth`, saying out loud that the network is trusted.
/// See docs/SECURITY.md.
fn resolve_listen(
    host: &str,
    password_set: bool,
    no_auth: bool,
    allowed_hosts: Vec<String>,
) -> Result<Listen, String> {
    let ip: IpAddr = if host.eq_ignore_ascii_case("localhost") {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .parse()
            .map_err(|_| {
                format!("--host {host} is not an IP address (try 127.0.0.1, ::1 or 0.0.0.0)")
            })?
    };
    if ip.is_loopback() {
        return Ok(Listen {
            ip,
            policy: HostPolicy::Loopback {
                allowed: allowed_hosts,
            },
        });
    }
    if !password_set && !no_auth {
        return Err(format!(
            "refusing to listen on {ip} with no password: anyone who can reach it would get a shell as you.\n\
             Set TMUXY_PASSWORD (or --password), listen on --host 127.0.0.1, or pass --no-auth on a network you trust."
        ));
    }
    // SEC-10/SEC-15: a routable bind keeps the allowed list and still checks
    // `Host` against it. It used to be discarded here, so `--allowed-host` (and
    // `TMUXY_ALLOWED_HOSTS`, which the public demo builds it from) silently did
    // nothing, and a routable `--no-auth` bind was one DNS rebind from a shell.
    // `bound` is None for a wildcard, where the server cannot know its address.
    let bound = (!ip.is_unspecified()).then_some(ip);
    Ok(Listen {
        ip,
        policy: HostPolicy::Bound {
            bound,
            allowed: allowed_hosts,
        },
    })
}

/// `--allowed-host` values plus the comma-separated `TMUXY_ALLOWED_HOSTS`.
/// The session a server is pinned to, if any.
///
/// Only a `--read-only` server is pinned: it is the one whose client cannot
/// already run `new-session` for itself, and the one that may share a socket
/// with a writer whose other sessions are none of a viewer's business. A
/// writable server stays unpinned so session switching keeps working.
fn resolve_session_pin(flag: Option<String>, read_only: bool) -> Option<String> {
    if !read_only {
        return None;
    }
    let name = flag
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        // The same resolution the rest of tmuxy uses: `TMUXY_SESSION`, else
        // the default name.
        .unwrap_or_else(tmuxy_core::session::session_name);
    Some(name)
}

fn resolve_allowed_hosts(flag: Vec<String>) -> Vec<String> {
    let env = std::env::var("TMUXY_ALLOWED_HOSTS").unwrap_or_default();
    flag.into_iter()
        .chain(
            env.split(',')
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .map(String::from),
        )
        .collect()
}

/// Stop before serving anything when there is no usable tmux: every client
/// would otherwise sit reconnecting to a monitor that can never attach.
fn require_tmux() {
    match tmuxy_core::tmux_check::check_tmux() {
        Ok(version) => tracing::info!(%version, "tmux found"),
        Err(e) => {
            eprintln!("tmuxy server: {e}");
            std::process::exit(1);
        }
    }
}

/// Print the auth status, and warn loudly about a routable address served with
/// `--no-auth` — matching the threat model in docs/SECURITY.md.
fn announce_security(listen: &Listen, password_set: bool) {
    if password_set {
        println!(
            "tmuxy server: HTTP Basic auth enabled (any username; use the configured password)"
        );
    } else if matches!(listen.policy, HostPolicy::Bound { .. }) {
        eprintln!(
            "warning: --no-auth on {} — anyone who can reach this port has full shell access.",
            listen.ip
        );
    }
}

#[derive(Subcommand)]
pub enum ServerAction {
    /// Stop the running server
    Stop,
    /// Show server status
    Status,
    /// Run the sidebar tree TUI (backs `tmuxy tree`). Hidden: meant to run
    /// inside a tmux pane, not invoked directly by users.
    #[command(hide = true)]
    Tree,
    /// Run the add-a-server form TUI (backs `tmuxy connect` with no args).
    /// Hidden: meant to run inside a tmux float, not invoked directly.
    #[command(hide = true)]
    Connect,
    /// Inspect a local action-trace file: print a summary, or export a
    /// Chrome-trace/Perfetto timeline with `--export` (docs/TELEMETRY.md).
    Trace(crate::trace_view::TraceViewArgs),
}

/// Activate action tracing per the gating rules and announce it loudly, so it
/// is never a surprise (docs/TELEMETRY.md). Only called on the actual
/// server-start paths — never for stop/status/tree/connect.
fn announce_trace(trace: Option<Option<String>>, dev_mode: bool) {
    if let Some(path) = tmuxy_core::trace::init(trace, dev_mode) {
        println!(
            "tmuxy: action tracing ON [level={}] → {} (local only, never uploaded; \
             TMUXY_TRACE_LEVEL=shape|labeled|full; DO_NOT_TRACK=1 or TMUXY_NO_TRACE=1 to disable)",
            tmuxy_core::trace::level_name(),
            path.display()
        );
    }
}

pub async fn run(args: ServerArgs) {
    let dev_mode = args.dev || std::env::var("TMUXY_DEV").is_ok();
    let password = resolve_password(args.password.clone());
    match args.action {
        None => {
            let allowed_hosts = resolve_allowed_hosts(args.allowed_hosts);
            let listen =
                match resolve_listen(&args.host, password.is_some(), args.no_auth, allowed_hosts) {
                    Ok(listen) => listen,
                    Err(message) => {
                        eprintln!("tmuxy server: {message}");
                        std::process::exit(2);
                    }
                };
            require_tmux();
            announce_trace(args.trace.clone(), dev_mode);
            let read_only = args.read_only || env_flag("TMUXY_READ_ONLY");
            let session_pin = resolve_session_pin(args.session.clone(), read_only);
            if dev_mode {
                start_dev_server(args.port, listen, password, read_only, session_pin).await
            } else {
                start_server(args.port, listen, password, read_only, session_pin).await
            }
        }
        Some(ServerAction::Stop) => stop_server(args.port),
        Some(ServerAction::Status) => server_status(args.port),
        Some(ServerAction::Tree) => {
            if let Err(e) = crate::tree::run_tree_tui() {
                eprintln!("tmuxy tree: {e}");
                std::process::exit(1);
            }
        }
        Some(ServerAction::Connect) => match crate::connect::run_connect_tui() {
            Ok(Some(id)) => println!("{id}"),
            Ok(None) => {}
            Err(e) => {
                eprintln!("tmuxy connect: {e}");
                std::process::exit(1);
            }
        },
        Some(ServerAction::Trace(view_args)) => crate::trace_view::run(view_args),
    }
}

/// Start the development server with Vite and demo proxies
async fn start_dev_server(
    requested_port: u16,
    listen: Listen,
    password: Option<String>,
    read_only: bool,
    session_pin: Option<String>,
) {
    // Honor PORT env (legacy) when present, otherwise fall back to the CLI arg.
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(requested_port);

    // Vite (strictPort: true, port 9001) and the demo dev server (port 9002)
    // bind to hard-coded ports. If tmuxy-server is told to bind one of those,
    // it wins the race; Vite fails silently, and the `/proxy_to_vite` fallback
    // then loops back to tmuxy-server itself — browser EventSources 404 on
    // /events while `curl` (different headers/timing) appears to work. Bail
    // early with an actionable message instead of letting that happen.
    if port == dev::VITE_PORT || port == dev::DEMO_PORT {
        let role = if port == dev::VITE_PORT {
            "Vite"
        } else {
            "demo"
        };
        error!(
            port,
            %role,
            "FATAL: port collides with the hard-coded dev server port"
        );
        error!(
            vite_port = dev::VITE_PORT,
            demo_port = dev::DEMO_PORT,
            "choose a different port (e.g. --port 9000 or PORT=9000) and restart"
        );
        std::process::exit(1);
    }

    tmuxy_core::session::ensure_config();
    tmuxy_core::session::ensure_themes();
    // Materialize bundled CLI dispatcher and helper scripts so the in-config
    // `command-alias` entries (Ctrl+hjkl nav, pane groups, etc.) and the
    // direct "Add Pane to Group" menu commands resolve at the absolute
    // `$HOME/.config/tmuxy/bin/tmuxy/…` path. Mirrors gui.rs setup().
    tmuxy_core::session::ensure_bin_scripts();
    let state = Arc::new(
        AppState::new()
            .with_read_only(read_only)
            .with_session_pin(session_pin.clone()),
    );

    println!(
        "[dev] Starting Vite dev server on port {}...",
        dev::VITE_PORT
    );
    let vite_child = dev::spawn_dev_server("vite", "tmuxy-ui", &[]).await;

    println!(
        "[dev] Starting demo dev server on port {}...",
        dev::DEMO_PORT
    );
    let demo_child = dev::spawn_dev_server(
        "demo",
        "tmuxy-demo",
        &["--", "--port", "9002", "--hostname", "0.0.0.0"],
    )
    .await;

    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    let app = crate::state::api_routes(listen.policy.clone())
        .route(
            "/demo",
            axum::routing::any(|req: Request| async move { dev::proxy_to_demo(req).await }),
        )
        .route(
            "/demo/{*path}",
            axum::routing::any(|req: Request| async move { dev::proxy_to_demo(req).await }),
        )
        .fallback_service(tower::service_fn(|req: Request| async move {
            Ok::<_, std::convert::Infallible>(dev::proxy_to_vite(req).await)
        }))
        .with_state(state.clone());
    let password_set = password.is_some();
    let app = with_optional_auth(app, password);

    let addr = std::net::SocketAddr::new(listen.ip, port);
    println!("tmuxy dev server running at http://{addr}");
    announce_security(&listen, password_set);
    println!(
        "[dev] Vite proxied from port {}, demo proxied from port {}",
        dev::VITE_PORT,
        dev::DEMO_PORT
    );

    let listener = bind_with_retry(addr, 5).await;

    // `into_make_service_with_connect_info` rather than the plain router: the
    // auth layer reads the peer address to rate-limit failed passwords per
    // source, and `ConnectInfo` is only populated by this make-service.
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(state, vec![vite_child, demo_child]))
    .await
    {
        error!(error = %e, "axum serve loop exited with error");
    }
}

/// Start the production server with embedded frontend assets
async fn start_server(
    port: u16,
    listen: Listen,
    password: Option<String>,
    read_only: bool,
    session_pin: Option<String>,
) {
    write_pid_file(port);
    tmuxy_core::session::ensure_config();
    tmuxy_core::session::ensure_themes();
    tmuxy_core::session::ensure_bin_scripts();

    let state = Arc::new(
        AppState::new()
            .with_read_only(read_only)
            .with_session_pin(session_pin.clone()),
    );

    let app = crate::state::api_routes(listen.policy.clone())
        .fallback(serve_embedded)
        .with_state(state.clone());
    let password_set = password.is_some();
    let app = with_optional_auth(app, password);

    let addr = std::net::SocketAddr::new(listen.ip, port);

    println!("tmuxy server running at http://{addr}");
    announce_security(&listen, password_set);
    if read_only {
        println!("tmuxy server: read-only — clients can watch the session, not change it");
        if let Some(session) = &session_pin {
            println!("tmuxy server: pinned to session {session} — no other one is served");
        }
    }

    let listener = bind_with_retry(addr, 5).await;

    // `into_make_service_with_connect_info` rather than the plain router: the
    // auth layer reads the peer address to rate-limit failed passwords per
    // source, and `ConnectInfo` is only populated by this make-service.
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(state, vec![]))
    .await
    {
        error!(error = %e, "axum serve loop exited with error");
    }

    remove_pid_file(port, std::process::id());
}

/// Serve files from embedded frontend assets (SPA with index.html fallback)
async fn serve_embedded(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // Response::builder().body() returns Err only for invalid header values, which
    // none of these literal mime types can produce — fall back to a 500 on the
    // off-chance the embedded asset's mime string somehow becomes invalid.
    if let Some(file) = FrontendAssets::get(path) {
        let mime = mime_for_path(path);
        build_response(StatusCode::OK, mime, file.data.into_owned())
    } else if path.starts_with("themes/") && path.ends_with(".css") {
        // Custom theme CSS not in the embedded bundle — try ~/.config/tmuxy/themes/.
        // Canonicalize and confirm the resolved path stays under the themes dir:
        // axum doesn't normalize `..`, so `themes/../../../etc/foo.css` would
        // otherwise escape config_dir() and read any .css file on disk.
        let themes_dir = tmuxy_core::session::config_dir().join("themes");
        let served = themes_dir.canonicalize().ok().and_then(|canon_themes| {
            tmuxy_core::session::config_dir()
                .join(path)
                .canonicalize()
                .ok()
                .filter(|p| p.starts_with(&canon_themes))
                .and_then(|p| std::fs::read(&p).ok())
        });
        match served {
            Some(data) => build_response(StatusCode::OK, "text/css; charset=utf-8", data),
            None => StatusCode::NOT_FOUND.into_response(),
        }
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

fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

// ============================================
// PID file management
// ============================================

/// One pid file per port, so a second server beside the first (a `--read-only`
/// one for viewers, say) neither overwrites its pid nor gets stopped in its
/// place. The default port keeps the historical name.
fn pid_file_path(port: u16) -> std::path::PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".tmuxy");
    std::fs::create_dir_all(&dir).ok();
    if port == DEFAULT_PORT {
        dir.join("tmuxy.pid")
    } else {
        dir.join(format!("tmuxy-{port}.pid"))
    }
}

fn write_pid_file(port: u16) {
    let pid = std::process::id();
    std::fs::write(pid_file_path(port), pid.to_string()).ok();
}

/// Remove the port's pid file if it still names `pid`.
///
/// The file outlives the process that wrote it by a moment: a server told to
/// stop removes it on its way out, by which time a replacement on the same
/// port may already have written its own. Removing unconditionally deleted
/// the new server's file, and `stop` then reported a running server as gone.
fn remove_pid_file(port: u16, pid: u32) {
    remove_pid_file_at(&pid_file_path(port), pid);
}

fn remove_pid_file_at(path: &std::path::Path, pid: u32) {
    let names_pid = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        == Some(pid);
    if names_pid {
        std::fs::remove_file(path).ok();
    }
}

fn read_pid_file(port: u16) -> Option<u32> {
    std::fs::read_to_string(pid_file_path(port))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    false
}

fn stop_server(port: u16) {
    match read_pid_file(port) {
        Some(pid) => {
            if !is_process_alive(pid) {
                println!("Server is not running (stale PID file for pid {})", pid);
                remove_pid_file(port, pid);
                return;
            }

            #[cfg(unix)]
            {
                use nix::sys::signal::{self, Signal};
                use nix::unistd::Pid;
                match signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM) {
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

fn server_status(port: u16) {
    match read_pid_file(port) {
        Some(pid) => {
            if is_process_alive(pid) {
                println!("Server is running (pid {})", pid);
            } else {
                println!("Server is not running (stale PID file for pid {})", pid);
                remove_pid_file(port, pid);
            }
        }
        None => println!("Server is not running"),
    }
}

/// Bind to addr, retrying up to `max_retries` times with 1s delay if port is in use.
async fn bind_with_retry(addr: std::net::SocketAddr, max_retries: u32) -> tokio::net::TcpListener {
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

async fn shutdown_signal(state: Arc<AppState>, children: Vec<Option<dev::ViteChild>>) {
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

    for child in children.into_iter().flatten() {
        child.kill();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// A scratch pid-file path unique to this test, cleaned up on drop.
    struct PidFile(std::path::PathBuf);

    impl PidFile {
        fn new(tag: &str) -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("tmuxy-pidfile-{}-{tag}.pid", std::process::id())),
            )
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

    /// Two servers on two ports must not share a pid file, or stopping the
    /// second stops the first.
    #[test]
    fn each_port_owns_its_own_pid_file() {
        let default = pid_file_path(DEFAULT_PORT);
        let other = pid_file_path(DEFAULT_PORT + 1);
        assert_ne!(default, other);
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
            Some("shared".to_string())
        );
        assert_eq!(
            resolve_session_pin(None, true),
            Some(tmuxy_core::DEFAULT_SESSION_NAME.to_string())
        );
        assert_eq!(resolve_session_pin(Some("shared".into()), false), None);
        assert_eq!(resolve_session_pin(None, false), None);
    }

    #[test]
    fn a_blank_session_flag_falls_back_to_the_default_name() {
        assert_eq!(
            resolve_session_pin(Some("   ".into()), true),
            Some(tmuxy_core::DEFAULT_SESSION_NAME.to_string())
        );
    }

    #[test]
    fn allowed_hosts_ride_along_on_a_loopback_bind() {
        let listen =
            resolve_listen("127.0.0.1", false, false, vec!["tmux.example.com".into()]).unwrap();
        assert_eq!(listen.policy, loopback(vec!["tmux.example.com".into()]));
    }

    /// The app exactly as `start_server` assembles it, optionally behind the
    /// password layer.
    fn served_app(password: Option<&str>) -> axum::Router {
        let app = crate::state::api_routes(loopback(vec![]))
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
        "/api/file?path=/etc/hosts",
        "/api/browse/etc/hosts",
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
            .oneshot(probe("/api/file?path=/etc/hosts", None))
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
