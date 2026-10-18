use super::*;
use tmuxy_core::control_mode::MonitorCommand;

/// A live stream must end when the server shuts down. While it did not,
/// axum's graceful shutdown waited on every open tab, so a server with a
/// browser attached never exited on SIGTERM and the next one could not
/// take its port.
#[tokio::test]
async fn open_stream_ends_when_the_server_shuts_down() {
    let state = Arc::new(AppState::new());
    {
        let mut conns = SessionConnections::new();
        // A handle that never finishes, so the handler does not start a
        // real tmux monitor for this session.
        conns.monitor_handle = Some(tokio::spawn(std::future::pending::<()>()));
        state.sessions.write().await.insert("s".to_string(), conns);
    }

    let response = sse_handler(
        State(Arc::clone(&state)),
        Query(SessionQuery {
            session: Some("s".to_string()),
        }),
        HeaderMap::new(),
    )
    .await;

    let body = response.into_body();
    let drained = tokio::spawn(async move { axum::body::to_bytes(body, usize::MAX).await });

    // The stream is live: it is still open a moment later.
    tokio::task::yield_now().await;
    assert!(!drained.is_finished(), "the stream ended before shutdown");

    state.shutdown.cancel();

    let bytes = tokio::time::timeout(std::time::Duration::from_secs(5), drained)
        .await
        .expect("the stream never ended after shutdown was signalled")
        .expect("the drain task panicked")
        .expect("the body failed to drain");
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("event: connection-info"),
        "the stream should have served its prologue, got: {text}"
    );
}

/// S2: a client that subscribed before the session's first broadcast gets
/// that broadcast. The live loop dedupes against "the last seq replayed",
/// kept as a number whose 0 means none — which is exactly the id the first
/// event used to carry, so the first event of every session was dropped
/// for every subscriber the ring had not served.
#[tokio::test]
async fn the_first_broadcast_reaches_a_client_that_subscribed_before_it() {
    use futures_util::StreamExt;

    let state = Arc::new(AppState::new());
    let broadcast = {
        let mut conns = SessionConnections::new();
        conns.monitor_handle = Some(tokio::spawn(std::future::pending::<()>()));
        let broadcast = Arc::clone(&conns.broadcast);
        state.sessions.write().await.insert("s".to_string(), conns);
        broadcast
    };

    let response = sse_handler(
        State(Arc::clone(&state)),
        Query(SessionQuery {
            session: Some("s".to_string()),
        }),
        HeaderMap::new(),
    )
    .await;
    let mut body = response.into_body().into_data_stream();
    // The prologue (connection-info) is served before the live loop
    // subscribes; read past it so the broadcasts below are live ones.
    let mut text = String::new();
    while !text.contains("event: connection-info") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the prologue never arrived")
            .expect("the stream ended during its prologue")
            .expect("the body failed");
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    tokio::task::yield_now().await;

    let first = broadcast.broadcast("{\"type\":\"first\"}".to_string());
    let second = broadcast.broadcast("{\"type\":\"second\"}".to_string());
    while !text.contains(&format!("id: {second}")) {
        let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the second broadcast never arrived")
            .expect("the stream ended before the second broadcast")
            .expect("the body failed");
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(
        text.contains(&format!("id: {first}")),
        "the first broadcast (seq {first}) was dropped: {text}"
    );
    state.shutdown.cancel();
}

/// S2, through the handler: a client whose stream is not read while the
/// session broadcasts more than the ring holds is served, once it reads,
/// everything the ring still has — once each, in order — and nothing it
/// could not have: no id below the ring's oldest, no repeat where the
/// replay and the resumed channel overlap.
#[tokio::test]
async fn a_lagged_stream_is_served_the_ring_tail_once_in_order() {
    use futures_util::StreamExt;

    let state = Arc::new(AppState::new());
    let broadcast = {
        let mut conns = SessionConnections::new();
        conns.monitor_handle = Some(tokio::spawn(std::future::pending::<()>()));
        let broadcast = Arc::clone(&conns.broadcast);
        state.sessions.write().await.insert("s".to_string(), conns);
        broadcast
    };

    // The handler subscribes before it returns; the body is not read
    // until the session has outrun the channel and the ring.
    let response = sse_handler(
        State(Arc::clone(&state)),
        Query(SessionQuery {
            session: Some("s".to_string()),
        }),
        HeaderMap::new(),
    )
    .await;
    let mut newest = 0;
    for i in 0..(crate::state::EVENT_BUFFER_SIZE + 50) {
        newest = broadcast.broadcast(format!("{{\"type\":\"m{i}\"}}"));
    }
    let oldest = broadcast.oldest_seq().unwrap();

    let mut body = response.into_body().into_data_stream();
    let mut text = String::new();
    while !text.contains(&format!("id: {newest}\n")) {
        let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the newest broadcast never arrived")
            .expect("the stream ended before the newest broadcast")
            .expect("the body failed");
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    let ids: Vec<u64> = text
        .lines()
        .filter_map(|line| line.strip_prefix("id: "))
        .map(|id| id.parse().unwrap())
        .collect();
    let expected: Vec<u64> = (oldest..=newest).collect();
    assert_eq!(ids, expected, "the lagged stream served: {ids:?}");
    state.shutdown.cancel();
}

/// The SSE `event:` name must be the variant's own serde tag. An
/// allowlist here once silently relabelled `detached` and
/// `theme-settings` as `state-update`, and the client's listeners for
/// them never fired.
#[test]
fn every_frames_sse_name_is_its_own_serde_tag() {
    let names: Vec<String> = super::protocol_fixtures::every_other_sse_event()
        .iter()
        .map(|e| {
            let payload = encode_event(e).unwrap();
            let tag = serde_json::from_str::<serde_json::Value>(&payload).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(
                sse_event_type(&payload),
                tag,
                "an SSE frame lost its own name on the way to the browser"
            );
            tag
        })
        .collect();
    assert!(names.contains(&"detached".to_string()));
    assert!(names.contains(&"theme-settings".to_string()));
    // No two variants may share a name, or one of them is unroutable.
    let unique: std::collections::HashSet<&String> = names.iter().collect();
    assert_eq!(
        unique.len(),
        names.len(),
        "duplicate SSE event names: {names:?}"
    );
}

// ============================================
// Command Error Tests
// ============================================

/// POST `body` to `/commands` for `session` and return the status and the
/// decoded body.
async fn post(
    state: &Arc<AppState>,
    session: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = commands_handler(
        State(Arc::clone(state)),
        Query(SessionQuery {
            session: session.map(str::to_string),
        }),
        HeaderMap::new(),
        axum::body::Bytes::from(body.to_string()),
    )
    .await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// A session whose monitor answers every query with tmux's `%error`.
async fn session_where_tmux_refuses(state: &Arc<AppState>, session: &str) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::RunCommandWithReply { reply, .. } = cmd {
                let _ = reply.send(tmuxy_core::control_mode::CommandReply {
                    output: String::new(),
                    error: Some("can't find pane: %99".to_string()),
                });
            }
        }
    });
    let mut conns = SessionConnections::new();
    conns.monitor_command_tx = Some(tx);
    state
        .sessions
        .write()
        .await
        .insert(session.to_string(), conns);
}

fn assert_failure(
    (status, body): (StatusCode, serde_json::Value),
    want_status: StatusCode,
    kind: &str,
) {
    assert_eq!(status, want_status, "{body}");
    assert_eq!(body["kind"], kind, "{body}");
    assert!(
        body["error"].as_str().is_some_and(|e| !e.is_empty()),
        "{body}"
    );
    assert_eq!(body.as_object().unwrap().len(), 2, "{body}");
}

#[tokio::test]
async fn tmux_rejecting_a_query_is_kind_tmux() {
    let state = Arc::new(AppState::new());
    session_where_tmux_refuses(&state, "s").await;
    let (status, body) = post(
        &state,
        Some("s"),
        serde_json::json!({ "cmd": "query_tmux", "args": { "command": "display -p -t %99 x" } }),
    )
    .await;
    assert_failure((status, body.clone()), StatusCode::BAD_REQUEST, "tmux");
    assert_eq!(body["error"], "can't find pane: %99");
}

#[tokio::test]
async fn no_monitor_is_kind_unavailable() {
    let state = Arc::new(AppState::new());
    assert_failure(
        post(
            &state,
            Some("s"),
            serde_json::json!({ "cmd": "query_tmux", "args": { "command": "list-panes" } }),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "unavailable",
    );
}

#[tokio::test]
async fn a_malformed_payload_or_argument_is_kind_invalid() {
    let state = Arc::new(AppState::new());
    assert_failure(
        post(
            &state,
            Some("s"),
            serde_json::json!({ "cmd": "no_such_command" }),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid",
    );
    // A pane id that is not one is refused at the door.
    assert_failure(
        post(
            &state,
            Some("s"),
            serde_json::json!({ "cmd": "get_scrollback_cells", "args": { "paneId": "{last}" } }),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid",
    );
    assert_failure(
        post(
            &state,
            Some("a;b"),
            serde_json::json!({ "cmd": "get_themes_list" }),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid",
    );
}

#[tokio::test]
async fn a_read_only_server_or_a_blocked_query_is_kind_forbidden() {
    let viewer = Arc::new(AppState::new().with_read_only(true));
    assert_failure(
        post(
            &viewer,
            Some("s"),
            serde_json::json!({ "cmd": "run_tmux_command", "args": { "command": "kill-server" } }),
        )
        .await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );

    let state = Arc::new(AppState::new());
    session_where_tmux_refuses(&state, "s").await;
    assert_failure(
        post(
            &state,
            Some("s"),
            serde_json::json!({ "cmd": "query_tmux", "args": { "command": "resizew -x 10" } }),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "forbidden",
    );
}

#[tokio::test]
async fn a_session_this_server_does_not_serve_is_kind_unavailable() {
    let pinned = Arc::new(AppState::new().with_session_pin(Some("mine".into())));
    assert_failure(
        post(
            &pinned,
            Some("other"),
            serde_json::json!({ "cmd": "get_themes_list" }),
        )
        .await,
        StatusCode::NOT_FOUND,
        "unavailable",
    );
}

#[tokio::test]
async fn success_is_still_a_bare_result() {
    let state = Arc::new(AppState::new());
    let (status, body) = post(
        &state,
        Some("s"),
        serde_json::json!({ "cmd": "get_themes_list" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["result"].is_array(), "{body}");
    assert!(body.get("error").is_none());
}
