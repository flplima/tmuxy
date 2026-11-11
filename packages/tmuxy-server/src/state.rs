use axum::{
    routing::{get, post, MethodRouter},
    Router,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tmuxy_core::host::{HostEvent, RuntimeConfig, SessionRuntime, Sink};
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::request_guard::HostPolicy;

mod handlers;
pub(crate) use handlers::build_response;
use handlers::image_handler;

#[cfg(test)]
mod broadcast_tests;
#[cfg(test)]
mod tests;

/// A power of two, so it is exactly the broadcast channel's capacity (tokio
/// rounds that up) and a client that lags by up to a full channel recovers
/// from the ring without a refetch (S2 in `docs/INVARIANTS.md`). A ring
/// smaller than the channel would drop, on every lag, events the channel
/// still held.
pub const EVENT_BUFFER_SIZE: usize = 128;

/// A state delta carries the full content of every pane it changed — about
/// 230 KB of JSON for one coloured 200x50 screen — so a ring bounded by count
/// alone held hundreds of MB after a burst of output, until newer events
/// pushed it out, which an idle session never sends.
pub const EVENT_BUFFER_MAX_BYTES: usize = 16 * 1024 * 1024;

/// The SSE `event:` and `data:` fields.
#[derive(Debug, Clone)]
pub struct Frame {
    pub name: &'static str,
    pub data: Arc<str>,
}

impl Frame {
    /// The frame a stream sends for `event`; `None`, logged, when it does not
    /// serialise.
    pub fn of(event: &HostEvent) -> Option<Self> {
        match serde_json::to_string(event) {
            Ok(data) => Some(Self {
                name: event.name(),
                data: data.into(),
            }),
            Err(e) => {
                tracing::error!(error = %e, event = event.name(), "failed to serialize an event");
                None
            }
        }
    }
}

/// A broadcast frame tagged with its monotonic per-session sequence id.
/// The id is mirrored as the SSE `id:` field so the browser persists it
/// across reconnects via the `Last-Event-Id` request header.
type TaggedEvent = (u64, Frame);

/// Sync throughout, so `Sink::emit` (not async) can broadcast without
/// awaiting.
pub struct SessionBroadcast {
    pub tx: broadcast::Sender<TaggedEvent>,
    /// Starts at 1: the stream handler keeps "the last seq I sent" as a
    /// plain number whose 0 means "nothing yet", so an id of 0 would be the
    /// one event every fresh subscriber drops.
    pub seq: AtomicU64,
    pub recent: StdMutex<VecDeque<TaggedEvent>>,
}

impl SessionBroadcast {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        Self {
            tx,
            seq: AtomicU64::new(1),
            recent: StdMutex::new(VecDeque::with_capacity(EVENT_BUFFER_SIZE)),
        }
    }

    /// Broadcast an event to every subscriber, as its frame. `None` when it
    /// could not be serialised (logged): one dropped event rather than a
    /// crashed monitor.
    pub fn send(&self, event: &HostEvent) -> Option<u64> {
        Frame::of(event).map(|frame| self.broadcast_frame(frame))
    }

    /// A frame of `payload` under `name`, for the tests that broadcast
    /// their own.
    #[cfg(test)]
    pub fn broadcast(&self, name: &'static str, payload: String) -> u64 {
        self.broadcast_frame(Frame {
            name,
            data: Arc::from(payload),
        })
    }

    /// The id is taken, the ring written and the channel sent under the one
    /// lock: the monitor and the initial-sync task broadcast concurrently, and
    /// `replay_since` and `oldest_seq` read the ring as sorted (S1 in
    /// `docs/INVARIANTS.md`). An id taken before the lock could be pushed
    /// after a higher one.
    fn broadcast_frame(&self, frame: Frame) -> u64 {
        let Ok(mut buf) = self.recent.lock() else {
            // A poisoned ring is a panicked broadcaster; the stream must go on.
            let id = self.seq.fetch_add(1, Ordering::SeqCst);
            let _ = self.tx.send((id, frame));
            return id;
        };
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let entry: TaggedEvent = (id, frame);
        if buf.len() == EVENT_BUFFER_SIZE {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
        // The newest event always stays, however large: it is the one a
        // lagging receiver is most likely to need.
        let mut bytes: usize = buf.iter().map(|(_, frame)| frame.data.len()).sum();
        while bytes > EVENT_BUFFER_MAX_BYTES && buf.len() > 1 {
            if let Some((_, oldest)) = buf.pop_front() {
                bytes -= oldest.data.len();
            }
        }
        let _ = self.tx.send(entry);
        id
    }

    pub fn replay_since(&self, since: u64) -> Vec<TaggedEvent> {
        match self.recent.lock() {
            Ok(buf) => buf.iter().filter(|(s, _)| *s > since).cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn oldest_seq(&self) -> Option<u64> {
        self.recent
            .lock()
            .ok()
            .and_then(|b| b.front().map(|(s, _)| *s))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TaggedEvent> {
        self.tx.subscribe()
    }
}

impl Default for SessionBroadcast {
    fn default() -> Self {
        Self::new()
    }
}

struct BroadcastSink(Arc<SessionBroadcast>);

impl Sink for BroadcastSink {
    fn emit(&self, event: HostEvent) {
        self.0.send(&event);
    }
}

pub struct SessionConnections {
    pub connections: Vec<u64>,
    /// Which idle guard is current. A guard captures the value when it is
    /// scheduled and acts only if it still matches when it fires: a client
    /// that registered in between bumped it, so the guard it outran (the
    /// 5 s one from session creation, say, firing inside a reload's 2 s
    /// grace) leaves the session alone.
    pub idle_guard_gen: u64,
    /// `Arc` so the runtime's sink can broadcast without holding the
    /// `sessions` write lock.
    pub broadcast: Arc<SessionBroadcast>,
    pub runtime: Arc<SessionRuntime>,
    pub monitor_handle: Option<JoinHandle<()>>,
    /// Until when an agent on `/mcp` keeps the monitor up with no stream
    /// open. An agent holds no connection between calls, so without this an
    /// idle guard would stop the monitor between two of them and the next
    /// call would wait for a fresh attach.
    pub agent_hold_until: Option<tokio::time::Instant>,
}

impl SessionConnections {
    pub fn new(session: &str, state: &AppState) -> Self {
        let broadcast = Arc::new(SessionBroadcast::new());
        let runtime = SessionRuntime::new(
            RuntimeConfig {
                session: session.to_string(),
                preview: Arc::clone(&state.preview_pages),
                preview_scope: session.to_string(),
                restore: state.restore,
            },
            Arc::new(BroadcastSink(Arc::clone(&broadcast))),
        );
        Self {
            connections: Vec::new(),
            idle_guard_gen: 0,
            broadcast,
            runtime,
            monitor_handle: None,
            agent_hold_until: None,
        }
    }

    /// A client's stream opened: it is watching from now on, and any idle
    /// guard scheduled before it arrived is stale.
    pub fn register(&mut self, conn_id: u64) {
        self.connections.push(conn_id);
        self.idle_guard_gen += 1;
    }

    /// The other half of [`Self::register`].
    pub fn unregister(&mut self, conn_id: u64) {
        self.connections.retain(|&id| id != conn_id);
    }

    pub fn monitored(&self) -> bool {
        self.monitor_handle
            .as_ref()
            .is_some_and(|h| !h.is_finished())
    }

    pub fn agent_hold_remaining(&self, now: tokio::time::Instant) -> Option<std::time::Duration> {
        self.agent_hold_until
            .filter(|until| *until > now)
            .map(|until| until - now)
    }
}

/// Generous for real use — a browser opens one per tab, and tmuxy is not a
/// broadcast service — and far below the point where the tasks and their
/// buffers are the problem.
pub const MAX_LIVE_STREAMS: u64 = 32;

pub struct AppState {
    pub sessions: RwLock<HashMap<String, SessionConnections>>,
    pub next_conn_id: AtomicU64,
    /// Each stream's gate, by connection id, which runs the commands its
    /// client numbered in that order (S7 in `docs/INVARIANTS.md`). Kept for
    /// `GATE_GRACE` after the stream closes.
    pub command_gates: std::sync::Mutex<HashMap<u64, Arc<crate::sse::CommandGate>>>,
    pub join_set: Mutex<JoinSet<()>>,
    pub shutdown: CancellationToken,

    /// Each stream is a long-lived task holding a broadcast receiver and a
    /// place in the `sessions` map: uncounted, a connection flood grows both
    /// without bound.
    pub live_streams: AtomicU64,

    pub preview_pages: Arc<tmuxy_core::preview::PreviewPages>,

    /// Whether a session this server creates is rebuilt from its snapshot
    /// (off for `--no-restore`).
    pub restore: bool,

    /// Serialises explicit session creation (`ensure_session`) so concurrent
    /// requests cannot race past `MAX_AUTO_CREATED_SESSIONS`.
    pub session_create_lock: Mutex<()>,

    pub mcp_clients: crate::mcp::Clients,

    pub push: crate::push::Push,
}

pub struct StreamSlot {
    state: Arc<AppState>,
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        self.state.live_streams.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            command_gates: std::sync::Mutex::default(),
            join_set: Mutex::new(JoinSet::new()),
            shutdown: CancellationToken::new(),
            live_streams: AtomicU64::new(0),
            preview_pages: Arc::default(),
            restore: true,
            session_create_lock: Mutex::new(()),
            mcp_clients: crate::mcp::Clients::default(),
            push: crate::push::Push::default(),
        }
    }
}

impl tmuxy_core::host::Sessions for AppState {
    async fn runtimes(&self) -> Vec<Arc<tmuxy_core::host::SessionRuntime>> {
        self.sessions
            .read()
            .await
            .values()
            .map(|conns| Arc::clone(&conns.runtime))
            .collect()
    }
}

impl AppState {
    pub fn claim_stream_slot(self: &Arc<Self>) -> Option<StreamSlot> {
        let limit = MAX_LIVE_STREAMS;
        let mut current = self.live_streams.load(Ordering::SeqCst);
        loop {
            if current >= limit {
                return None;
            }
            match self.live_streams.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return Some(StreamSlot {
                        state: Arc::clone(self),
                    })
                }
                Err(actual) => current = actual,
            }
        }
    }

    pub async fn runtime(&self, session: &str) -> Option<Arc<SessionRuntime>> {
        self.sessions
            .read()
            .await
            .get(session)
            .map(|conns| Arc::clone(&conns.runtime))
    }

    /// The session's monitor command channel, waiting for a monitor that is
    /// still connecting (`SessionRuntime::channel`), or the error a client is
    /// answered with when the server does not watch the session.
    pub async fn monitor_tx(
        &self,
        session: &str,
    ) -> Result<tmuxy_core::control_mode::MonitorCommandSender, tmuxy_core::CommandError> {
        match self.runtime(session).await {
            Some(runtime) => runtime.channel().await,
            None => Err(tmuxy_core::CommandError::unavailable(
                "No monitor connection available",
            )),
        }
    }

    fn gates(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<crate::sse::CommandGate>>> {
        // A map of handles, valid whatever panicked holding it.
        self.command_gates
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A stream opened under `conn_id`: its numbered commands are ordered
    /// from now on.
    pub fn open_command_gate(&self, conn_id: u64) {
        self.gates().insert(conn_id, Arc::default());
    }

    pub fn command_gate(&self, conn_id: u64) -> Option<Arc<crate::sse::CommandGate>> {
        self.gates().get(&conn_id).cloned()
    }

    pub fn close_command_gate(&self, conn_id: u64) {
        self.gates().remove(&conn_id);
    }

    /// Into the `JoinSet` shutdown drains. A long-running task selects on
    /// `self.shutdown.cancelled()` so it exits promptly.
    pub async fn spawn<F>(&self, fut: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.join_set.lock().await.spawn(fut);
    }
}

/// Every route of the API, by path. [`api_routes`] puts each one behind the
/// guard, and the guard tests probe each path listed here.
fn api_route_table() -> Vec<(&'static str, MethodRouter<Arc<AppState>>)> {
    vec![
        ("/events", get(crate::sse::sse_handler)),
        ("/commands", post(crate::sse::commands_handler)),
        ("/api/images/{pane_id}/{image_id}", get(image_handler)),
        ("/trace", post(crate::sse::trace_handler)),
        ("/mcp", post(crate::mcp::mcp_handler)),
        ("/api/push", get(crate::push::key_handler)),
        (
            "/api/push/subscription",
            post(crate::push::subscribe_handler).delete(crate::push::unsubscribe_handler),
        ),
        (
            "/api/preview/{pane_id}",
            get(crate::sse::preview_page_handler).post(crate::sse::stage_preview_handler),
        ),
    ]
}

/// The caller adds the frontend as `.fallback_service(...)`, and
/// `.with_state(state)`.
///
/// Every route answers only the app itself: `host_policy` says which `Host`
/// names count as this server (see `request_guard`). No CORS headers are sent,
/// so no other origin can read a response either.
pub fn api_routes(host_policy: HostPolicy) -> Router<Arc<AppState>> {
    api_route_table()
        .into_iter()
        .fold(Router::new(), |router, (path, method)| {
            router.route(path, method)
        })
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(host_policy),
            crate::request_guard::require_same_origin,
        ))
}

// ============================================
// Internal Handlers
// ============================================
