use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::host::session_exists;
use tmuxy_core::session::SessionName;
use tracing::{debug, info, warn};

use super::{start_monitoring, SessionRejection, MAX_AUTO_CREATED_SESSIONS};
use crate::state::{AppState, SessionConnections};

/// Start `session`'s monitor unless one is running, `create`-ing the tmux
/// session when it is missing. One place, for the stream that attaches and
/// for `ensure_session`.
pub(super) fn ensure_monitor(
    state: &Arc<AppState>,
    session: &str,
    conns: &mut SessionConnections,
    create: bool,
) {
    if conns.monitored() {
        return;
    }
    if conns.monitor_handle.take().is_some() {
        warn!(%session, "monitor died, restarting");
    }
    let monitor_session = session.to_string();
    let monitor_state = Arc::clone(state);
    let runtime = Arc::clone(&conns.runtime);
    // A command that arrives before the loop's first attempt waits for it.
    runtime.set_connecting();
    // Plain `tokio::spawn` (not the `AppState` JoinSet): the `JoinHandle` is
    // kept on `SessionConnections` so the deferred-cleanup path can shut down
    // just one session. On server Ctrl+C `start_monitoring`'s own
    // cancellation checks end its loop.
    conns.monitor_handle = Some(tokio::spawn(async move {
        start_monitoring(runtime, monitor_session, monitor_state, create).await;
    }));
    info!(%session, create, "started monitor");
}

/// Explicitly ensure `session` exists (and has a running monitor), enforcing
/// [`MAX_AUTO_CREATED_SESSIONS`] atomically under `state.session_create_lock`.
pub(super) async fn ensure_session(
    state: &Arc<AppState>,
    session: &str,
) -> Result<(), SessionRejection> {
    let _guard = state.session_create_lock.lock().await;

    if state
        .sessions
        .read()
        .await
        .get(session)
        .is_some_and(SessionConnections::monitored)
    {
        return Ok(());
    }

    let exists_in_tmux = session_exists(session).await;
    if !exists_in_tmux {
        let mut known: HashSet<String> =
            tokio::task::spawn_blocking(tmuxy_core::session::session_names)
                .await
                .unwrap_or_default()
                .into_iter()
                .collect();
        known.extend(state.sessions.read().await.keys().cloned());
        if !known.contains(session) && known.len() >= MAX_AUTO_CREATED_SESSIONS {
            warn!(
                target: "tmuxy_server::sse",
                %session,
                limit = MAX_AUTO_CREATED_SESSIONS,
                "refused session creation: the server already has as many sessions as it creates"
            );
            return Err(SessionRejection::TooMany);
        }
    }

    let needs_idle_guard = {
        let mut sessions = state.sessions.write().await;
        let conns = sessions
            .entry(session.to_string())
            .or_insert_with(|| SessionConnections::new(session, state));
        ensure_monitor(state, session, conns, !exists_in_tmux);
        conns.connections.is_empty()
    };

    if needs_idle_guard {
        schedule_idle_monitor_cleanup(state, session, Duration::from_secs(5)).await;
    }
    Ok(())
}

/// How long an agent on `/mcp` keeps a session's monitor up after its last
/// call when no browser is watching. Long enough for an agent that thinks
/// between calls, short enough that one that went away stops holding a
/// control-mode client open.
pub(crate) const AGENT_HOLD: Duration = Duration::from_secs(5 * 60);

/// The monitor of a session an agent asked about, attaching one when no
/// client has, and holding it for [`AGENT_HOLD`] from now. A session that does
/// not exist is never created for an agent: it drives the session the user
/// is looking at, and a typo would otherwise leave a stray one behind.
pub(crate) async fn monitor_for_agent(
    state: &Arc<AppState>,
    session: &SessionName,
) -> Result<tmuxy_core::control_mode::MonitorCommandSender, tmuxy_core::CommandError> {
    let running = state
        .sessions
        .read()
        .await
        .get(session.as_str())
        .is_some_and(SessionConnections::monitored);
    if !running {
        if !session_exists(session).await {
            return Err(tmuxy_core::CommandError::invalid(format!(
                "no tmux session named {session:?} (pass ?session=<name> in the endpoint URL)"
            )));
        }
        ensure_session(state, session)
            .await
            .map_err(|rejection| tmuxy_core::CommandError::unavailable(rejection.message()))?;
    }
    hold_for_agent(state, session).await;
    state.monitor_tx(session).await
}

/// An agent called: the session's monitor stays up for [`AGENT_HOLD`] from now.
pub(crate) async fn hold_for_agent(state: &Arc<AppState>, session: &str) {
    if let Some(conns) = state.sessions.write().await.get_mut(session) {
        conns.agent_hold_until = Some(tokio::time::Instant::now() + AGENT_HOLD);
    }
}

/// The viewport size a freshly created window should be resized to, or `None`
/// when there is none yet (no client has reported one and the size is not
/// fixed).
pub(crate) async fn new_window_client_size(
    state: &Arc<AppState>,
    session: &str,
) -> Option<(u32, u32)> {
    state
        .runtime(session)
        .await
        .and_then(|runtime| runtime.size())
}

/// The client a request names by its `X-Connection-Id`, when it is one of
/// the session's open streams. Without an id one caller's viewport cannot be
/// told from another's, and a size kept for an id no stream owns would never
/// be removed: it would pin the session's size for every real client until
/// they all left.
pub(super) async fn open_client(
    state: &Arc<AppState>,
    session: &str,
    conn_id: Option<u64>,
) -> Option<u64> {
    let conn_id = conn_id?;
    let open = state
        .sessions
        .read()
        .await
        .get(session)
        .is_some_and(|conns| conns.connections.contains(&conn_id));
    if !open {
        warn!(%session, conn_id, "ignoring a client with no open stream");
    }
    open.then_some(conn_id)
}

/// Remove a connection and resize tmux to the clients still watching
pub(super) async fn cleanup_connection(state: &Arc<AppState>, session: &str, conn_id: u64) {
    let (runtime, last_left) = {
        let mut sessions = state.sessions.write().await;
        let Some(conns) = sessions.get_mut(session) else {
            return;
        };
        conns.connections.retain(|&id| id != conn_id);
        (Arc::clone(&conns.runtime), conns.connections.is_empty())
    };
    runtime.client_left(conn_id).await;
    if last_left {
        // Not stopped at once: a page reload reconnects within a few seconds.
        info!(%session, "last client disconnected, deferring monitor cleanup (2s grace period)");
        schedule_idle_monitor_cleanup(state, session, Duration::from_secs(2)).await;
    }
}

/// How long a stopped monitor is given to detach before it is left to finish
/// on its own.
const MONITOR_STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// Wait `grace`, and if `session` still has no attached SSE connections, shut
/// down its monitor and remove its map entry. A client that registers during
/// the wait retires the guard (`SessionConnections::register`): the guard
/// scheduled when that client leaves again is the one that counts, so a
/// reload inside an older guard's grace is not cut short by it. An agent's
/// hold (`SessionConnections::agent_hold_until`) is waited out the same way.
pub(super) async fn schedule_idle_monitor_cleanup(
    state: &Arc<AppState>,
    session: &str,
    grace: Duration,
) {
    let state_owned = state.clone();
    let session = session.to_string();
    let shutdown = state.shutdown.clone();
    let generation = {
        let mut sessions = state.sessions.write().await;
        let Some(session_conns) = sessions.get_mut(&session) else {
            return;
        };
        session_conns.idle_guard_gen += 1;
        session_conns.idle_guard_gen
    };
    state
        .spawn(async move {
            let state = state_owned;
            let mut grace = grace;
            // An agent's hold (`agent_hold_until`) outlasting the grace sends
            // the guard back to sleep for what is left of it: the hold is
            // extended by every call, and this guard is the one that ends it.
            let stopped = loop {
                tokio::select! {
                    _ = tokio::time::sleep(grace) => {}
                    _ = shutdown.cancelled() => {
                        debug!(%session, "shutdown signalled during grace period, aborting cleanup");
                        return;
                    }
                }
                let mut sessions = state.sessions.write().await;
                let Some(session_conns) = sessions.get_mut(&session) else {
                    break None;
                };
                if session_conns.idle_guard_gen != generation {
                    debug!(%session, "a client came and went during grace period, leaving it to the newer guard");
                    break None;
                }
                if !session_conns.connections.is_empty() {
                    debug!(%session, "client connected during grace period, keeping monitor alive");
                    break None;
                }
                if let Some(left) = session_conns.agent_hold_remaining(tokio::time::Instant::now()) {
                    debug!(%session, ?left, "an agent still holds the monitor, waiting for it");
                    grace = left;
                    continue;
                }
                info!(%session, "no clients connected after grace period, stopping monitor");
                break sessions.remove(&session);
            };

            let Some(conns) = stopped else { return };
            let Some(handle) = conns.monitor_handle else {
                return;
            };
            if handle.is_finished() {
                debug!("monitor task already finished (session was killed)");
                return;
            }
            info!("sending graceful shutdown to monitor");
            conns.runtime.shut_down_connection().await;
            match tokio::time::timeout(MONITOR_STOP_TIMEOUT, handle).await {
                Ok(_) => debug!("monitor task finished gracefully"),
                Err(_) => warn!("monitor task still running after graceful shutdown (not aborting)"),
            }
        })
        .await;
}
