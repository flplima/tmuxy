mod websocket;

use axum::{
    body::Body,
    extract::ws::WebSocketUpgrade,
    extract::{Query, Request},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::signal;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tmuxy_core::session;


/// Port for the web server (generated from "tmuxy" using get-port.sh)
const PORT: u16 = 3853;
/// Port for Vite dev server
const VITE_PORT: u16 = 1420;

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

#[derive(Clone)]
pub struct AppState {
    pub broadcast_tx: broadcast::Sender<String>,
    pub dev_mode: bool,
}

#[tokio::main]
async fn main() {
    // Check for dev mode via CLI arg or env var
    let dev_mode = std::env::args().any(|arg| arg == "--dev")
        || std::env::var("TMUXY_DEV").is_ok();

    // Initialize tmux session
    match session::create_or_attach_default() {
        Ok(_) => println!("tmuxy session initialized"),
        Err(e) => {
            eprintln!("Failed to create tmux session: {}", e);
            eprintln!("Make sure tmux is installed and available in PATH");
        }
    }

    // Create broadcast channel for state updates (kept for backward compatibility)
    let (broadcast_tx, _) = broadcast::channel::<String>(100);

    let state = Arc::new(AppState {
        broadcast_tx: broadcast_tx.clone(),
        dev_mode,
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
        // - /ws: our tmux websocket
        // - everything else: proxy to Vite (HTTP and WebSocket)
        Router::new()
            .route("/ws", get(ws_handler))
            .fallback_service(tower::service_fn(|req: Request| async move {
                Ok::<_, std::convert::Infallible>(proxy_to_vite(req).await)
            }))
            .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any))
            .with_state(state)
    } else {
        Router::new()
            .route("/ws", get(ws_handler))
            .fallback_service(ServeDir::new("dist"))
            .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any))
            .with_state(state)
    };

    let addr = SocketAddr::from(([0, 0, 0, 0], PORT));
    println!("tmuxy web server running at http://localhost:{}", PORT);
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

/// Query parameters for WebSocket connection
#[derive(Debug, serde::Deserialize)]
struct WsQuery {
    session: Option<String>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    let session = query.session.unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());
    ws.on_upgrade(move |socket| websocket::handle_socket(socket, state, session))
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
