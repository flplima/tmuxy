//! Host start-up and shut-down, written once: what every host runs beside
//! the sessions it serves. A host supplies only [`Sessions`], the runtimes it
//! serves now, and runs the returned work however it runs its background work.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use super::bindings::watch_config;
use super::{socket_watch, SessionRuntime};

/// The sessions a host serves.
pub trait Sessions: Send + Sync + 'static {
    /// Every runtime the host serves now.
    fn runtimes(&self) -> impl Future<Output = Vec<Arc<SessionRuntime>>> + Send;
}

pub struct Started<F> {
    /// Every pane on the socket, read once for everything that follows them
    /// (the agent-dialog correction, the web's push).
    pub panes: socket_watch::Rows,
    /// The socket watch and the config watch, until dropped: a saved
    /// stylesheet is announced to every client, a saved `tmuxy.conf` sourced
    /// into every session.
    pub background: F,
}

/// Start the trace (gated per docs/TRACING.md: `trace` is the `--trace`
/// flag, `dev` a dev build), and hand back the background work.
pub fn start<S: Sessions>(
    sessions: Arc<S>,
    trace: Option<Option<String>>,
    dev: bool,
) -> Started<impl Future<Output = ()> + Send + 'static> {
    crate::trace::init(trace, dev);
    let (panes_tx, panes) = socket_watch::channel();
    let background = async move {
        let config = watch_config(move |change| {
            let sessions = Arc::clone(&sessions);
            tokio::spawn(async move {
                for runtime in sessions.runtimes().await {
                    runtime.config_changed(change).await;
                }
            });
        });
        tokio::join!(socket_watch::run(panes_tx), config);
    };
    Started { panes, background }
}

/// How long the last snapshot of a session may take before shutting down
/// goes on without it.
pub const FINAL_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);

/// The last snapshot of every session, before the host goes down: a graceful
/// shutdown is the common way a machine goes down, and the autosave's
/// debounce may be holding the final change.
pub async fn save_final_snapshots<S: Sessions>(sessions: &S) {
    for runtime in sessions.runtimes().await {
        runtime.save_snapshot_now(FINAL_SNAPSHOT_TIMEOUT).await;
    }
}
