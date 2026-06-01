use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tmuxy_core::control_mode::{MonitorCommandSender, StoredImage};
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;
use tower_http::cors::{Any, CorsLayer};

/// Build an HTTP response from a status, content-type, and body.
///
/// `Response::builder().body()` only returns `Err` when a header value contains
/// invalid bytes (control characters, non-ASCII, etc.). All callers in this
/// module pass static `&'static str` mime types, so the unwrap path is
/// effectively unreachable — but if a future caller somehow injects a bad
/// header value we'd rather return a 500 than panic the server thread.
fn build_response(status: StatusCode, mime: &str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .body(body.into())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Convenience: build a `application/json` response from a serializable value.
/// Serialization errors round-trip as a 500 with a plain-text fallback body.
fn json_response(status: StatusCode, value: &serde_json::Value) -> Response {
    match serde_json::to_string(value) {
        Ok(body) => build_response(status, "application/json", body),
        Err(_) => build_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            "internal server error: failed to serialize JSON response",
        ),
    }
}

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

impl Default for SessionConnections {
    fn default() -> Self {
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

impl SessionConnections {
    pub fn new() -> Self {
        Self::default()
    }
}

pub struct AppState {
    /// Per-session connection tracking
    pub sessions: RwLock<HashMap<String, SessionConnections>>,
    /// Counter for generating unique connection IDs
    pub next_conn_id: AtomicU64,
    /// Shared image store: (pane_id, image_id) -> StoredImage
    pub image_store: RwLock<HashMap<(String, u32), StoredImage>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            image_store: RwLock::new(HashMap::new()),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Build the API routes shared between dev server and production CLI.
/// Returns a Router that needs `.fallback_service(...)` and `.with_state(state)`.
pub fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/events", get(crate::sse::sse_handler))
        .route("/commands", post(crate::sse::commands_handler))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/directory", get(directory_handler))
        .route("/api/file", get(file_handler))
        .route("/api/themes", get(themes_handler))
        .route("/api/images/{pane_id}/{image_id}", get(image_handler))
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
    let content_type = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        _ => "text/plain; charset=utf-8",
    };
    match std::fs::read(path) {
        Ok(content) => build_response(StatusCode::OK, content_type, content),
        Err(e) => json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": format!("{}", e) }),
        ),
    }
}

#[derive(Debug, serde::Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

async fn directory_handler(Query(query): Query<DirectoryQuery>) -> Response {
    let path = query.path.unwrap_or_else(|| "/".to_string());

    match crate::sse::list_directory(&path) {
        Ok(entries) => match serde_json::to_value(&entries) {
            Ok(v) => json_response(StatusCode::OK, &v),
            Err(e) => json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &serde_json::json!({ "error": e.to_string() }),
            ),
        },
        Err(e) => json_response(StatusCode::BAD_REQUEST, &serde_json::json!({ "error": e })),
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
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({
                "error": "tmux-capture binary not found. Run: cargo build -p tmuxy-core --bin tmux-capture",
            }),
        );
    };

    let output = match std::process::Command::new(&binary_path)
        .args([&session, "200"])
        .current_dir(&workspace_root)
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &serde_json::json!({
                    "error": format!("Failed to run tmux-capture: {}", e),
                }),
            );
        }
    };

    if !output.status.success() {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({
                "error": format!("tmux-capture failed: {}", String::from_utf8_lossy(&output.stderr)),
            }),
        );
    }

    let relative_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let snapshot_path = workspace_root.join(&relative_path);

    match std::fs::read_to_string(&snapshot_path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let rows = lines.len();
            let cols = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
            json_response(
                StatusCode::OK,
                &serde_json::json!({
                    "rows": rows,
                    "cols": cols,
                    "lines": lines,
                }),
            )
        }
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({
                "error": format!("Failed to read snapshot file '{}': {}", snapshot_path.display(), e),
            }),
        ),
    }
}

async fn image_handler(
    State(state): State<Arc<AppState>>,
    Path((pane_id, image_id)): Path<(String, u32)>,
) -> Response {
    let store = state.image_store.read().await;
    let key = (format!("%{}", pane_id), image_id);
    match store.get(&key) {
        Some(img) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", &img.mime_type)
            .header("Cache-Control", "public, max-age=3600")
            .body(Body::from(img.data.clone()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": "image not found" }),
        ),
    }
}

async fn themes_handler() -> Response {
    let workspace_root = find_workspace_root();
    let themes_dir = workspace_root.join("packages/tmuxy-ui/public/themes");
    let mut names: Vec<String> = std::fs::read_dir(&themes_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.strip_suffix(".css").map(|n| n.to_string())
        })
        .collect();
    names.sort();

    let json: Vec<serde_json::Value> = names
        .into_iter()
        .map(|name| {
            let display_name = name
                .split('-')
                .map(|word| {
                    let mut chars = word.chars();
                    match chars.next() {
                        None => String::new(),
                        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            serde_json::json!({ "name": name, "displayName": display_name })
        })
        .collect();

    json_response(StatusCode::OK, &serde_json::Value::Array(json))
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
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        })
}
