use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::client_size::SizePolicy;
use tmuxy_core::control_mode::{MonitorCommand, MonitorConfig};
use tmuxy_core::session::SessionName;
use tracing::{debug, info, instrument, trace, warn};

use crate::state::AppState;

/// `tmuxy_core::session::session_exists` off the async worker threads (it
/// runs a synchronous `has-session`, which would otherwise block a tokio
/// worker). Used by the monitor loop, before its own connection is attached.
/// A name outside the session alphabet names no session.
pub(super) async fn session_exists(session: &str) -> bool {
    let Some(name) = SessionName::parse(session) else {
        return false;
    };
    tokio::task::spawn_blocking(move || tmuxy_core::session::session_exists(&name).unwrap_or(false))
        .await
        .unwrap_or(false)
}

/// `tmuxy_core::session::session_count`, off the worker threads for the same
/// reason.
pub(super) async fn session_count() -> usize {
    tokio::task::spawn_blocking(tmuxy_core::session::session_count)
        .await
        .unwrap_or(0)
}

/// The monitor settings this server watches `session` with.
pub(super) fn monitor_config(session: &str) -> MonitorConfig {
    MonitorConfig {
        session: session.to_string(),
        create_session: true,
        working_dir: Some(crate::state::session_start_dir()),
        ..Default::default()
    }
}

/// The viewport size a freshly created window should be resized to, or `None`
/// when there is none yet (no client has reported one and the size is not
/// fixed). Feeds `executor`'s shared rewrite so the Tauri app and this server
/// can't drift on the rewrite shape.
pub(super) async fn new_window_client_size(
    state: &Arc<AppState>,
    session: &str,
) -> Option<(u32, u32)> {
    let sessions = state.sessions.read().await;
    sessions.get(session).and_then(|s| s.size())
}

/// Apply a client's viewport: record it, and size tmux by the session's
/// `@tmuxy-size` policy over every client watching. A report is a use of the
/// client when the size is new, so it is also the one a `latest` session
/// follows.
#[instrument(skip(state), fields(%session))]
pub(super) async fn set_client_size(
    state: &Arc<AppState>,
    session: &str,
    conn_id: Option<u64>,
    cols: u32,
    rows: u32,
) {
    // Without an id we cannot tell one caller's viewport from another's, and
    // guessing would corrupt the size computation for every real client.
    let Some(conn_id) = conn_id else {
        warn!(
            cols,
            rows, "ignoring client size without an x-connection-id header"
        );
        return;
    };
    let (cols, rows) = tmuxy_core::client_size::clamp_client_size(cols, rows);
    debug!(%session, conn_id, cols, rows, "client set size");
    {
        let mut sessions = state.sessions.write().await;
        let Some(session_conns) = sessions.get_mut(session) else {
            return;
        };
        // A size counts only for a stream that is open: nothing would ever
        // remove one for an id no stream owns, and it would pin the session's
        // size for every real client until they all left.
        if !session_conns.connections.contains(&conn_id) {
            warn!(%session, conn_id, "ignoring client size for a connection with no open stream");
            return;
        }
        // Only a new size is a use of the client. A client whose grid is not
        // its own size reports the same one again on every update, and
        // counting that made two clients take a `latest` session from each
        // other on every frame.
        let previous = session_conns.client_sizes.insert(conn_id, (cols, rows));
        if previous != Some((cols, rows)) {
            session_conns.latest_client = Some(conn_id);
        }
    }
    apply_session_size(state, session).await;
}

/// A client sent a command: it is the one used last. Under `latest` that
/// moves the session to its viewport.
pub(super) async fn note_client_activity(
    state: &Arc<AppState>,
    session: &str,
    conn_id: Option<u64>,
) {
    let Some(conn_id) = conn_id else { return };
    let moved = {
        let sessions = state.sessions.read().await;
        sessions
            .get(session)
            .is_some_and(|s| s.latest_client != Some(conn_id) && s.connections.contains(&conn_id))
    };
    if !moved {
        return;
    }
    let follow = {
        let mut sessions = state.sessions.write().await;
        let Some(session_conns) = sessions.get_mut(session) else {
            return;
        };
        session_conns.latest_client = Some(conn_id);
        session_conns.size_policy == SizePolicy::Latest
    };
    if follow {
        apply_session_size(state, session).await;
    }
}

/// The config was read: keep its `@tmuxy-size`, and resize when it changed.
pub(super) async fn set_size_policy(state: &Arc<AppState>, session: &str, policy: SizePolicy) {
    let changed = {
        let mut sessions = state.sessions.write().await;
        let Some(session_conns) = sessions.get_mut(session) else {
            return;
        };
        let changed = session_conns.size_policy != policy;
        session_conns.size_policy = policy;
        changed
    };
    if changed {
        debug!(%session, ?policy, "size policy changed");
        apply_session_size(state, session).await;
    }
}

/// Resize tmux to the size the session's policy picks, unless that is what
/// was sent last — which stops a feedback loop between clients of different
/// sizes. What reached tmux is remembered as `last_resize`, which is also
/// what a client's first state is held back for (`initial_state_for_size`).
pub(super) async fn apply_session_size(state: &Arc<AppState>, session: &str) {
    let (size, command_tx) = {
        let sessions = state.sessions.read().await;
        let Some(session_conns) = sessions.get(session) else {
            return;
        };
        let Some(size) = session_conns.size() else {
            return;
        };
        if session_conns.last_resize == Some(size) {
            return;
        }
        debug!(%session, sizes = ?session_conns.client_sizes, ?size, policy = ?session_conns.size_policy, "sizing session");
        // `last_resize` is NOT written here. It is the record of a size that
        // reached tmux, and it is only known below whether one did: a monitor
        // that has not registered its command channel yet means the resize is
        // dropped, and marking it applied made every later attempt
        // short-circuit on the check above — the client's size lost for the
        // life of the session, with the window left at the control-mode PTY's
        // 200x50 while the client drew 41 columns.
        (size, session_conns.monitor_command_tx.clone())
    };

    let (cols, rows) = size;
    let delivered = match command_tx {
        Some(tx) => match tx.send(MonitorCommand::ResizeWindow { cols, rows }).await {
            Ok(_) => {
                trace!("resize command sent via monitor");
                true
            }
            // The monitor has gone; the next one sizes the session from the
            // client sizes it is given, so this one is asked for again rather
            // than run behind its back.
            Err(e) => {
                warn!(error = %e, "monitor channel closed, resize not sent");
                false
            }
        },
        None => {
            // The monitor is still connecting. Leaving `last_resize` unset is
            // the whole point: the next client size — or the same one again —
            // has to be able to try, or this size never arrives.
            debug!("no monitor channel yet, leaving the size to be asked again");
            false
        }
    };
    if delivered {
        let mut sessions = state.sessions.write().await;
        if let Some(session_conns) = sessions.get_mut(session) {
            session_conns.last_resize = Some(size);
        }
    }
}

/// Remove a connection and resize tmux to the clients still watching
pub(super) async fn cleanup_connection(state: &Arc<AppState>, session: &str, conn_id: u64) {
    let (resize, needs_deferred_cleanup) = {
        let mut sessions = state.sessions.write().await;

        let mut resize = false;
        let mut deferred = false;

        if let Some(session_conns) = sessions.get_mut(session) {
            // Remove this connection
            session_conns.connections.retain(|&id| id != conn_id);
            let had_size = session_conns.client_sizes.remove(&conn_id).is_some();
            if session_conns.latest_client == Some(conn_id) {
                session_conns.latest_client = None;
            }

            if session_conns.connections.is_empty() {
                // Don't immediately kill the monitor — a page reload will reconnect
                // within a few seconds. Defer cleanup to give new clients a chance.
                info!(%session, "last client disconnected, deferring monitor cleanup (2s grace period)");
                deferred = true;
            } else {
                resize = had_size;
            }
        }

        (resize, deferred)
    };

    // Defer monitor cleanup: wait 2 seconds, then check if clients reconnected.
    // Tracked in `AppState::join_set` so the grace-period sleep doesn't survive
    // server shutdown. The grace period itself is a UX feature (page reload
    // reconnects within ~1s) — kept for that reason, not as orphan-prevention.
    if needs_deferred_cleanup {
        let state_owned = state.clone();
        let session = session.to_string();
        let shutdown = state.shutdown.clone();
        state
            .spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    _ = shutdown.cancelled() => {
                        debug!(%session, "shutdown signalled during grace period, aborting cleanup");
                        return;
                    }
                }
                let state = state_owned;

                let (cmd_tx, monitor_handle) = {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        if session_conns.connections.is_empty() {
                            // Still no clients after grace period — clean up for real
                            info!(%session, "no clients reconnected after grace period, stopping monitor");
                            let handle = session_conns.monitor_handle.take();
                            let tx = session_conns.monitor_command_tx.take();
                            sessions.remove(&session);
                            (tx, handle)
                        } else {
                            debug!(%session, "client reconnected during grace period, keeping monitor alive");
                            (None, None)
                        }
                    } else {
                        (None, None)
                    }
                };

                // Stop the monitor if cleanup proceeded
                if let Some(handle) = monitor_handle {
                    if handle.is_finished() {
                        debug!("monitor task already finished (session was killed)");
                    } else if let Some(ref tx) = cmd_tx {
                        info!("sending graceful shutdown to monitor");
                        let _ = tx.send(MonitorCommand::Shutdown).await;
                        // Poll for completion instead of fixed sleep
                        for _ in 0..20 {
                            if handle.is_finished() {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        if !handle.is_finished() {
                            warn!("monitor task still running after graceful shutdown (not aborting)");
                        } else {
                            debug!("monitor task finished gracefully");
                        }
                    }
                }
            })
            .await;
        return;
    }

    // Size the session to the clients still watching.
    if resize {
        apply_session_size(state, session).await;
    }
}
