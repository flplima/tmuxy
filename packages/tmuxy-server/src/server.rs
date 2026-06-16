use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clap::{Args, Subcommand};
use rust_embed::Embed;
use std::sync::Arc;
use tokio::signal;
use tracing::{error, warn};

use crate::dev;
use crate::state::AppState;

#[derive(Embed)]
#[folder = "../tmuxy-ui/dist/"]
struct FrontendAssets;

#[derive(Args)]
pub struct ServerArgs {
    #[command(subcommand)]
    pub action: Option<ServerAction>,

    /// Port to listen on
    #[arg(long, default_value = "9000")]
    pub port: u16,

    /// Host to bind to
    #[arg(long, default_value = "0.0.0.0")]
    pub host: String,

    /// Run in development mode (proxy to Vite dev server)
    #[arg(long)]
    pub dev: bool,
}

#[derive(Subcommand)]
pub enum ServerAction {
    /// Stop the running server
    Stop,
    /// Show server status
    Status,
}

pub async fn run(args: ServerArgs) {
    let dev_mode = args.dev || std::env::var("TMUXY_DEV").is_ok();
    match args.action {
        None if dev_mode => start_dev_server(args.port).await,
        None => start_server(args.port, args.host).await,
        Some(ServerAction::Stop) => stop_server(),
        Some(ServerAction::Status) => server_status(),
    }
}

/// Start the development server with Vite and demo proxies
async fn start_dev_server(requested_port: u16) {
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
    let state = Arc::new(AppState::new());

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

    let app = crate::state::api_routes()
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

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    println!("tmuxy dev server running at http://localhost:{}", port);
    println!(
        "[dev] Vite proxied from port {}, demo proxied from port {}",
        dev::VITE_PORT,
        dev::DEMO_PORT
    );

    let listener = bind_with_retry(addr, 5).await;

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state, vec![vite_child, demo_child]))
        .await
    {
        error!(error = %e, "axum serve loop exited with error");
    }
}

/// Start the production server with embedded frontend assets
async fn start_server(port: u16, host: String) {
    write_pid_file();
    tmuxy_core::session::ensure_config();
    tmuxy_core::session::ensure_themes();
    tmuxy_core::session::ensure_bin_scripts();

    let state = Arc::new(AppState::new());

    let app = crate::state::api_routes()
        .fallback(serve_embedded)
        .with_state(state.clone());

    let addr: std::net::SocketAddr = format!("{}:{}", host, port)
        .parse()
        .unwrap_or_else(|_| std::net::SocketAddr::from(([0, 0, 0, 0], port)));

    println!("tmuxy server running at http://{}:{}", host, port);

    let listener = bind_with_retry(addr, 5).await;

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state, vec![]))
        .await
    {
        error!(error = %e, "axum serve loop exited with error");
    }

    remove_pid_file();
}

/// Serve files from embedded frontend assets (SPA with index.html fallback)
async fn serve_embedded(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // Response::builder().body() returns Err only for invalid header values, which
    // none of these literal mime types can produce — fall back to a 500 on the
    // off-chance the embedded asset's mime string somehow becomes invalid.
    let build_response = |status: StatusCode, mime: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .body(Body::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    };

    if let Some(file) = FrontendAssets::get(path) {
        let mime = mime_for_path(path);
        build_response(StatusCode::OK, mime, file.data.into_owned())
    } else if path.starts_with("themes/") && path.ends_with(".css") {
        // Custom theme CSS not in the embedded bundle — try ~/.config/tmuxy/themes/
        let theme_path = tmuxy_core::session::config_dir().join(path);
        match std::fs::read(&theme_path) {
            Ok(data) => build_response(StatusCode::OK, "text/css; charset=utf-8", data),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
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

fn pid_file_path() -> std::path::PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".tmuxy");
    std::fs::create_dir_all(&dir).ok();
    dir.join("tmuxy.pid")
}

fn write_pid_file() {
    let pid = std::process::id();
    std::fs::write(pid_file_path(), pid.to_string()).ok();
}

fn remove_pid_file() {
    std::fs::remove_file(pid_file_path()).ok();
}

fn read_pid_file() -> Option<u32> {
    std::fs::read_to_string(pid_file_path())
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

fn stop_server() {
    match read_pid_file() {
        Some(pid) => {
            if !is_process_alive(pid) {
                println!("Server is not running (stale PID file for pid {})", pid);
                remove_pid_file();
                return;
            }

            #[cfg(unix)]
            {
                use nix::sys::signal::{self, Signal};
                use nix::unistd::Pid;
                match signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM) {
                    Ok(_) => {
                        println!("Sent SIGTERM to server (pid {})", pid);
                        remove_pid_file();
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

fn server_status() {
    match read_pid_file() {
        Some(pid) => {
            if is_process_alive(pid) {
                println!("Server is running (pid {})", pid);
            } else {
                println!("Server is not running (stale PID file for pid {})", pid);
                remove_pid_file();
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
    while let Some(res) = join_set.join_next().await {
        if let Err(e) = res {
            tracing::warn!(error = %e, "joined task exited with error");
        }
        drained += 1;
    }
    tracing::info!(tasks = drained, "structured shutdown complete");

    for child in children.into_iter().flatten() {
        child.kill();
    }
}
