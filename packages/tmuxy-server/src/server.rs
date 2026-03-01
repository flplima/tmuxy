use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clap::{Args, Subcommand};
use rust_embed::Embed;
use std::sync::Arc;
use tokio::signal;

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
        None if dev_mode => start_dev_server().await,
        None => start_server(args.port, args.host).await,
        Some(ServerAction::Stop) => stop_server(),
        Some(ServerAction::Status) => server_status(),
    }
}

/// Start the development server with Vite proxy
async fn start_dev_server() {
    let state = Arc::new(AppState::new());

    println!(
        "[dev] Starting Vite dev server on port {}...",
        dev::VITE_PORT
    );
    let vite_child = dev::spawn_vite_dev_server().await;
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    let app = crate::state::api_routes()
        .fallback_service(tower::service_fn(|req: Request| async move {
            Ok::<_, std::convert::Infallible>(dev::proxy_to_vite(req).await)
        }))
        .with_state(state);

    let port = dev::get_port();
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    println!("tmuxy dev server running at http://localhost:{}", port);
    println!(
        "[dev] Vite HMR and static files proxied from port {}",
        dev::VITE_PORT
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(vite_child))
        .await
        .unwrap();
}

/// Start the production server with embedded frontend assets
async fn start_server(port: u16, host: String) {
    write_pid_file();

    let state = Arc::new(AppState::new());

    let app = crate::state::api_routes()
        .fallback(serve_embedded)
        .with_state(state);

    let addr: std::net::SocketAddr = format!("{}:{}", host, port)
        .parse()
        .unwrap_or_else(|_| std::net::SocketAddr::from(([0, 0, 0, 0], port)));

    println!("tmuxy server running at http://{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(None))
        .await
        .unwrap();

    remove_pid_file();
}

/// Serve files from embedded frontend assets (SPA with index.html fallback)
async fn serve_embedded(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = FrontendAssets::get(path) {
        let mime = mime_for_path(path);
        Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            .body(Body::from(file.data.into_owned()))
            .unwrap()
    } else if let Some(index) = FrontendAssets::get("index.html") {
        // SPA fallback
        Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "text/html; charset=utf-8")
            .body(Body::from(index.data.into_owned()))
            .unwrap()
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
                    Err(e) => eprintln!("Failed to stop server (pid {}): {}", pid, e),
                }
            }

            #[cfg(not(unix))]
            eprintln!("Stop not supported on this platform");
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

async fn shutdown_signal(vite_child: Option<dev::ViteChild>) {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
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

    if let Some(child) = vite_child {
        child.kill();
    }
}
