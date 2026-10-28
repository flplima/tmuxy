use axum::{
    routing::{get, post},
    Router,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tmuxy_core::client_size::SizePolicy;
use tmuxy_core::control_mode::MonitorCommandSender;
use tmuxy_core::transport::ImageStore;
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::request_guard::HostPolicy;

mod handlers;
pub(crate) use handlers::build_response;
pub use handlers::find_workspace_root;
use handlers::image_handler;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

/// Number of recent broadcast messages retained per session for
/// `Last-Event-Id` replay and lagged-subscriber recovery. A power of two, so
/// it is exactly the broadcast channel's capacity (tokio rounds that up) and a
/// client that lags by up to a full buffer recovers from the ring without a
/// refetch; a larger gap reaches the client as a jump in delta seqs, which its
/// sequencer answers with a full-state refetch (S2 in `docs/INVARIANTS.md`).
pub const EVENT_BUFFER_SIZE: usize = 128;

/// The most bytes of serialized events the ring keeps per session.
///
/// A state delta carries the full content of every pane it changed — about
/// 230 KB of JSON for one coloured 200x50 screen — so 128 of them after a
/// burst of output held hundreds of MB, and kept holding it until 128 newer
/// events pushed it out, which an idle session never sends. Past this budget
/// the oldest events go first; a client resuming from before what is left
/// gets a full state instead, the same as one that fell behind the count.
pub const EVENT_BUFFER_MAX_BYTES: usize = 16 * 1024 * 1024;

/// A broadcast message tagged with its monotonic per-session sequence id.
/// The id is mirrored as the SSE `id:` field so the browser persists it
/// across reconnects via the `Last-Event-Id` request header.
type TaggedEvent = (u64, String);

/// Wraps a `broadcast::Sender` with the monotonic `seq` counter and the
/// recent-events ring buffer needed for `Last-Event-Id` resync.
///
/// All fields are sync-friendly so `SseEmitter` (whose trait methods are
/// non-async) can `broadcast()` without awaiting. The `StdMutex` is held
/// briefly to push to a small VecDeque; contention on it is negligible.
pub struct SessionBroadcast {
    /// Tokio broadcast channel — each subscribed client gets its own
    /// `EVENT_BUFFER_SIZE`-message lag buffer here. The capacity matches the
    /// ring exactly (tokio rounds a channel's capacity up to a power of two,
    /// so the constant is one) so a client that hit `RecvError::Lagged` is
    /// served from `recent` everything the channel still had (the SSE
    /// handler's `Lagged` arm calls `replay_since`); a ring smaller than the
    /// channel would drop, on every lag, events the channel still held.
    pub tx: broadcast::Sender<TaggedEvent>,
    /// Monotonic per-session counter — `fetch_add(1)` produces the next id.
    /// Ids start at 1: the stream handler keeps "the last seq I sent" as a
    /// plain number whose 0 means "nothing yet", so an id of 0 would be the
    /// one event every fresh subscriber drops.
    pub seq: AtomicU64,
    /// Ring buffer of the most recent `EVENT_BUFFER_SIZE` tagged messages,
    /// within `EVENT_BUFFER_MAX_BYTES`.
    /// Front = oldest, back = newest. Used to resume a client that
    /// reconnected with a `Last-Event-Id` header.
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

    /// Broadcast a payload to every subscriber and store it in the ring buffer.
    /// Returns the sequence id assigned to this message.
    ///
    /// The id is taken, the ring written and the channel sent under the one
    /// lock: the monitor and the initial-sync task broadcast concurrently, and
    /// `replay_since` and `oldest_seq` read the ring as sorted (S1 in
    /// `docs/INVARIANTS.md`). An id taken before the lock could be pushed
    /// after a higher one.
    pub fn broadcast(&self, payload: String) -> u64 {
        let Ok(mut buf) = self.recent.lock() else {
            // A poisoned ring is a panicked broadcaster; the stream must go on.
            let id = self.seq.fetch_add(1, Ordering::SeqCst);
            let _ = self.tx.send((id, payload));
            return id;
        };
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let entry: TaggedEvent = (id, payload);
        if buf.len() == EVENT_BUFFER_SIZE {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
        // The newest event always stays, however large: it is the one a
        // lagging receiver is most likely to need.
        let mut bytes: usize = buf.iter().map(|(_, payload)| payload.len()).sum();
        while bytes > EVENT_BUFFER_MAX_BYTES && buf.len() > 1 {
            if let Some((_, oldest)) = buf.pop_front() {
                bytes -= oldest.len();
            }
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

/// Tracks connections and shared resources for a single tmux session
pub struct SessionConnections {
    /// All connection IDs in order of connection time
    pub connections: Vec<u64>,
    /// Each client's reported viewport size (cols, rows), what `size_policy`
    /// picks the session's size from
    pub client_sizes: HashMap<u64, (u32, u32)>,
    /// `@tmuxy-size`, as the config last said it
    pub size_policy: SizePolicy,
    /// The client that was used last (a command or a size report): whose
    /// viewport a `latest` session takes
    pub latest_client: Option<u64>,
    /// Last resize dimensions sent to tmux (to avoid redundant resize commands)
    pub last_resize: Option<(u32, u32)>,
    /// Sender for commands to the session's monitor (resize, etc.)
    pub monitor_command_tx: Option<MonitorCommandSender>,
    /// The autosave for this session's snapshots (`session_snapshot`), told
    /// of every shape change by the emitter; `None` until the monitor is up.
    pub snapshot_keeper: Option<Arc<tmuxy_core::session_snapshot::SnapshotKeeper>>,
    /// The bindings the session's monitor last broadcast: what a new stream
    /// is greeted with, at no tmux round trip.
    pub key_bindings: Option<tmuxy_core::transport::KeyBindings>,
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
            size_policy: SizePolicy::default(),
            latest_client: None,
            last_resize: None,
            monitor_command_tx: None,
            snapshot_keeper: None,
            key_bindings: None,
            broadcast: Arc::new(SessionBroadcast::new()),
            monitor_handle: None,
        }
    }
}

impl SessionConnections {
    pub fn new() -> Self {
        Self::default()
    }

    /// The size the session should be, by its `@tmuxy-size` policy over the
    /// clients' viewports. `None` while no client has reported one and the
    /// size is not fixed.
    pub fn size(&self) -> Option<(u32, u32)> {
        let latest = self
            .latest_client
            .and_then(|id| self.client_sizes.get(&id).copied());
        self.size_policy
            .resolve(self.client_sizes.values().copied(), latest)
    }
}

pub struct AppState {
    /// Per-session connection tracking
    pub sessions: RwLock<HashMap<String, SessionConnections>>,
    /// Counter for generating unique connection IDs
    pub next_conn_id: AtomicU64,
    /// Pictures decoded out of pane output, served by `/api/images`.
    pub image_store: RwLock<ImageStore>,
    /// Structured shutdown: every background task spawned by the server lives
    /// in this `JoinSet`. `server::shutdown_signal` calls
    /// `join_set.shutdown().await` after firing `shutdown.cancel()` so we drain
    /// to completion instead of leaking orphans on Ctrl+C.
    pub join_set: Mutex<JoinSet<()>>,
    /// Cancellation token broadcast to every spawned task. Each task should
    /// `tokio::select!` against `shutdown.cancelled()` so it exits its
    /// long-running loop promptly.
    pub shutdown: CancellationToken,

    /// Live `/events` streams, across every session.
    ///
    /// SEC-16: each one is a long-lived task holding a broadcast receiver and a
    /// place in the `sessions` map, and nothing counted them. A connection
    /// flood grew both without bound.
    pub live_streams: AtomicU64,

    /// The pages `preview` panes frame, staged by the client and served to
    /// the pane's frame by `/api/preview/{pane}` (`tmuxy_core::preview`).
    pub preview_pages: tmuxy_core::preview::PreviewPages,
}

/// A live `/events` stream's place in the server's budget, released on drop.
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
            image_store: RwLock::new(ImageStore::default()),
            join_set: Mutex::new(JoinSet::new()),
            shutdown: CancellationToken::new(),
            live_streams: AtomicU64::new(0),
            preview_pages: tmuxy_core::preview::PreviewPages::default(),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The most `/events` streams this server serves at once.
    ///
    /// Generous for real use — a browser opens one per tab, and tmuxy is not a
    /// broadcast service — and far below the point where the tasks and their
    /// buffers are the problem.
    pub fn max_live_streams(&self) -> u64 {
        32
    }

    /// Claim a slot for a new `/events` stream, or `None` when full.
    ///
    /// The returned guard releases the slot when dropped, which is what the
    /// stream generator being dropped on client disconnect does.
    pub fn claim_stream_slot(self: &Arc<Self>) -> Option<StreamSlot> {
        let limit = self.max_live_streams();
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

    /// The session's monitor command channel, or the error a client is
    /// answered with while its monitor is not connected.
    pub async fn monitor_tx(
        &self,
        session: &str,
    ) -> Result<MonitorCommandSender, tmuxy_core::CommandError> {
        self.sessions
            .read()
            .await
            .get(session)
            .and_then(|s| s.monitor_command_tx.clone())
            .ok_or_else(|| tmuxy_core::CommandError::unavailable("No monitor connection available"))
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
        .route("/api/images/{pane_id}/{image_id}", get(image_handler))
        // Client trace ingest (docs/TRACING.md). Capped at 256 KiB/request so a
        // hostile client can't exhaust the disk in one call; the handler also
        // fails closed when tracing is off.
        .route(
            "/trace",
            post(crate::sse::trace_handler).layer(axum::extract::DefaultBodyLimit::max(256 * 1024)),
        )
        // A `preview` pane's page: POSTed by the client once it has composed
        // it, then loaded by the pane's frame (`tmuxy_core::preview`).
        .route(
            "/api/preview/{pane_id}",
            get(crate::sse::preview_page_handler)
                .post(crate::sse::stage_preview_handler)
                .layer(axum::extract::DefaultBodyLimit::max(
                    tmuxy_core::preview::MAX_STAGED_BYTES,
                )),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(host_policy),
            crate::request_guard::require_same_origin,
        ))
}

// ============================================
// Internal Handlers
// ============================================

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod broadcast_tests {
    use super::*;

    /// S1: ids count up from 1 — 0 is what a stream that has sent nothing
    /// remembers, and an id equal to it would never be delivered.
    #[test]
    fn seqs_are_monotonic_from_one() {
        let b = SessionBroadcast::new();
        assert_eq!(b.broadcast("a".into()), 1);
        assert_eq!(b.broadcast("b".into()), 2);
        assert_eq!(b.broadcast("c".into()), 3);
    }

    #[test]
    fn replay_since_returns_strictly_newer() {
        let b = SessionBroadcast::new();
        for i in 1..=5 {
            b.broadcast(format!("m{}", i));
        }
        let replay = b.replay_since(3);
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0].0, 4);
        assert_eq!(replay[0].1, "m4");
        assert_eq!(replay[1].0, 5);
        assert_eq!(replay[1].1, "m5");
    }

    #[test]
    fn ring_buffer_drops_oldest_at_capacity() {
        let b = SessionBroadcast::new();
        for i in 1..=(EVENT_BUFFER_SIZE + 5) {
            b.broadcast(format!("m{}", i));
        }
        assert_eq!(b.oldest_seq(), Some(6));
        let replay = b.replay_since(5);
        assert_eq!(replay.len(), EVENT_BUFFER_SIZE);
        assert_eq!(replay[0].0, 6);
    }

    /// S1: the ring is sorted and gap-free however many threads broadcast at
    /// once — the monitor and the initial-sync task do. A stress run, not an
    /// exhaustive one: the threads are released together and the run is
    /// repeated, which makes the old interleaving (a seq taken, then the ring
    /// written under a separate lock) likely rather than certain to show.
    /// What makes it impossible is `broadcast` taking the seq and writing the
    /// ring under one lock, which review has to hold.
    #[test]
    fn concurrent_broadcasters_keep_the_ring_in_order() {
        let per_thread = EVENT_BUFFER_SIZE / 4;
        for _round in 0..25 {
            let b = std::sync::Arc::new(SessionBroadcast::new());
            let gate = std::sync::Arc::new(std::sync::Barrier::new(4));
            let threads: Vec<_> = (0..4)
                .map(|t| {
                    let b = std::sync::Arc::clone(&b);
                    let gate = std::sync::Arc::clone(&gate);
                    std::thread::spawn(move || {
                        gate.wait();
                        for i in 0..per_thread {
                            b.broadcast(format!("t{t}-{i}"));
                        }
                    })
                })
                .collect();
            for t in threads {
                t.join().unwrap();
            }
            let seqs: Vec<u64> = b.replay_since(0).into_iter().map(|(s, _)| s).collect();
            let expected: Vec<u64> = (1..=(4 * per_thread) as u64).collect();
            assert_eq!(seqs, expected, "the ring is out of order or has a gap");
        }
    }

    /// A burst of large deltas does not stay in memory for want of newer
    /// events: past the byte budget the oldest go, and a client resuming from
    /// before them is told the ring cannot serve it (`oldest_seq` moved on).
    #[test]
    fn the_ring_keeps_no_more_than_its_byte_budget() {
        let b = SessionBroadcast::new();
        let big = "x".repeat(EVENT_BUFFER_MAX_BYTES / 2 - 1);
        for _ in 0..4 {
            b.broadcast(big.clone());
        }
        let kept = b.replay_since(0);
        assert_eq!(kept.len(), 2, "two half-budget events fit, four do not");
        assert_eq!(b.oldest_seq(), Some(3));
        assert_eq!(kept.iter().map(|(s, _)| *s).collect::<Vec<_>>(), [3, 4]);

        // One event over the whole budget is still kept, alone.
        b.broadcast("y".repeat(EVENT_BUFFER_MAX_BYTES + 1));
        assert_eq!(b.replay_since(0).len(), 1);
        assert_eq!(b.oldest_seq(), Some(5));
    }

    #[test]
    fn oldest_seq_is_none_when_empty() {
        let b = SessionBroadcast::new();
        assert_eq!(b.oldest_seq(), None);
    }
}
