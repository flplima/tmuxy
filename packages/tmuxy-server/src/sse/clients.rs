use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::control_mode::{MonitorCommand, MonitorConfig};
use tracing::{debug, info, instrument, trace, warn};

use crate::state::AppState;

/// `tmuxy_core::session::session_exists` off the async worker threads (it
/// runs a synchronous `has-session`, which would otherwise block a tokio
/// worker). Used by the monitor loop, before its own connection is attached.
pub(super) async fn session_exists(session: &str) -> bool {
    let session = session.to_string();
    tokio::task::spawn_blocking(move || {
        tmuxy_core::session::session_exists(&session).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// The monitor settings this server watches `session` with.
pub(super) fn monitor_config(session: &str) -> MonitorConfig {
    MonitorConfig {
        session: session.to_string(),
        create_session: true,
        working_dir: Some(crate::state::find_workspace_root()),
        ..Default::default()
    }
}

/// Compute the minimum (cols, rows) across all connected clients
pub(super) fn compute_min_client_size(sizes: &HashMap<u64, (u32, u32)>) -> (u32, u32) {
    let min_cols = sizes.values().map(|(c, _)| *c).min().unwrap_or(80);
    let min_rows = sizes.values().map(|(_, r)| *r).min().unwrap_or(24);
    (min_cols, min_rows)
}

/// The viewport size a freshly created window should be resized to, or `None`
/// when no client has reported one yet. Feeds `executor`'s shared rewrite so
/// the Tauri app and this server can't drift on the rewrite shape.
pub(super) async fn new_window_client_size(
    state: &Arc<AppState>,
    session: &str,
) -> Option<(u32, u32)> {
    let sessions = state.sessions.read().await;
    sessions.get(session).and_then(|s| {
        if s.client_sizes.is_empty() {
            None
        } else {
            Some(compute_min_client_size(&s.client_sizes))
        }
    })
}

/// Apply a client's viewport: record it, and resize tmux to the minimum across
/// every client watching. The resize is skipped when that minimum is what was
/// sent last, which stops a feedback loop between clients of different sizes.
/// What reached tmux is remembered as `last_resize`, which is also what a
/// client's first state is held back for (`initial_state_for_size`).
#[instrument(skip(state), fields(%session))]
pub(super) async fn set_client_size(
    state: &Arc<AppState>,
    session: &str,
    conn_id: Option<u64>,
    cols: u32,
    rows: u32,
) {
    // Without an id we cannot tell one caller's viewport from another's, and
    // guessing would corrupt the min-size computation for every real client.
    let Some(conn_id) = conn_id else {
        warn!(
            cols,
            rows, "ignoring client size without an x-connection-id header"
        );
        return;
    };
    debug!(%session, conn_id, cols, rows, "client set size");
    let (min_size, command_tx) = {
        let mut sessions = state.sessions.write().await;
        if let Some(session_conns) = sessions.get_mut(session) {
            session_conns.client_sizes.insert(conn_id, (cols, rows));
            let sizes = &session_conns.client_sizes;
            let min = compute_min_client_size(sizes);
            // Skip if the minimum size hasn't changed since the last resize
            if session_conns.last_resize == Some(min) {
                return;
            }
            debug!(%session, ?sizes, ?min, "all client sizes");
            // `last_resize` is NOT written here. It is the record of a size
            // that reached tmux, and it is only known below whether one did:
            // a monitor that has not registered its command channel yet means
            // the resize is dropped, and marking it applied made every later
            // attempt short-circuit on the check above — the client's size
            // lost for the life of the session, with the window left at the
            // control-mode PTY's 200x50 while the client drew 41 columns.
            (Some(min), session_conns.monitor_command_tx.clone())
        } else {
            (None, None)
        }
    };

    if let Some((min_cols, min_rows)) = min_size {
        debug!(min_cols, min_rows, "resizing to min");
        let delivered = match command_tx {
            Some(tx) => {
                match tx
                    .send(MonitorCommand::ResizeWindow {
                        cols: min_cols,
                        rows: min_rows,
                    })
                    .await
                {
                    Ok(_) => {
                        trace!("resize command sent via monitor");
                        true
                    }
                    // The monitor has gone; the next one sizes the session
                    // from the client sizes it is given, so this one is
                    // asked for again rather than run behind its back.
                    Err(e) => {
                        warn!(error = %e, "monitor channel closed, resize not sent");
                        false
                    }
                }
            }
            None => {
                // The monitor is still connecting. Leaving `last_resize` unset
                // is the whole point: the next client size — or the same one
                // again — has to be able to try, or this size never arrives.
                debug!("no monitor channel yet, leaving the size to be asked again");
                false
            }
        };
        if delivered {
            let mut sessions = state.sessions.write().await;
            if let Some(session_conns) = sessions.get_mut(session) {
                session_conns.last_resize = Some((min_cols, min_rows));
            }
        }
    }
}

/// Remove a connection and resize tmux to remaining clients' minimum viewport
pub(super) async fn cleanup_connection(state: &Arc<AppState>, session: &str, conn_id: u64) {
    let (resize_to, command_tx, needs_deferred_cleanup) = {
        let mut sessions = state.sessions.write().await;

        let mut resize = None;
        let mut cmd_tx = None;
        let mut deferred = false;

        if let Some(session_conns) = sessions.get_mut(session) {
            // Remove this connection
            session_conns.connections.retain(|&id| id != conn_id);
            let had_size = session_conns.client_sizes.remove(&conn_id).is_some();

            if session_conns.connections.is_empty() {
                // Don't immediately kill the monitor — a page reload will reconnect
                // within a few seconds. Defer cleanup to give new clients a chance.
                info!(%session, "last client disconnected, deferring monitor cleanup (2s grace period)");
                deferred = true;
            } else if had_size && !session_conns.client_sizes.is_empty() {
                // Recompute minimum size for remaining clients
                let new_min = compute_min_client_size(&session_conns.client_sizes);
                // Reset last_resize so the new min will be applied
                session_conns.last_resize = Some(new_min);
                resize = Some(new_min);
                cmd_tx = session_conns.monitor_command_tx.clone();
            }
        }

        (resize, cmd_tx, deferred)
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

    // Resize tmux session to new minimum viewport
    if let Some((min_cols, min_rows)) = resize_to {
        if let Some(tx) = command_tx {
            let _ = tx
                .send(MonitorCommand::ResizeWindow {
                    cols: min_cols,
                    rows: min_rows,
                })
                .await;
        }
    }
}
