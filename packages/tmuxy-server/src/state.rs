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

use crate::request_guard::HostPolicy;

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
    /// `--read-only`: every client of this server is a viewer. Only the
    /// commands `ClientCommand::is_read` names are served, and no client's
    /// viewport is ever recorded, so a viewer cannot resize the session.
    pub read_only: bool,
    /// The one session this server is allowed to show, if it is pinned.
    ///
    /// A `--read-only` server is pinned to the session it was started for, so
    /// a viewer cannot name another one in `GET /events?session=` and be
    /// handed a different screen — or, on a writable socket shared with a
    /// writer, the whole tmux server. `None` on a writable server, where a
    /// client can already run anything and session switching is the feature.
    pub session_pin: Option<String>,
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
            read_only: false,
            session_pin: None,
        }
    }

    /// Serve every client of this state as a viewer (`--read-only`).
    pub fn with_read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    /// Pin this server to one session: see `AppState::session_pin`.
    pub fn with_session_pin(mut self, session: Option<String>) -> Self {
        self.session_pin = session;
        self
    }

    /// Whether `name` is a session this server will serve.
    pub fn serves_session(&self, name: &str) -> bool {
        match &self.session_pin {
            Some(pinned) => pinned == name,
            None => true,
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
///
/// Every route answers only the app itself: `host_policy` says which `Host`
/// names count as this server (see `request_guard`). No CORS headers are sent,
/// so no other origin can read a response either.
pub fn api_routes(host_policy: HostPolicy) -> Router<Arc<AppState>> {
    Router::new()
        .route("/events", get(crate::sse::sse_handler))
        .route("/commands", post(crate::sse::commands_handler))
        // Client trace ingest (docs/TELEMETRY.md). Capped at 256 KiB/request so a
        // hostile client can't exhaust the disk in one call; the handler also
        // fails closed when tracing is off.
        .route(
            "/trace",
            post(crate::sse::trace_handler).layer(axum::extract::DefaultBodyLimit::max(256 * 1024)),
        )
        .route("/api/file", get(file_handler))
        .route("/api/browse/{*path}", get(browse_handler))
        .route("/api/images/{pane_id}/{image_id}", get(image_handler))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(host_policy),
            crate::request_guard::require_same_origin,
        ))
}

// ============================================
// Internal Handlers
// ============================================

#[derive(Debug, serde::Deserialize)]
struct FileQuery {
    path: String,
}

async fn file_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FileQuery>,
) -> Response {
    if let Some(refusal) = refuse_when_read_only(&state) {
        return refusal;
    }
    read_file_offthread(query.path).await
}

/// Serve a local file at a path-shaped URL: `/api/browse/Users/me/doc/index.html`.
///
/// The browser widget frames this route, and a framed page's relative links
/// (`./style.css`, `../img/logo.png`) resolve against the URL it was loaded
/// from — which is why this exists alongside `/api/file?path=`, whose query
/// string would send every subresource to `/api/style.css`. Axum has already
/// percent-decoded the captured path; the leading `/` it strips is put back so
/// the absolute path on disk round-trips.
///
/// Like `/api/file` this reads anywhere the server process can, gated by the
/// optional `--password` Basic auth and refused outright on a `--read-only`
/// server. See docs/SECURITY.md.
async fn browse_handler(State(state): State<Arc<AppState>>, Path(path): Path<String>) -> Response {
    if let Some(refusal) = refuse_when_read_only(&state) {
        return refusal;
    }
    read_file_offthread(format!("/{}", path.trim_start_matches('/'))).await
}

/// `read_file_response` on the blocking pool.
///
/// The read is synchronous and can be slow (a cold 64 MiB file, a network
/// mount that hangs), and a Tokio worker thread blocked in it serves nothing
/// else — including the SSE streams every other client is on.
async fn read_file_offthread(path: String) -> Response {
    match tokio::task::spawn_blocking(move || read_file_response(&path)).await {
        Ok(response) => response,
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({ "error": format!("file read task failed: {e}") }),
        ),
    }
}

/// 403 for the file routes on a `--read-only` server, or None to serve.
///
/// "Read-only" is about what a VIEWER may do to the session, and the command
/// path already enforces that. These two routes are a different power: they read
/// any file the server process can, anywhere on the disk, which is not part of
/// watching someone's terminal. A read-only server is the one meant to be handed
/// to people who are not trusted with the machine — a public demo above all —
/// so the arbitrary-read routes are exactly the ones it must not serve.
///
/// The browser widget is the only client of these routes, and a viewer of a
/// read-only session cannot open one (it takes a command), so nothing a viewer
/// can legitimately do is lost.
fn refuse_when_read_only(state: &AppState) -> Option<Response> {
    if !state.read_only {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            "read-only server: file routes are disabled\n",
        )
            .into_response(),
    )
}

/// The Content-Security-Policy every file route answers with: the document
/// renders sandboxed — its scripts run, in an opaque origin of their own and
/// never the server's.
const FILE_SANDBOX_CSP: &str =
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/// A local file, served so the browser widget can frame it in any build.
///
/// The Vite dev server serves the app cross-origin-isolated (COOP
/// `same-origin`, COEP `require-corp`), and under that policy a framed
/// document is blocked unless it opts in too: the widget showed the browser's
/// broken-page placeholder for every local HTML file. `credentialless` is that
/// opt-in without the cost `require-corp` would carry — a page's own
/// cross-origin scripts and images still load, just without credentials — and
/// `Cross-Origin-Resource-Policy` lets the file itself be embedded. Outside an
/// isolated parent both headers change nothing.
/// The largest file the browser widget will be served.
///
/// The widget frames documents — HTML, markdown, an image — so this is well
/// above anything it legitimately opens. Without it, `/api/file` pointed at a
/// multi-gigabyte log (or at `/dev/zero`, which has no end at all) grows the
/// server until the OS kills it.
const MAX_SERVED_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Read a file for the browser widget, or say why not.
///
/// Three refusals before the read, because the path is the client's:
/// - **Not a regular file.** `/dev/zero` never ends; a FIFO blocks its reader
///   until someone writes, and this runs on a Tokio worker thread, so one
///   request would park a worker for the life of the process. `symlink_metadata`
///   asks about the link itself, so a symlink to a device is refused too.
/// - **Over the cap.** See `MAX_SERVED_FILE_BYTES`.
///
/// The realistic failure is accidental rather than hostile — only a client that
/// already has a shell can reach these routes — but it takes the whole server
/// down either way.
fn read_file_checked(path: &str) -> Result<Vec<u8>, Box<Response>> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| {
        Box::new(json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": format!("{}", e) }),
        ))
    })?;

    // A symlink's own metadata says "symlink", so follow it once and ask about
    // the target — a symlink to a regular file is ordinary and still served.
    let meta = if meta.file_type().is_symlink() {
        std::fs::metadata(path).map_err(|e| {
            Box::new(json_response(
                StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": format!("{}", e) }),
            ))
        })?
    } else {
        meta
    };

    if !meta.is_file() {
        return Err(Box::new(json_response(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "error": "not a regular file" }),
        )));
    }
    if meta.len() > MAX_SERVED_FILE_BYTES {
        return Err(Box::new(json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            &serde_json::json!({
                "error": format!("file is larger than {MAX_SERVED_FILE_BYTES} bytes"),
            }),
        )));
    }

    std::fs::read(path).map_err(|e| {
        Box::new(json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": format!("{}", e) }),
        ))
    })
}

fn read_file_response(path: &str) -> Response {
    match read_file_checked(path) {
        Ok(content) => {
            let mut response = build_response(
                StatusCode::OK,
                tmuxy_core::mime::content_type_for_path(path),
                content,
            );
            let headers = response.headers_mut();
            headers.insert(
                axum::http::header::HeaderName::from_static("cross-origin-embedder-policy"),
                axum::http::HeaderValue::from_static("credentialless"),
            );
            headers.insert(
                axum::http::header::HeaderName::from_static("cross-origin-resource-policy"),
                axum::http::HeaderValue::from_static("cross-origin"),
            );
            // Rendered with the server's origin, an HTML file could POST tmux
            // commands like the app does. `sandbox` gives it an opaque origin
            // of its own, whether the browser widget frames it or someone
            // opens its URL directly.
            headers.insert(
                axum::http::header::CONTENT_SECURITY_POLICY,
                axum::http::HeaderValue::from_static(FILE_SANDBOX_CSP),
            );
            response
        }
        Err(refusal) => *refusal,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod file_route_tests {
    use super::*;

    /// SEC-02. The path is the client's, and `std::fs::read` on a character
    /// device never ends: `/api/file?path=/dev/zero` grew the server until the
    /// OS killed it. A FIFO is worse — the read blocks a Tokio worker forever.
    #[test]
    fn a_file_that_is_not_a_regular_file_is_refused_rather_than_read() {
        for path in ["/dev/zero", "/dev/null", "/tmp"] {
            if !std::path::Path::new(path).exists() {
                continue;
            }
            let response = read_file_response(path);
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{path} should be refused as not a regular file"
            );
        }
    }

    /// SEC-02. The realistic case is accidental — the widget pointed at a
    /// multi-gigabyte log — and it takes the server down just the same.
    #[test]
    fn a_file_over_the_cap_is_refused_before_it_is_read() {
        let path = std::env::temp_dir().join(format!("tmuxy-big-{}.bin", std::process::id()));
        let file = std::fs::File::create(&path).unwrap();
        // Sparse: the length is what the check reads, and nothing writes 64 MiB.
        file.set_len(MAX_SERVED_FILE_BYTES + 1).unwrap();
        drop(file);

        let response = read_file_response(path.to_str().unwrap());
        std::fs::remove_file(&path).ok();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn a_file_at_the_cap_is_still_served() {
        let path = std::env::temp_dir().join(format!("tmuxy-atcap-{}.txt", std::process::id()));
        std::fs::write(&path, b"small enough").unwrap();

        let response = read_file_response(path.to_str().unwrap());
        std::fs::remove_file(&path).ok();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn a_served_file_can_be_framed_by_a_cross_origin_isolated_app() {
        // The dev app is served with COEP `require-corp`; a frame that does
        // not opt in is replaced by the browser's broken-page placeholder.
        let path = std::env::temp_dir().join(format!("tmuxy-browse-{}.html", std::process::id()));
        std::fs::write(&path, "<h1>framed</h1>").unwrap();
        let response = read_file_response(path.to_str().unwrap());
        std::fs::remove_file(&path).ok();

        assert_eq!(response.status(), StatusCode::OK);
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        assert_eq!(
            header("cross-origin-embedder-policy").as_deref(),
            Some("credentialless")
        );
        assert_eq!(
            header("cross-origin-resource-policy").as_deref(),
            Some("cross-origin")
        );
        // Sandboxed: an HTML file never runs with the server's origin.
        let csp = header("content-security-policy").unwrap_or_default();
        assert!(csp.starts_with("sandbox "), "{csp}");
        assert!(!csp.contains("allow-same-origin"), "{csp}");
    }

    #[test]
    fn a_missing_file_is_a_404() {
        let response = read_file_response("/tmp/tmuxy-no-such-file-for-the-browse-route.html");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
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
            // Never cached. The id is a per-pane counter that starts again at
            // zero every time the server does, so an hour-long cache serves the
            // PREVIOUS run's picture at the same URL — a restarted tmuxy shows
            // a stale frame where the new one should be. Nothing here is worth
            // caching anyway: a live preview mints a new id per frame, and a
            // still image is fetched once per mount over a local socket.
            .header("Cache-Control", "no-store")
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod api_guard_tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app() -> Router {
        api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(Arc::new(AppState::new()))
    }

    /// The POST a hostile page can make without a preflight: `text/plain`,
    /// `no-cors`, the command JSON as its body.
    fn forged_command(origin: &'static str, site: &'static str) -> Request<Body> {
        Request::post("/commands")
            .header("host", "localhost:9000")
            .header("origin", origin)
            .header("sec-fetch-site", site)
            .header("content-type", "text/plain")
            .body(Body::from(
                r#"{"cmd":"run_tmux_command","args":{"command":"run-shell 'touch /tmp/pwned'"}}"#,
            ))
            .unwrap()
    }

    fn same_origin_command(body: &'static str) -> Request<Body> {
        Request::post("/commands")
            .header("host", "localhost:9000")
            .header("origin", "http://localhost:9000")
            .header("sec-fetch-site", "same-origin")
            .header("content-type", "application/json")
            .header("x-connection-id", "1")
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn a_read_only_server_refuses_every_write() {
        let state = Arc::new(AppState::new().with_read_only(true));
        let app = api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(state);
        for body in [
            r#"{"cmd":"run_tmux_command","args":{"command":"kill-server"}}"#,
            r#"{"cmd":"query_tmux","args":{"command":"list-panes"}}"#,
            r#"{"cmd":"set_client_size","args":{"cols":10,"rows":5}}"#,
            r#"{"cmd":"set_cursor_blink","args":{"enabled":false}}"#,
        ] {
            let response = app
                .clone()
                .oneshot(same_origin_command(body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{body}");
        }
        let trace = Request::post("/trace")
            .header("host", "localhost:9000")
            .header("origin", "http://localhost:9000")
            .header("sec-fetch-site", "same-origin")
            .body(Body::from("[]"))
            .unwrap();
        let response = app.clone().oneshot(trace).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    /// A read-only server must not serve the arbitrary-file-read routes.
    ///
    /// They are the reason a read-only server is not automatically safe to
    /// expose: refusing every non-read COMMAND says nothing about them, and they
    /// read anything the server process can, anywhere on the disk.
    #[tokio::test]
    async fn a_read_only_server_refuses_the_file_routes() {
        let state = Arc::new(AppState::new().with_read_only(true));
        let app = api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(state);

        for uri in ["/api/file?path=/etc/hosts", "/api/browse/etc/hosts"] {
            let request = Request::get(uri)
                .header("host", "localhost:9000")
                .header("sec-fetch-site", "same-origin")
                .body(Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
        }
    }

    /// ...and a normal server still serves them, so the guard above is the
    /// read-only flag talking and not a route that stopped working.
    #[tokio::test]
    async fn a_writable_server_still_serves_the_file_routes() {
        let request = Request::get("/api/file?path=/etc/hosts")
            .header("host", "localhost:9000")
            .header("sec-fetch-site", "same-origin")
            .body(Body::empty())
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_ne!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_page_on_another_origin_cannot_post_a_command() {
        for (origin, site) in [
            ("https://evil.example", "cross-site"),
            ("http://localhost:3000", "same-site"),
            ("null", "cross-site"),
        ] {
            let response = app().oneshot(forged_command(origin, site)).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
            assert!(response
                .headers()
                .get("access-control-allow-origin")
                .is_none());
        }
    }

    #[tokio::test]
    async fn a_page_on_another_origin_cannot_read_a_file() {
        let request = Request::get("/api/file?path=/etc/hosts")
            .header("host", "localhost:9000")
            .header("sec-fetch-site", "cross-site")
            .body(Body::empty())
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn the_app_itself_reaches_the_handler() {
        // An empty body gets past the guard and is refused by the handler's
        // decoder — a 400, not the guard's 403.
        let request = Request::post("/commands")
            .header("host", "localhost:9000")
            .header("origin", "http://localhost:9000")
            .header("sec-fetch-site", "same-origin")
            .body(Body::empty())
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_session_name_that_would_split_the_command_line_is_refused() {
        for request in [
            Request::get("/events?session=x%0Arun-shell%20id").body(Body::empty()),
            Request::post("/commands?session=x%0Arun-shell%20id").body(Body::empty()),
        ] {
            let mut request = request.unwrap();
            request.headers_mut().insert(
                "host",
                axum::http::HeaderValue::from_static("localhost:9000"),
            );
            let response = app().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    /// Every API route, paired with a concrete URL to probe it with. The
    /// enumeration test below asserts this table names exactly the routes
    /// `api_routes` declares — no more, no fewer.
    const COVERED_ROUTES: &[(&str, &str)] = &[
        ("/events", "/events"),
        ("/commands", "/commands"),
        ("/trace", "/trace"),
        ("/api/file", "/api/file?path=/etc/hosts"),
        ("/api/browse/{*path}", "/api/browse/etc/hosts"),
        ("/api/images/{pane_id}/{image_id}", "/api/images/1/0"),
    ];

    /// A request for `route` in the shape a page on another origin sends one.
    fn cross_origin_request_for(route: &str) -> Option<Request<Body>> {
        let (_, target) = COVERED_ROUTES.iter().find(|(name, _)| *name == route)?;
        let builder = if route == "/commands" || route == "/trace" {
            Request::post(*target)
        } else {
            Request::get(*target)
        };
        Some(
            builder
                .header("host", "localhost:9000")
                .header("origin", "https://evil.example")
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .unwrap(),
        )
    }

    /// The route table as `api_routes` declares it, read out of this file's
    /// own source.
    ///
    /// The guard is a `.layer()` at the end of `api_routes`, and a layer only
    /// covers the routes declared before it. A route added below that line —
    /// or a whole new route nobody thought to test — is served with no origin
    /// check at all, which on this API means a remote shell. So the routes are
    /// enumerated rather than listed by hand: a new one that the coverage
    /// table below does not know about fails this test by name.
    fn declared_routes() -> Vec<String> {
        let source = include_str!("state.rs");
        let start = source
            .find("pub fn api_routes")
            .expect("api_routes moved out of state.rs");
        let body = &source[start..];
        let end = body.find("\n}\n").expect("api_routes has no end");
        let body = &body[..end];

        // The literal is split so this scan does not find itself.
        let needle = concat!(".", "route(");
        let mut routes = Vec::new();
        let mut rest = body;
        while let Some(idx) = rest.find(needle) {
            rest = rest[idx + needle.len()..].trim_start();
            let rest_after_quote = rest
                .strip_prefix('"')
                .expect("a route's path is not a string literal");
            let close = rest_after_quote
                .find('"')
                .expect("unterminated route literal");
            routes.push(rest_after_quote[..close].to_string());
            rest = &rest_after_quote[close..];
        }
        assert!(!routes.is_empty(), "found no routes in api_routes");
        routes
    }

    #[tokio::test]
    async fn every_route_the_router_declares_is_behind_the_guard() {
        let declared: std::collections::BTreeSet<String> = declared_routes().into_iter().collect();
        let covered: std::collections::BTreeSet<String> = COVERED_ROUTES
            .iter()
            .map(|(name, _)| (*name).to_string())
            .collect();
        assert_eq!(
            declared, covered,
            "the route table and COVERED_ROUTES disagree. A route added to api_routes must be \
             probed here, or it ships with nobody having checked the guard reaches it."
        );

        for route in declared {
            let request = cross_origin_request_for(&route).unwrap_or_else(|| {
                panic!(
                    "route {route} is new and not covered by the guard test. \
                     Add it to `cross_origin_request_for` so a page on another \
                     origin is proven unable to reach it."
                )
            });
            let response = app().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "route {route} answered a cross-origin request — it is declared after the guard layer, or outside api_routes"
            );
        }
    }

    #[tokio::test]
    async fn every_route_refuses_a_rebound_host_on_a_loopback_bind() {
        // DNS rebinding: the page looks same-origin to the browser, but the
        // Host header still carries the attacker's own domain.
        for route in declared_routes() {
            let mut request = cross_origin_request_for(&route).expect("covered above");
            let headers = request.headers_mut();
            headers.insert(
                "host",
                axum::http::HeaderValue::from_static("attacker.example:9000"),
            );
            headers.insert(
                "origin",
                axum::http::HeaderValue::from_static("http://attacker.example:9000"),
            );
            headers.insert(
                "sec-fetch-site",
                axum::http::HeaderValue::from_static("same-origin"),
            );
            let response = app().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "route {route} served a rebound domain"
            );
        }
    }

    /// Blocking the buttons in the UI is not enforcement: a viewer can POST
    /// whatever it likes. Every write must be refused by the server.
    #[tokio::test]
    async fn a_read_only_server_refuses_keystrokes_and_resizes() {
        let state = Arc::new(AppState::new().with_read_only(true));
        let app = api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(state);
        for body in [
            // Typing into a pane — the write a viewer most obviously wants.
            r#"{"cmd":"run_tmux_command","args":{"command":"send-keys -t %1 'rm -rf ~' Enter"}}"#,
            r#"{"cmd":"run_tmux_command","args":{"command":"send-keys -l x"}}"#,
            // A read-shaped tmux command still rides the same channel, and
            // nothing here can tell a read from a write.
            r#"{"cmd":"query_tmux","args":{"command":"list-panes"}}"#,
            // Resizing changes the session under whoever is writing in it.
            r#"{"cmd":"set_client_size","args":{"cols":10,"rows":5}}"#,
            // Anything that writes a tmux option.
            r#"{"cmd":"set_theme","args":{"name":"nord"}}"#,
            r#"{"cmd":"set_theme_mode","args":{"mode":"dark"}}"#,
            r#"{"cmd":"set_trace_enabled","args":{"enabled":true}}"#,
        ] {
            let response = app
                .clone()
                .oneshot(same_origin_command(body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{body}");
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["error"], "read-only server", "{body}");
        }
    }

    /// The image route takes a pane id and an image id straight from the URL.
    /// They index an in-memory map, never the filesystem — a traversal-shaped
    /// id must come back empty rather than serving a file.
    #[tokio::test]
    async fn the_image_route_never_reads_from_disk() {
        for target in [
            "/api/images/..%2F..%2F..%2Fetc%2Fhosts/0",
            "/api/images/%2Fetc%2Fpasswd/0",
            "/api/images/1/0",
        ] {
            let request = Request::get(target)
                .header("host", "localhost:9000")
                .body(Body::empty())
                .unwrap();
            let response = app().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{target} did not 404"
            );
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["error"], "image not found", "{target}");
        }
    }

    /// The trace ingest writes to a file on this machine, so its body is
    /// capped. Without the cap one request fills the disk.
    #[tokio::test]
    async fn an_oversized_trace_body_is_refused_before_it_is_read() {
        let oversized = "x".repeat(300 * 1024);
        let request = Request::post("/trace")
            .header("host", "localhost:9000")
            .header("origin", "http://localhost:9000")
            .header("sec-fetch-site", "same-origin")
            .body(Body::from(oversized))
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
