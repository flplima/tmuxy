mod clients;
mod commands;
mod emitter;
mod monitor;
mod preview;
mod server_commands;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use serde::Deserialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::session::SessionName;
use tmuxy_core::CommandError;
use tokio::sync::broadcast;
use tracing::{debug, info, trace, warn};

#[cfg(test)]
use crate::command::ClientCommand;
use crate::state::{AppState, SessionConnections};

pub use commands::{commands_handler, trace_handler};
pub use emitter::watch_config_dir;
pub use monitor::start_monitoring;
pub use preview::{preview_page_handler, stage_preview_handler};

use clients::cleanup_connection;
#[cfg(test)]
use clients::{note_client_activity, set_client_size, set_size_policy};
use commands::command_failure;
#[cfg(test)]
use commands::{handle_command, CommandResponse};
use emitter::{encode_event, sse_event_type, SseEvent};
#[cfg(test)]
use emitter::{refresh_keybindings, SseEmitter};

// ============================================
// Query Parameters
// ============================================

#[derive(Debug, Deserialize)]
pub struct SessionQuery {
    session: Option<String>,
}

/// A `?session=` the server will not serve.
#[derive(Debug)]
enum SessionRejection {
    /// A name the server will not write into a command line; a 400.
    Invalid,
    /// A session that does not exist, when the server already has as many as
    /// it will create on its own; a 503.
    TooMany,
}

impl SessionRejection {
    fn status(&self) -> StatusCode {
        match self {
            Self::Invalid => StatusCode::BAD_REQUEST,
            Self::TooMany => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid session name",
            Self::TooMany => "too many sessions to create another",
        }
    }

    /// The same refusal for `POST /commands`, in its error shape.
    fn into_command_failure(self) -> Response {
        let error = match self {
            Self::Invalid | Self::TooMany => CommandError::invalid(self.message()),
        };
        command_failure(self.status(), error)
    }
}

/// How many tmux sessions may exist before `GET /events` stops creating the
/// one it names. A stream for a session that does not exist has its monitor
/// create it, and that session and its shell outlive the stream — so a client
/// cycling through names, one open stream at a time, could fill the machine
/// with sessions nothing watches. A person switching sessions makes them one
/// at a time and never nears this; a script that needs more creates them
/// itself with `new-session` through `POST /commands`.
pub const MAX_AUTO_CREATED_SESSIONS: usize = 32;

/// Whether a stream may have a session created for it, given how many the
/// server already has.
fn may_create_session(existing: usize) -> bool {
    existing < MAX_AUTO_CREATED_SESSIONS
}

impl IntoResponse for SessionRejection {
    fn into_response(self) -> Response {
        (self.status(), format!("{}\n", self.message())).into_response()
    }
}

impl SessionQuery {
    /// The session the request names — the default one when it names none.
    /// The name is written into control-mode command lines, where a newline
    /// (or any control character) would end the command and start another.
    fn session(self) -> Result<SessionName, SessionRejection> {
        let session = self
            .session
            .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());
        SessionName::parse(&session).ok_or(SessionRejection::Invalid)
    }
}

// ============================================
// SSE Handler (GET /events)
// ============================================

/// Whether the ring buffer can resume a reconnecting client without a gap.
///
/// `last_event_id` is the `Last-Event-Id` header the browser replays;
/// `oldest` is the lowest seq still buffered. The client needs everything
/// strictly after `last_event_id`, so the buffer serves it only when it still
/// holds that event's successor. A client that fell further behind than the
/// buffer is resynced with a full snapshot instead — serving it a partial
/// replay would leave the UI silently diverged from tmux.
fn can_replay_from(last_event_id: Option<u64>, oldest: Option<u64>) -> bool {
    match (last_event_id, oldest) {
        (Some(last), Some(oldest)) => last >= oldest.saturating_sub(1),
        _ => false,
    }
}

pub async fn sse_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
    headers: HeaderMap,
) -> Response {
    let session = match query.session() {
        Ok(session) => session,
        Err(rejection) => return rejection.into_response(),
    };

    // SEC-16: one long-lived task and one broadcast receiver per stream, with
    // nothing counting them. The slot is released when the stream generator is
    // dropped, which is what a client disconnecting does.
    let Some(stream_slot) = state.claim_stream_slot() else {
        tracing::warn!(
            target: "tmuxy_server::sse",
            %session,
            limit = state.max_live_streams(),
            "refused an /events stream: already serving the maximum"
        );
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "too many open event streams\n",
        )
            .into_response();
    };

    // Browser passes the id of the last event it received via the standard
    // `Last-Event-Id` header on reconnect. If we can find it in the per-session
    // ring buffer, we replay the missing events. If the id is older than the
    // buffer head (or absent), the live stream takes over from the next event.
    let last_event_id: Option<u64> = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // A session the server is not already serving may be one the monitor
    // would have to create; see `MAX_AUTO_CREATED_SESSIONS`. Read-only tmux
    // calls, and only on that path: a stream for a known session pays nothing.
    let unknown_here = !state.sessions.read().await.contains_key(session.as_str());
    if unknown_here
        && !clients::session_exists(&session).await
        && !may_create_session(clients::session_count().await)
    {
        tracing::warn!(
            target: "tmuxy_server::sse",
            %session,
            limit = MAX_AUTO_CREATED_SESSIONS,
            "refused an /events stream: the server already has as many sessions as it creates"
        );
        return SessionRejection::TooMany.into_response();
    }
    let session = session.into_string();

    // Generate unique connection ID
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::SeqCst);

    // Session creation is handled by TmuxMonitor::connect() with create_session=true.
    // It spawns `tmux -CC new-session -s <name>` which safely creates a new session
    // with its own control mode connection, without routing through an existing monitor
    // (which would trigger %session-changed and contaminate the original session's state).

    // Register connection and get/create shared session resources.
    let (session_rx, session_broadcast) = {
        let mut sessions = state.sessions.write().await;
        let session_conns = sessions
            .entry(session.clone())
            .or_insert_with(SessionConnections::new);

        session_conns.connections.push(conn_id);

        // Subscribe to shared session state channel
        let session_rx = session_conns.broadcast.subscribe();
        let session_broadcast = session_conns.broadcast.clone();

        // Start monitor if not already running, or restart if it died
        let needs_monitor = match &session_conns.monitor_handle {
            None => {
                debug!(%session, "no monitor handle yet");
                true
            }
            Some(handle) => {
                let finished = handle.is_finished();
                trace!(%session, finished, "monitor handle status");
                finished
            }
        };
        if needs_monitor {
            if session_conns.monitor_handle.is_some() {
                warn!(%session, "monitor died, restarting");
                session_conns.monitor_handle = None;
                session_conns.monitor_command_tx = None;
            }
            let monitor_session = session.clone();
            let monitor_state = state.clone();
            let monitor_broadcast = session_conns.broadcast.clone();
            // Plain `tokio::spawn` (not the `AppState` JoinSet): we keep the
            // `JoinHandle` on `SessionConnections` so the deferred-cleanup path
            // can poll `is_finished` / shut down just one session. On server
            // Ctrl+C the task isn't joined by `shutdown_signal`; instead
            // `start_monitoring`'s own `shutdown.is_cancelled()` checks break
            // its loop promptly.
            let handle = tokio::spawn(async move {
                start_monitoring(monitor_broadcast, monitor_session, monitor_state).await;
            });
            session_conns.monitor_handle = Some(handle);
            info!(%session, "started monitor");
        }

        (session_rx, session_broadcast)
    };

    // Create the SSE stream
    //
    // IMPORTANT: When the SSE client disconnects, Axum detects the broken connection
    // on the next keepalive write and DROPS the stream generator. The generator is
    // suspended at `session_rx.recv().await`, so any cleanup code after the loop
    // never executes. We use a oneshot channel: the sender lives inside the generator,
    // and when the generator is dropped, the sender is dropped, signaling the cleanup task.
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();

    // Spawn cleanup task that fires when the stream is dropped (client disconnect).
    // Tracked in `AppState::join_set` so server shutdown drains it instead of
    // leaving it dangling on Ctrl+C.
    {
        let cleanup_state = state.clone();
        let cleanup_session = session.clone();
        let shutdown = state.shutdown.clone();
        state
            .spawn(async move {
                tokio::select! {
                    _ = drop_rx => {
                        info!(conn_id, session = %cleanup_session, "client disconnected, running cleanup");
                        cleanup_connection(&cleanup_state, &cleanup_session, conn_id).await;
                    }
                    _ = shutdown.cancelled() => {
                        // Server shutting down — skip the cleanup chore; the
                        // monitor's own shutdown path will tear down the session.
                    }
                }
            })
            .await;
    }

    let stream_shutdown = state.shutdown.clone();
    let stream = async_stream::stream! {
        // Keep the drop sender alive for the lifetime of the stream.
        // When this generator is dropped (client disconnect), _drop_guard is dropped,
        // which drops drop_tx, signaling the cleanup task.
        let _drop_guard = drop_tx;
        // Same lifetime, same reason: the slot this stream occupies in the
        // server's budget is given back when the generator goes.
        let _stream_slot = stream_slot;

        // Send connection info as first event
        let default_shell = std::env::var("SHELL")
            .ok()
            .and_then(|s| s.rsplit('/').next().map(String::from))
            .unwrap_or_else(|| "bash".to_string());
        let conn_info = SseEvent::ConnectionInfo {
            connection_id: conn_id,
            default_shell,
            trace_enabled: tmuxy_core::trace::is_enabled(),
            hostname: crate::host_name(),
        };
        if let Some(s) = encode_event(&conn_info) {
            yield Ok::<_, std::convert::Infallible>(Event::default().event("connection-info").data(s));
        }

        // A reconnecting client's monitor sourced the config long ago, so the
        // bindings it last broadcast are the ones in force; a client that
        // got here before its monitor did is sent them by the monitor's
        // `on_initial_sync_complete`, on the broadcast it already holds.
        let known_bindings = state
            .sessions
            .read()
            .await
            .get(&session)
            .and_then(|conns| conns.key_bindings.clone());
        if let Some(s) = known_bindings.and_then(|kb| encode_event(&SseEvent::KeyBindings(kb))) {
            yield Ok(Event::default().event("keybindings").data(s));
        }

        let mut session_rx = session_rx;

        // Last-Event-Id replay: if the client reconnected with a known seq,
        // dump everything in the ring buffer above that seq before entering the
        // live loop. If the requested seq is older than the buffer head (or no
        // header at all), we can't fill the gap from cache alone — the live
        // stream just resumes from the next event, whose delta seq the
        // client's sequencer sees as a gap and answers with a refetch (S3 and
        // C1 in `docs/INVARIANTS.md`).
        // Only advance past events we actually replayed from the ring buffer.
        // Seeding this from a stale Last-Event-Id would make the live loop's
        // `seq <= last_replayed` dedupe drop every fresh event when the buffer
        // can't serve the gap (server restart resets the seq counter, or a
        // >buffer disconnect), freezing the UI.
        let mut last_replayed: u64 = 0;
        let buffer_can_serve = can_replay_from(last_event_id, session_broadcast.oldest_seq());
        if buffer_can_serve {
            let replay = session_broadcast.replay_since(last_event_id.unwrap_or(0));
            for (seq, msg) in replay {
                let event_type = sse_event_type(&msg);
                last_replayed = seq;
                yield Ok(Event::default()
                    .event(event_type)
                    .id(seq.to_string())
                    .data(msg));
            }
        }

        loop {
            tokio::select! {
                // End the stream when the server is shutting down. Without this
                // the generator only ends when the broadcast channel closes, so
                // an open tab holds the connection open and axum's graceful
                // shutdown waits on it forever.
                _ = stream_shutdown.cancelled() => {
                    info!(conn_id, "server shutting down, ending stream");
                    break;
                }
                // Handle session-specific state changes
                result = session_rx.recv() => {
                    match result {
                        Ok((seq, msg)) => {
                            // Dedupe against the replay window — broadcast subscription
                            // happens before we read the ring buffer, so the receiver
                            // may queue messages already yielded above.
                            if seq <= last_replayed {
                                continue;
                            }
                            last_replayed = seq;
                            let event_type = sse_event_type(&msg);
                            yield Ok(Event::default()
                                .event(event_type)
                                .id(seq.to_string())
                                .data(msg));
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // The subscriber fell behind and the channel dropped
                            // `n` messages. Replay whatever is still in the ring
                            // buffer above what we've already sent so the client
                            // recovers without waiting for the next full snapshot.
                            // If the gap exceeds the buffer, replay covers the
                            // buffered tail only: the client's sequencer sees the
                            // jump in delta seqs (it never reads these ids) and
                            // refetches a full state (C1 in `docs/INVARIANTS.md`);
                            // a lag that drops only other events is not seen by
                            // anything. The `seq <= last_replayed`
                            // dedup below absorbs any overlap with resumed
                            // delivery.
                            warn!(conn_id, lagged = n, "client lagged; replaying ring buffer");
                            for (seq, msg) in session_broadcast.replay_since(last_replayed) {
                                let event_type = sse_event_type(&msg);
                                last_replayed = seq;
                                yield Ok(Event::default()
                                    .event(event_type)
                                    .id(seq.to_string())
                                    .data(msg));
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
            }
        }
    };

    Sse::new(stream)
        // A named event rather than the default comment line: a page never sees
        // a comment, and the client times a silent link out by these (the
        // `ping` watchdog in HttpAdapter). An event with no data is dropped by
        // the browser before dispatch, hence the placeholder.
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(1))
                .event(Event::default().event("ping").data("1")),
        )
        .into_response()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod protocol_fixtures;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_errors;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_sessions;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_stream;
