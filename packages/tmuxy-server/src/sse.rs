mod clients;
mod commands;
mod monitor;
mod order;
mod preview;

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
use tracing::{info, warn};

use crate::state::{AppState, Frame, SessionConnections, MAX_LIVE_STREAMS};
#[cfg(test)]
use tmuxy_core::host::ClientCommand;

pub(crate) use commands::has_json_content_type;
pub use commands::{commands_handler, trace_handler};
pub use monitor::start_monitoring;
pub use order::CommandGate;
pub use preview::{preview_page_handler, stage_preview_handler};

use clients::cleanup_connection;
pub(crate) use clients::{hold_for_agent, monitor_for_agent, new_window_client_size};
use commands::command_failure;
#[cfg(test)]
use commands::handle_command;

fn sse_frame(seq: Option<u64>, frame: &Frame) -> Event {
    let event = Event::default().event(frame.name).data(&*frame.data);
    match seq {
        Some(seq) => event.id(seq.to_string()),
        None => event,
    }
}

#[derive(Debug, Deserialize)]
pub struct SessionQuery {
    session: Option<String>,
}

#[derive(Debug)]
pub(super) enum SessionRejection {
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

    pub(super) fn message(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid session name",
            Self::TooMany => "too many sessions to create another",
        }
    }

    pub(super) fn into_command_failure(self) -> Response {
        let error = match self {
            Self::Invalid | Self::TooMany => CommandError::invalid(self.message()),
        };
        command_failure(self.status(), error)
    }
}

/// How many tmux sessions may exist before `ensure_session` stops creating new
/// ones automatically. A newly created session and its shell outlive any single
/// request, so cycling through names could otherwise fill the machine with
/// unwatched sessions.
pub const MAX_AUTO_CREATED_SESSIONS: usize = 32;

impl IntoResponse for SessionRejection {
    fn into_response(self) -> Response {
        (self.status(), format!("{}\n", self.message())).into_response()
    }
}

impl SessionQuery {
    /// The name is written into control-mode command lines, where a newline
    /// (or any control character) would end the command and start another.
    fn session(self) -> Result<SessionName, SessionRejection> {
        let session = self
            .session
            .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());
        SessionName::parse(&session).ok_or(SessionRejection::Invalid)
    }
}

/// The buffer serves a reconnecting client only while it still holds the
/// successor of the browser's `Last-Event-Id`. A client further behind is
/// resynced with a full snapshot instead: a partial replay would leave the UI
/// silently diverged from tmux.
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

    // Each stream is a long-lived task and a broadcast receiver: uncounted, a
    // connection flood grows them without bound. The slot is released when
    // the stream generator is dropped, which is what a client disconnecting does.
    let Some(stream_slot) = state.claim_stream_slot() else {
        tracing::warn!(
            target: "tmuxy_server::sse",
            %session,
            limit = MAX_LIVE_STREAMS,
            "refused an /events stream: already serving the maximum"
        );
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "too many open event streams\n",
        )
            .into_response();
    };

    let last_event_id: Option<u64> = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // `GET /events` attaches only to an existing session; creating a missing
    // session requires an explicit `POST /commands` (`ensure_session`). One
    // this server has served before but whose monitor is gone may have been
    // killed since: it is asked about too, or a page reopening it got a
    // monitor that may not create it and kept "Connecting…" for ever.
    let monitored = state
        .sessions
        .read()
        .await
        .get(session.as_str())
        .is_some_and(SessionConnections::monitored);
    if !monitored && !tmuxy_core::host::session_exists(&session).await {
        return (StatusCode::NOT_FOUND, "session not found\n").into_response();
    }
    let session = session.into_string();

    let conn_id = state.next_conn_id.fetch_add(1, Ordering::SeqCst);

    // A stream never creates the session: only `ensure_session` does, under
    // its cap.
    let (session_rx, session_broadcast, runtime) = {
        let mut sessions = state.sessions.write().await;
        let conns = sessions
            .entry(session.clone())
            .or_insert_with(|| SessionConnections::new(&session, &state));
        conns.register(conn_id);
        clients::ensure_monitor(&state, &session, conns, false);
        (
            conns.broadcast.subscribe(),
            Arc::clone(&conns.broadcast),
            Arc::clone(&conns.runtime),
        )
    };

    // When the client disconnects, Axum DROPS the stream generator at the next
    // keepalive write, suspended at `recv().await`: code after its loop never
    // runs. The cleanup waits on this channel's sender, dropped with it.
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();

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
        let _drop_guard = drop_tx;
        let _stream_slot = stream_slot;

        // Who the client is, and — for a client reconnecting to a monitor
        // that sourced the config long ago — the bindings in force. A client
        // that got here before its monitor did is sent them by the initial
        // sync, on the broadcast it already holds.
        for frame in runtime.greeting(conn_id).iter().filter_map(Frame::of) {
            yield Ok::<_, std::convert::Infallible>(sse_frame(None, &frame));
        }

        let mut session_rx = session_rx;

        // A gap the ring cannot fill is left to the client's sequencer, which
        // sees it in the delta seqs and refetches (S3 and C1 in
        // `docs/INVARIANTS.md`). `last_replayed` only advances past events
        // actually replayed: seeded from a stale Last-Event-Id (a restarted
        // server's seqs start over) the dedupe below would drop every fresh
        // event and freeze the UI.
        let mut last_replayed: u64 = 0;
        let buffer_can_serve = can_replay_from(last_event_id, session_broadcast.oldest_seq());
        if buffer_can_serve {
            let replay = session_broadcast.replay_since(last_event_id.unwrap_or(0));
            for (seq, frame) in replay {
                last_replayed = seq;
                yield Ok(sse_frame(Some(seq), &frame));
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
                result = session_rx.recv() => {
                    match result {
                        Ok((seq, frame)) => {
                            // Dedupe against the replay window — broadcast subscription
                            // happens before we read the ring buffer, so the receiver
                            // may queue messages already yielded above.
                            if seq <= last_replayed {
                                continue;
                            }
                            last_replayed = seq;
                            yield Ok(sse_frame(Some(seq), &frame));
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // A gap past the ring is seen by the client's
                            // sequencer in the delta seqs (it never reads these
                            // ids), which refetches a full state (C1 in
                            // `docs/INVARIANTS.md`).
                            warn!(conn_id, lagged = n, "client lagged; replaying ring buffer");
                            for (seq, frame) in session_broadcast.replay_since(last_replayed) {
                                last_replayed = seq;
                                yield Ok(sse_frame(Some(seq), &frame));
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
        // `ping` watchdog in tmuxy-ui's httpStream.ts). An event with no data
        // is dropped by the browser before dispatch, hence the placeholder.
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(1))
                .event(Event::default().event("ping").data("1")),
        )
        .into_response()
}

#[cfg(test)]
mod tests_errors;
#[cfg(test)]
mod tests_lifecycle;
#[cfg(test)]
mod tests_order;
#[cfg(test)]
mod tests_sessions;
#[cfg(test)]
mod tests_stream;
