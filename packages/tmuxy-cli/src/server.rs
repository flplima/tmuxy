use crate::web::{self, AppState};
use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clap::{Args, Subcommand};
use rust_embed::Embed;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::signal;

/// Port for Vite dev server
const VITE_PORT: u16 = 1420;

#[derive(Embed)]
#[folder = "../tmuxy-ui/dist/"]
struct FrontendAssets;

/// List available theme names from embedded assets or filesystem (dev mode fallback).
pub fn list_theme_names() -> Vec<String> {
    // Try embedded assets first (production build)
    let mut names: Vec<String> = <FrontendAssets as Embed>::iter()
        .filter_map(|path: std::borrow::Cow<'_, str>| {
            let path = path.as_ref();
            if path.starts_with("themes/") && path.ends_with(".css") {
                let name = path
                    .strip_prefix("themes/")
                    .unwrap()
                    .strip_suffix(".css")
                    .unwrap();
                Some(name.to_string())
            } else {
                None
            }
        })
        .collect();

    // Dev mode fallback: scan filesystem
    if names.is_empty() {
        let workspace_root = web::find_workspace_root();
        let themes_dir = workspace_root.join("packages/tmuxy-ui/public/themes");
        if let Ok(entries) = std::fs::read_dir(&themes_dir) {
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                if file_name.ends_with(".css") {
                    let name = file_name.strip_suffix(".css").unwrap().to_string();
                    names.push(name);
                }
            }
        }
    }

    names.sort();
    names
}

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

    /// Start in development mode (proxy to Vite dev server)
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
    match args.action {
        None => {
            if args.dev || std::env::var("TMUXY_DEV").is_ok() {
                start_dev_server(args.port, args.host).await;
            } else {
                start_server(args.port, args.host).await;
            }
        }
        Some(ServerAction::Stop) => stop_server(),
        Some(ServerAction::Status) => server_status(),
    }
}

// ============================================
// Production Server (embedded assets)
// ============================================

async fn start_server(port: u16, host: String) {
    write_pid_file();

    let state = Arc::new(AppState::new());

    let app = web::api_routes().fallback(serve_embedded).with_state(state);

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
// Dev Server (Vite proxy)
// ============================================

/// Find an available port starting from 9000, incrementing until one is free.
fn find_available_port(start: u16) -> u16 {
    for port in start..start + 100 {
        if std::net::TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return port;
        }
    }
    start
}

/// Handle to Vite child process for cleanup
#[cfg(unix)]
struct ViteChild {
    pgid: i32,
}

#[cfg(unix)]
impl ViteChild {
    fn kill(&self) {
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        println!("[dev] Vite process group killed");
    }
}

#[cfg(not(unix))]
struct ViteChild;

#[cfg(not(unix))]
impl ViteChild {
    fn kill(self) {
        println!("[dev] Vite process killed");
    }
}

async fn start_dev_server(port: u16, host: String) {
    let state = Arc::new(AppState::new());

    // Spawn Vite dev server
    println!("[dev] Starting Vite dev server on port {}...", VITE_PORT);
    let vite_child = spawn_vite_dev_server().await;
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Build router: API routes + Vite proxy fallback
    let app = web::api_routes()
        .fallback_service(tower::service_fn(|req: Request| async move {
            Ok::<_, std::convert::Infallible>(proxy_to_vite(req).await)
        }))
        .with_state(state);

    // Use provided port, or find an available one
    let actual_port = if std::net::TcpListener::bind(("0.0.0.0", port)).is_ok() {
        port
    } else {
        find_available_port(9000)
    };

    let addr: std::net::SocketAddr = format!("{}:{}", host, actual_port)
        .parse()
        .unwrap_or_else(|_| std::net::SocketAddr::from(([0, 0, 0, 0], actual_port)));

    println!(
        "tmuxy dev server running at http://localhost:{}",
        actual_port
    );
    println!(
        "[dev] Vite HMR and static files proxied from port {}",
        VITE_PORT
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(vite_child))
        .await
        .unwrap();
}

async fn proxy_to_vite(req: Request) -> Response {
    let client = reqwest::Client::new();

    let uri = req.uri();
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");

    let vite_url = format!("http://localhost:{}{}", VITE_PORT, path_and_query);

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in req.headers() {
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()) {
            if let Ok(value) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
                headers.insert(name, value);
            }
        }
    }

    let method = match req.method().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    };

    match client
        .request(method, &vite_url)
        .headers(headers)
        .send()
        .await
    {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);

            let mut response_builder = Response::builder().status(status);

            for (name, value) in resp.headers() {
                if let Ok(name) = axum::http::HeaderName::from_bytes(name.as_str().as_bytes()) {
                    if let Ok(value) = axum::http::HeaderValue::from_bytes(value.as_bytes()) {
                        response_builder = response_builder.header(name, value);
                    }
                }
            }

            let body = resp.bytes().await.unwrap_or_default();
            response_builder
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
        Err(e) => {
            eprintln!("[dev] Proxy error: {}", e);
            Response::builder()
                .status(axum::http::StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Proxy error: {}", e)))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
    }
}

async fn spawn_vite_dev_server() -> Option<ViteChild> {
    let workspace_root = web::find_workspace_root();

    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(["run", "dev", "-w", "@tmuxy/ui"])
            .current_dir(&workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
        cmd
    };

    #[cfg(not(unix))]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(["run", "dev", "-w", "@tmuxy/ui"])
            .current_dir(&workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    };

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("Failed to spawn Vite dev server: {}", e);
            return None;
        }
    };

    #[cfg(unix)]
    let pid = child.id().unwrap_or(0) as i32;

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                println!("[vite] {}", line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[vite] {}", line);
            }
        });
    }

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                if !status.success() {
                    eprintln!("[vite] Process exited with status: {}", status);
                }
            }
            Err(e) => {
                eprintln!("[vite] Error waiting for process: {}", e);
            }
        }
    });

    #[cfg(unix)]
    return Some(ViteChild { pgid: pid });

    #[cfg(not(unix))]
    return None;
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

async fn shutdown_signal(vite_child: Option<ViteChild>) {
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
