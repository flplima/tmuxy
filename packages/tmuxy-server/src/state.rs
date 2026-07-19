use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tmuxy_core::control_mode::{MonitorCommandSender, StoredImage};
use tmuxy_core::{Ctx, RetryPolicy};
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};

/// Number of recent broadcast messages retained per session for
/// `Last-Event-Id` replay and lagged-subscriber recovery. Sized to match the
/// broadcast channel capacity so a client that lags by up to a full buffer can
/// recover from the ring without waiting for the next full state snapshot; a
/// larger gap is covered by the next `StateUpdate::Full` broadcast.
pub const EVENT_BUFFER_SIZE: usize = 100;

/// A broadcast message tagged with its monotonic per-session sequence id.
/// The id is mirrored as the SSE `id:` field so the browser persists it
/// across reconnects via the `Last-Event-Id` request header.
pub type TaggedEvent = (u64, String);

/// Wraps a `broadcast::Sender` with the monotonic `seq` counter and the
/// recent-events ring buffer needed for `Last-Event-Id` resync.
///
/// All fields are sync-friendly so `SseEmitter` (whose trait methods are
/// non-async) can `broadcast()` without awaiting. The `StdMutex` is held
/// briefly to push to a small VecDeque; contention on it is negligible.
pub struct SessionBroadcast {
    /// Tokio broadcast channel — each subscribed client gets its own
    /// 100-message lag buffer here. The capacity matches `EVENT_BUFFER_SIZE`
    /// so a client that hit `RecvError::Lagged` replays from `recent` (the SSE
    /// handler's `Lagged` arm calls `replay_since`).
    pub tx: broadcast::Sender<TaggedEvent>,
    /// Monotonic per-session counter — `fetch_add(1)` produces the next id.
    pub seq: AtomicU64,
    /// Ring buffer of the most recent `EVENT_BUFFER_SIZE` tagged messages.
    /// Front = oldest, back = newest. Used to resume a client that
    /// reconnected with a `Last-Event-Id` header.
    pub recent: StdMutex<VecDeque<TaggedEvent>>,
}

impl SessionBroadcast {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        Self {
            tx,
            seq: AtomicU64::new(0),
            recent: StdMutex::new(VecDeque::with_capacity(EVENT_BUFFER_SIZE)),
        }
    }

    /// Broadcast a payload to every subscriber and store it in the ring buffer.
    /// Returns the sequence id assigned to this message.
    pub fn broadcast(&self, payload: String) -> u64 {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let entry: TaggedEvent = (id, payload);
        if let Ok(mut buf) = self.recent.lock() {
            if buf.len() == EVENT_BUFFER_SIZE {
                buf.pop_front();
            }
            buf.push_back(entry.clone());
        }
        let _ = self.tx.send(entry);
        id
    }

    /// Return every buffered event with `seq > since`, in order.
    /// `since` is the `Last-Event-Id` the reconnecting client sent.
    pub fn replay_since(&self, since: u64) -> Vec<TaggedEvent> {
        match self.recent.lock() {
            Ok(buf) => buf.iter().filter(|(s, _)| *s > since).cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Lowest sequence id still present in the buffer, or `None` if empty.
    /// If the client's `Last-Event-Id` is below this, we can't replay
    /// without gaps and need to send a full state snapshot instead.
    pub fn oldest_seq(&self) -> Option<u64> {
        self.recent
            .lock()
            .ok()
            .and_then(|b| b.front().map(|(s, _)| *s))
    }

    /// Subscribe a new client to live broadcasts.
    pub fn subscribe(&self) -> broadcast::Receiver<TaggedEvent> {
        self.tx.subscribe()
    }
}

impl Default for SessionBroadcast {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod broadcast_tests {
    use super::*;

    #[test]
    fn seqs_are_monotonic() {
        let b = SessionBroadcast::new();
        assert_eq!(b.broadcast("a".into()), 0);
        assert_eq!(b.broadcast("b".into()), 1);
        assert_eq!(b.broadcast("c".into()), 2);
    }

    #[test]
    fn replay_since_returns_strictly_newer() {
        let b = SessionBroadcast::new();
        for i in 0..5 {
            b.broadcast(format!("m{}", i));
        }
        let replay = b.replay_since(2);
        // expects seq 3 and 4
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0].0, 3);
        assert_eq!(replay[0].1, "m3");
        assert_eq!(replay[1].0, 4);
        assert_eq!(replay[1].1, "m4");
    }

    #[test]
    fn ring_buffer_drops_oldest_at_capacity() {
        let b = SessionBroadcast::new();
        for i in 0..(EVENT_BUFFER_SIZE + 5) {
            b.broadcast(format!("m{}", i));
        }
        assert_eq!(b.oldest_seq(), Some(5));
        let replay = b.replay_since(4);
        assert_eq!(replay.len(), EVENT_BUFFER_SIZE);
        assert_eq!(replay[0].0, 5);
    }

    #[test]
    fn oldest_seq_is_none_when_empty() {
        let b = SessionBroadcast::new();
        assert_eq!(b.oldest_seq(), None);
    }
}

/// Build an HTTP response from a status, content-type, and body.
///
/// `Response::builder().body()` only returns `Err` when a header value contains
/// invalid bytes (control characters, non-ASCII, etc.). All callers in this
/// module pass static `&'static str` mime types, so the unwrap path is
/// effectively unreachable — but if a future caller somehow injects a bad
/// header value we'd rather return a 500 than panic the server thread.
pub(crate) fn build_response(status: StatusCode, mime: &str, body: impl Into<Body>) -> Response {
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
    /// Broadcast channel + sequence id + replay buffer for this session.
    /// Wrapped in `Arc` so `SseEmitter` can clone a handle and call
    /// `broadcast()` without holding the `sessions` write lock.
    pub broadcast: Arc<SessionBroadcast>,
    /// Handle to the monitor task (so we can stop it when last client leaves)
    pub monitor_handle: Option<JoinHandle<()>>,
}

impl Default for SessionConnections {
    fn default() -> Self {
        Self {
            connections: Vec::new(),
            client_sizes: HashMap::new(),
            last_resize: None,
            monitor_command_tx: None,
            broadcast: Arc::new(SessionBroadcast::new()),
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
    /// Structured shutdown: every background task spawned by the server lives
    /// in this `JoinSet`. `server::shutdown_signal` calls
    /// `join_set.shutdown().await` after firing `shutdown.cancel()` so we drain
    /// to completion instead of leaking orphans on Ctrl+C.
    pub join_set: Mutex<JoinSet<()>>,
    /// Cancellation token broadcast to every spawned task. Each task should
    /// `tokio::select!` against `shutdown.cancelled()` so it exits its
    /// long-running loop promptly.
    pub shutdown: CancellationToken,
    /// Execution context (`tmux`/`clock`/`fs` capabilities behind trait objects).
    /// Threaded into `TmuxMonitor` and reused for ad-hoc tmux dispatch via the
    /// Tower stack. Production uses `Ctx::live()`; tests substitute a mock ctx.
    pub ctx: Arc<Ctx>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::with_ctx(Ctx::live())
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct with an explicit context. Used by tests that want to swap in
    /// `MockTmux`/`FakeClock` while keeping the same server wiring otherwise.
    pub fn with_ctx(ctx: Arc<Ctx>) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            image_store: RwLock::new(HashMap::new()),
            join_set: Mutex::new(JoinSet::new()),
            shutdown: CancellationToken::new(),
            ctx,
        }
    }

    /// Spawn a background task into the shutdown-tracked `JoinSet`.
    ///
    /// Callers should incorporate `self.shutdown.cancelled()` into the
    /// future's branching so the task exits promptly when shutdown fires.
    /// Tasks that drop naturally (oneshot cleanup chores) don't need it.
    pub async fn spawn<F>(&self, fut: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.join_set.lock().await.spawn(fut);
    }

    /// Thin wrapper around `Ctx::tmux_call`. Kept for handler ergonomics —
    /// SSE handlers grab `AppState` from axum and would otherwise need to
    /// thread `state.ctx` explicitly into every call site.
    pub async fn tmux_call(
        &self,
        args: Vec<String>,
        op_name: &str,
    ) -> Result<String, tmuxy_core::TmuxError> {
        self.ctx.tmux_call(args, op_name).await
    }

    /// Thin wrapper around `Ctx::tmux_call_with_policy`.
    pub async fn tmux_call_with_policy(
        &self,
        args: Vec<String>,
        op_name: &str,
        policy: RetryPolicy,
    ) -> Result<String, tmuxy_core::TmuxError> {
        self.ctx.tmux_call_with_policy(args, op_name, policy).await
    }
}

/// Build the API routes shared between dev server and production CLI.
/// Returns a Router that needs `.fallback_service(...)` and `.with_state(state)`.
pub fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/events", get(crate::sse::sse_handler))
        .route("/commands", post(crate::sse::commands_handler))
        .route("/api/file", get(file_handler))
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
