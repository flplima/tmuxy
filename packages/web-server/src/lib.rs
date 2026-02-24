pub mod sse;

use axum::{
    body::Body,
    extract::Query,
    response::Response,
    routing::{get, post},
    Router,
};
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tmuxy_core::control_mode::MonitorCommandSender;
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;
use tower_http::cors::{Any, CorsLayer};

/// Tracks connections and shared resources for a single tmux session
pub struct SessionConnections {
    /// All connection IDs in order of connection time
    pub connections: Vec<u64>,
    /// Each client's reported viewport size (cols, rows) for min-size computation
    pub client_sizes: HashMap<u64, (u32, u32)>,
    /// Last resize dimensions sent to tmux (to avoid redundant resize commands)
    pub last_resize: Option<(u32, u32)>,
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
            last_resize: None,
            monitor_command_tx: None,
            state_tx,
            monitor_handle: None,
        }
    }
}

pub struct AppState {
    /// Per-session connection tracking
    pub sessions: RwLock<HashMap<String, SessionConnections>>,
    /// Counter for generating unique connection IDs
    pub next_conn_id: AtomicU64,
    /// SSE session tokens: token -> (conn_id, session_name)
    pub sse_tokens: RwLock<HashMap<String, (u64, String)>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            sse_tokens: RwLock::new(HashMap::new()),
        }
    }
}

/// Build the API routes shared between dev server and production CLI.
/// Returns a Router that needs `.fallback_service(...)` and `.with_state(state)`.
pub fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/events", get(sse::sse_handler))
        .route("/commands", post(sse::commands_handler))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/directory", get(directory_handler))
        .route("/api/file", get(file_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
}

// ============================================
// Internal Handlers
// ============================================

#[derive(Debug, serde::Deserialize)]
struct FileQuery {
    path: String,
}

async fn file_handler(Query(query): Query<FileQuery>) -> Response {
    let path = std::path::Path::new(&query.path);
    match std::fs::read_to_string(path) {
        Ok(content) => Response::builder()
            .status(axum::http::StatusCode::OK)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(Body::from(content))
            .unwrap(),
        Err(e) => Response::builder()
            .status(axum::http::StatusCode::NOT_FOUND)
            .header("Content-Type", "application/json")
            .body(Body::from(
                serde_json::json!({ "error": format!("{}", e) }).to_string(),
            ))
            .unwrap(),
    }
}

#[derive(Debug, serde::Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

async fn directory_handler(Query(query): Query<DirectoryQuery>) -> Response {
    let path = query.path.unwrap_or_else(|| "/".to_string());

    match sse::list_directory(&path) {
        Ok(entries) => Response::builder()
            .status(axum::http::StatusCode::OK)
            .header("Content-Type", "application/json")
            .body(Body::from(serde_json::to_string(&entries).unwrap()))
            .unwrap(),
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

#[derive(Debug, serde::Deserialize)]
struct SnapshotQuery {
    session: Option<String>,
}

async fn snapshot_handler(Query(query): Query<SnapshotQuery>) -> Response {
    let session = query
        .session
        .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());

    let workspace_root = find_workspace_root();

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

    let relative_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let snapshot_path = workspace_root.join(&relative_path);

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

/// Find the workspace root (directory with package.json containing "workspaces")
pub fn find_workspace_root() -> std::path::PathBuf {
    std::env::current_dir()
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
        .unwrap_or_else(|| std::env::current_dir().unwrap())
}
