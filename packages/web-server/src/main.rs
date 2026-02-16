mod sse;

use axum::{
    body::Body,
    extract::{Query, Request},
    response::Response,
    routing::{get, post},
    Router,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::signal;
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tmuxy_core::control_mode::MonitorCommandSender;


/// Port for Vite dev server
const VITE_PORT: u16 = 1420;

/// Find an available port starting from 9000, incrementing until one is free.
/// Override with PORT env var.
fn get_port() -> u16 {
    if let Some(port) = std::env::var("PORT").ok().and_then(|p| p.parse().ok()) {
        return port;
    }

    for port in 9000..9100u16 {
        if std::net::TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return port;
        }
    }

    9000
}

/// Handle to Vite child process for cleanup
#[cfg(unix)]
struct ViteChild {
    pgid: i32,
}

#[cfg(unix)]
impl ViteChild {
    fn kill(&self) {
        // Kill the entire process group
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        println!("[dev] Vite process group killed");
    }
}

#[cfg(not(unix))]
struct ViteChild {
    child: tokio::process::Child,
}

#[cfg(not(unix))]
impl ViteChild {
    fn kill(mut self) {
        let _ = self.child.start_kill();
        println!("[dev] Vite process killed");
    }
}

/// Tracks connections and shared resources for a single tmux session
pub struct SessionConnections {
    /// All connection IDs in order of connection time
    pub connections: Vec<u64>,
    /// Each client's reported viewport size (cols, rows) for min-size computation
    pub client_sizes: HashMap<u64, (u32, u32)>,
    /// Sender for commands to the session's monitor (resize, etc.)
    pub monitor_command_tx: Option<MonitorCommandSender>,
    /// Broadcast channel for state updates (shared by all clients in this session)
    pub state_tx: broadcast::Sender<String>,
    /// Handle to the monitor task (so we can stop it when last client leaves)
    pub monitor_handle: Option<JoinHandle<()>>,
}

impl SessionConnections {
    pub fn new() -> Self {
        let (state_tx, _) = broadcast::channel(100);
        Self {
            connections: Vec::new(),
            client_sizes: HashMap::new(),
            monitor_command_tx: None,
            state_tx,
            monitor_handle: None,
        }
    }
}

pub struct AppState {
    pub broadcast_tx: broadcast::Sender<String>,
    pub dev_mode: bool,
    /// Per-session connection tracking
    pub sessions: RwLock<HashMap<String, SessionConnections>>,
    /// Counter for generating unique connection IDs
    pub next_conn_id: AtomicU64,
    /// SSE session tokens: token -> (conn_id, session_name)
    pub sse_tokens: RwLock<HashMap<String, (u64, String)>>,
}

#[tokio::main]
async fn main() {
    // Check for dev mode via CLI arg or env var
    let dev_mode = std::env::args().any(|arg| arg == "--dev")
        || std::env::var("TMUXY_DEV").is_ok();

    // Note: We intentionally don't create the default tmux session at startup.
    // Sessions are created on-demand when clients connect (via WebSocket handler).
    // This avoids tmux 3.3a crashes when external tmux commands are run while
    // control mode is attached to any session.

    // Create broadcast channel for state updates (kept for backward compatibility)
    let (broadcast_tx, _) = broadcast::channel::<String>(100);

    let state = Arc::new(AppState {
        broadcast_tx: broadcast_tx.clone(),
        dev_mode,
        sessions: RwLock::new(HashMap::new()),
        next_conn_id: AtomicU64::new(1),
        sse_tokens: RwLock::new(HashMap::new()),
    });

    // Note: Per-connection monitoring is now started in handle_socket
    // when a WebSocket connection is established with a session parameter

    // In dev mode, spawn Vite dev server
    let vite_child = if dev_mode {
        println!("[dev] Starting Vite dev server on port {}...", VITE_PORT);
        let child = spawn_vite_dev_server().await;

        // Wait a bit for Vite to start
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        child
    } else {
        None
    };

    // Build router
    let app = if dev_mode {
        // Dev mode: proxy to Vite
        // - /events: SSE stream for server->client push
        // - /commands: POST endpoint for client->server commands
        // - /api/snapshot: tmux state snapshot for debugging
        // - /api/directory: directory listing for file picker
        // - everything else: proxy to Vite (HTTP and WebSocket)
        Router::new()
            .route("/events", get(sse::sse_handler))
            .route("/commands", post(sse::commands_handler))
            .route("/api/snapshot", get(snapshot_handler))
            .route("/api/directory", get(directory_handler))
            .fallback_service(tower::service_fn(|req: Request| async move {
                Ok::<_, std::convert::Infallible>(proxy_to_vite(req).await)
            }))
            .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
            .with_state(state)
    } else {
        Router::new()
            .route("/events", get(sse::sse_handler))
            .route("/commands", post(sse::commands_handler))
            .route("/api/snapshot", get(snapshot_handler))
            .route("/api/directory", get(directory_handler))
            .fallback_service(ServeDir::new("dist"))
            .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
            .with_state(state)
    };

    let port = get_port();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("tmuxy web server running at http://localhost:{}", port);
    if dev_mode {
        println!("[dev] Vite HMR and static files proxied from port {}", VITE_PORT);
    }

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    // Run server with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(vite_child))
        .await
        .unwrap();
}

/// Wait for shutdown signal and cleanup child processes
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

    // Kill Vite process group
    if let Some(child) = vite_child {
        child.kill();
    }
}

/// Query parameters for directory listing
#[derive(Debug, serde::Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

/// Handler to list directory contents for file picker
async fn directory_handler(
    Query(query): Query<DirectoryQuery>,
) -> Response {
    let path = query.path.unwrap_or_else(|| "/".to_string());

    match sse::list_directory(&path) {
        Ok(entries) => {
            Response::builder()
                .status(axum::http::StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::to_string(&entries).unwrap()))
                .unwrap()
        }
        Err(e) => {
            let error = serde_json::json!({ "error": e });
            Response::builder()
                .status(axum::http::StatusCode::BAD_REQUEST)
                .header("Content-Type", "application/json")
                .body(Body::from(error.to_string()))
                .unwrap()
        }
    }
}

/// Proxy HTTP requests to Vite dev server
async fn proxy_to_vite(req: Request) -> Response {
    let client = reqwest::Client::new();

    let uri = req.uri();
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let vite_url = format!("http://localhost:{}{}", VITE_PORT, path_and_query);

    // Forward headers
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

    match client.request(method, &vite_url).headers(headers).send().await {
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

/// Spawn Vite dev server and stream its output
/// Returns a ViteChild handle for cleanup on shutdown
async fn spawn_vite_dev_server() -> Option<ViteChild> {
    // Find the workspace root (where package.json with workspaces is)
    let workspace_root = std::env::current_dir()
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
        .unwrap_or_else(|| std::env::current_dir().unwrap());

    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(["run", "dev", "-w", "tmuxy-ui"])
            .current_dir(&workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Create new process group so we can kill npm and all its children
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
        cmd.args(["run", "dev", "-w", "tmuxy-ui"])
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

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                println!("[vite] {}", line);
            }
        });
    }

    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[vite] {}", line);
            }
        });
    }

    // Spawn task to wait for child process (for cleanup and logging)
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
    return None; // On non-Unix, we rely on tokio's kill_on_drop
}

/// Query parameters for snapshot endpoint
#[derive(Debug, serde::Deserialize)]
struct SnapshotQuery {
    session: Option<String>,
}

/// Handler to capture tmux state snapshot for debugging.
/// Returns JSON: { rows: number, cols: number, lines: string[] }
async fn snapshot_handler(
    Query(query): Query<SnapshotQuery>,
) -> Response {
    let session = query.session.unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());

    // Find the workspace root
    let workspace_root = std::env::current_dir()
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
        .unwrap_or_else(|| std::env::current_dir().unwrap());

    let release_path = workspace_root.join("target/release/tmux-capture");
    let debug_path = workspace_root.join("target/debug/tmux-capture");

    let binary_path = if release_path.exists() {
        release_path
    } else if debug_path.exists() {
        debug_path
    } else {
        let json = serde_json::json!({
            "error": "tmux-capture binary not found. Run: cargo build -p tmuxy-core --bin tmux-capture",
        });
        return Response::builder()
            .status(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
            .header("Content-Type", "application/json")
            .body(Body::from(json.to_string()))
            .unwrap();
    };

    // Run tmux-capture from workspace root so relative paths work
    let output = match std::process::Command::new(&binary_path)
        .args([&session, "200"])
        .current_dir(&workspace_root)
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            let json = serde_json::json!({
                "error": format!("Failed to run tmux-capture: {}", e),
            });
            return Response::builder()
                .status(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
                .header("Content-Type", "application/json")
                .body(Body::from(json.to_string()))
                .unwrap();
        }
    };

    if !output.status.success() {
        let json = serde_json::json!({
            "error": format!("tmux-capture failed: {}", String::from_utf8_lossy(&output.stderr)),
        });
        return Response::builder()
            .status(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
            .header("Content-Type", "application/json")
            .body(Body::from(json.to_string()))
            .unwrap();
    }

    // Output is the relative path to the snapshot file - resolve it from workspace root
    let relative_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let snapshot_path = workspace_root.join(&relative_path);

    // Read the snapshot file and return as JSON with rows, cols, and lines
    match std::fs::read_to_string(&snapshot_path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let rows = lines.len();
            let cols = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);

            let json = serde_json::json!({
                "rows": rows,
                "cols": cols,
                "lines": lines,
            });

            Response::builder()
                .status(axum::http::StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Body::from(json.to_string()))
                .unwrap()
        }
        Err(e) => {
            let json = serde_json::json!({
                "error": format!("Failed to read snapshot file '{}': {}", snapshot_path.display(), e),
            });
            Response::builder()
                .status(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
                .header("Content-Type", "application/json")
                .body(Body::from(json.to_string()))
                .unwrap()
        }
    }
}
