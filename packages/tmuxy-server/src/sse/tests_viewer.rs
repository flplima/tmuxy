use super::*;
use std::sync::atomic::Ordering;
use tmuxy_core::control_mode::MonitorCommand;

/// A session whose "monitor" is a channel the test reads: it records the
/// resizes it is sent and drops every state request, so `get_initial_state`
/// fails fast once the sizing step — the part under test — has run.
pub(super) async fn session_with_fake_monitor(
    state: &Arc<AppState>,
    session: &str,
) -> Arc<tokio::sync::Mutex<Vec<(u32, u32)>>> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let resizes = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&resizes);
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::ResizeWindow { cols, rows } = cmd {
                seen.lock().await.push((cols, rows));
            }
        }
    });
    let mut conns = SessionConnections::new();
    conns.connections.push(1);
    conns.monitor_command_tx = Some(tx);
    state
        .sessions
        .write()
        .await
        .insert(session.to_string(), conns);
    resizes
}

/// `get_initial_state` carrying a viewport, dispatched the way the HTTP
/// layer dispatches it — by role. A viewer's server never reaches the
/// writable implementation at all, so asking it directly would prove
/// nothing about what a viewer can do.
pub(super) async fn initial_state_with_viewport(state: &Arc<AppState>) {
    let cmd = ClientCommand::GetInitialState {
        cols: Some(40),
        rows: Some(12),
    };
    // The fake monitor never answers with a state; only the sizing matters.
    if state.read_only {
        let _ = serve_viewer(cmd, "s", state).await;
    } else {
        let _ = handle_command(cmd, "s", state, Some(1)).await;
    }
}

fn query(name: Option<&str>) -> SessionQuery {
    SessionQuery {
        session: name.map(str::to_string),
    }
}

fn rejection_status(state: &AppState, name: Option<&str>) -> StatusCode {
    match query(name).session(state) {
        Ok(_) => StatusCode::OK,
        Err(rejection) => rejection.into_response().status(),
    }
}

/// SEC-12: the documented viewer setup is a `--read-only` server beside a
/// writer **on the same socket**, so a name the viewer picks used to hand
/// it any other session's screen.
#[test]
fn a_pinned_server_serves_its_own_session_and_no_other() {
    let state = AppState::new()
        .with_read_only(true)
        .with_session_pin(Some("shared".into()));
    assert_eq!(
        query(Some("shared")).session(&state).unwrap(),
        "shared".to_string()
    );
    assert_eq!(
        rejection_status(&state, Some("felipes-private-work")),
        StatusCode::NOT_FOUND
    );
    // A request naming nothing asks for the default name, which is not the
    // pinned one here — it gets the same refusal, not a silent redirect.
    assert_eq!(rejection_status(&state, None), StatusCode::NOT_FOUND);
}

/// A writable server's client can run `new-session` itself, so pinning it
/// would only break switching sessions.
#[test]
fn a_writable_server_serves_every_session_name() {
    let state = AppState::new();
    assert_eq!(
        query(Some("anything")).session(&state).unwrap(),
        "anything".to_string()
    );
    assert_eq!(
        query(None).session(&state).unwrap(),
        tmuxy_core::DEFAULT_SESSION_NAME.to_string()
    );
}

/// A name that would end the control-mode command line is refused before
/// the pin is consulted — it is malformed, not merely someone else's.
#[test]
fn an_unwritable_session_name_is_still_a_400() {
    let state = AppState::new();
    assert_eq!(rejection_status(&state, Some("")), StatusCode::BAD_REQUEST);
    assert_eq!(
        rejection_status(&state, Some("a\nkill-server")),
        StatusCode::BAD_REQUEST
    );
}

/// SEC-11: `create_session` was hard-coded true, so every distinct
/// `?session=` a viewer invented became a live shell that outlived them.
#[test]
fn a_read_only_server_never_creates_the_session_it_watches() {
    let viewer = AppState::new().with_read_only(true);
    let config = monitor_config("invented-by-a-viewer", &viewer);
    assert!(!config.create_session);
    assert!(config.observer);

    let writer = monitor_config("tmuxy", &AppState::new());
    assert!(writer.create_session);
    assert!(!writer.observer);
}

/// A monitor whose reported grid catches up with a resize LATE — the real
/// one's asynchrony, which is the whole bug: handling `ResizeWindow` only
/// sends `resizew` to tmux, and the aggregator learns the new grid when
/// tmux reports it, a round trip later. A fake that changed size while
/// handling the command would make the race impossible to reproduce and the
/// test unable to fail.
async fn session_with_resizing_monitor(state: &Arc<AppState>, session: &str) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let size = Arc::new(std::sync::Mutex::new((200u32, 50u32)));
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                MonitorCommand::ResizeWindow { cols, rows } => {
                    let late = Arc::clone(&size);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        #[allow(clippy::unwrap_used)]
                        let mut current = late.lock().unwrap();
                        *current = (cols, rows);
                    });
                }
                MonitorCommand::GetState { reply } => {
                    #[allow(clippy::unwrap_used)]
                    let size = *size.lock().unwrap();
                    let _ = reply.send(tmuxy_core::TmuxState {
                        session_name: "s".to_string(),
                        active_window_id: None,
                        active_pane_id: None,
                        panes: Vec::new(),
                        windows: Vec::new(),
                        total_width: size.0,
                        total_height: size.1,
                        focus_request: None,
                        seq: 0,
                    });
                }
                _ => {}
            }
        }
    });
    let mut conns = SessionConnections::new();
    conns.connections.push(1);
    conns.monitor_command_tx = Some(tx);
    state
        .sessions
        .write()
        .await
        .insert(session.to_string(), conns);
}

/// The first state a client is given agrees with the size it just set.
///
/// The resize is queued, not applied, when `set_client_size` returns — so
/// the state read straight after it is the grid from BEFORE. A client that
/// applies that answer after the stream has delivered the new grid goes
/// back to the old one, and on an idle session nothing corrects it:
/// `UI=200x49, tmux=139x26`, for as long as the session stays quiet.
#[tokio::test]
async fn a_clients_first_state_is_not_the_grid_from_before_its_resize() {
    let state = Arc::new(AppState::new());
    session_with_resizing_monitor(&state, "s").await;

    let answer = handle_command(
        ClientCommand::GetInitialState {
            cols: Some(139),
            rows: Some(27),
        },
        "s",
        &state,
        Some(1),
    )
    .await
    .expect("initial state");

    assert_eq!(answer["total_width"], 139, "{answer}");
    assert_eq!(answer["total_height"], 27, "{answer}");
}

/// The case that actually breaks in the wild: the client sends its viewport
/// as soon as it has measured one, so by the time it asks for state the
/// resize is already on its way and the `get_initial_state` call itself
/// delivers nothing. A wait that keyed on its OWN delivery skipped exactly
/// this, and the client went back to the pre-resize grid half the time.
#[tokio::test]
async fn a_first_state_waits_for_a_resize_an_earlier_call_sent() {
    let state = Arc::new(AppState::new());
    session_with_resizing_monitor(&state, "s").await;

    // The viewport arrives first, on its own — as it does in the app.
    handle_command(
        ClientCommand::SetClientSize {
            cols: 139,
            rows: 27,
        },
        "s",
        &state,
        Some(1),
    )
    .await
    .expect("set size");

    // ...and this call, which changes nothing, must still not hand back the
    // grid from before it.
    let answer = handle_command(
        ClientCommand::GetInitialState {
            cols: Some(139),
            rows: Some(27),
        },
        "s",
        &state,
        Some(1),
    )
    .await
    .expect("initial state");

    assert_eq!(answer["total_width"], 139, "{answer}");
    assert_eq!(answer["total_height"], 27, "{answer}");
}

/// ...and a client that asked for nothing is answered at once, with
/// whatever the monitor has: there is no resize on its way to wait for.
#[tokio::test]
async fn a_client_that_sets_no_size_waits_for_nothing() {
    let state = Arc::new(AppState::new());
    session_with_resizing_monitor(&state, "s").await;

    let answer = handle_command(
        ClientCommand::GetInitialState {
            cols: None,
            rows: None,
        },
        "s",
        &state,
        Some(1),
    )
    .await
    .expect("initial state");

    assert_eq!(answer["total_width"], 200, "{answer}");
}

/// SEC-11. A viewer's server has one monitor, started with the server;
/// a stream is answered from it or told there is nothing to show. It
/// never starts a monitor of its own, and no `has-session` runs for it.
#[tokio::test]
async fn a_viewer_stream_is_refused_until_the_servers_monitor_is_attached() {
    let state = Arc::new(
        AppState::new()
            .with_read_only(true)
            .with_session_pin(Some("shared".into())),
    );
    let ask = |state: &Arc<AppState>| {
        sse_handler(
            State(Arc::clone(state)),
            Query(query(Some("shared"))),
            HeaderMap::new(),
        )
    };

    // Nothing attached yet: not found, and nothing was made.
    assert_eq!(ask(&state).await.status(), StatusCode::NOT_FOUND);
    assert!(state.sessions.read().await.is_empty());

    // The server's monitor is up: the stream is served from it.
    session_with_fake_monitor(&state, "shared").await;
    assert_eq!(ask(&state).await.status(), StatusCode::OK);

    // The monitor lost the session (it clears its sender): nothing to
    // show again, and the entry is the server's, still there.
    state
        .sessions
        .write()
        .await
        .get_mut("shared")
        .unwrap()
        .monitor_command_tx = None;
    assert_eq!(ask(&state).await.status(), StatusCode::NOT_FOUND);
    assert!(state.sessions.read().await.contains_key("shared"));
}

/// SEC-11. A viewer leaving is not "the last client left": the monitor's
/// life is the server's, so no grace-period task is scheduled and nothing
/// is torn down.
#[tokio::test]
async fn a_viewer_leaving_does_not_touch_the_servers_monitor() {
    let state = Arc::new(
        AppState::new()
            .with_read_only(true)
            .with_session_pin(Some("shared".into())),
    );
    session_with_fake_monitor(&state, "shared").await;
    let tasks_before = state.join_set.lock().await.len();
    cleanup_connection(&state, "shared", 7).await;
    // The deferred cleanup a writable server would schedule lives in the
    // join set; none was.
    assert_eq!(state.join_set.lock().await.len(), tasks_before);
    let sessions = state.sessions.read().await;
    let conns = sessions.get("shared").expect("the server's entry is gone");
    assert!(conns.monitor_command_tx.is_some());
}

/// A session whose monitor answers every query with `output`, counting
/// the queries it is asked.
async fn session_answering_queries(
    state: &Arc<AppState>,
    session: &str,
    output: &str,
) -> Arc<std::sync::atomic::AtomicUsize> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let queries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&queries);
    let output = output.to_string();
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::RunCommandWithReply { reply, .. } = cmd {
                counted.fetch_add(1, Ordering::SeqCst);
                let _ = reply.send(tmuxy_core::control_mode::CommandReply {
                    output: output.clone(),
                    error: None,
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
    queries
}

/// SEC-11/SEC-16. The greeting's bindings used to cost three `tmux`
/// subprocesses per connecting client. They are read once per monitor
/// connection, over the monitor, and every later greeting is served the
/// copy the session keeps.
#[tokio::test]
async fn a_session_keeps_the_bindings_it_last_broadcast() {
    let state = Arc::new(AppState::new());
    let queries =
        session_answering_queries(&state, "s", "C-space\nbind-key -T prefix c new-window\n").await;
    let mut stream = state.sessions.read().await["s"].broadcast.subscribe();

    refresh_keybindings(&state, "s").await;

    assert_eq!(queries.load(Ordering::SeqCst), 1);
    let (_, frame) = stream.try_recv().expect("the open streams are told");
    assert!(frame.contains("C-space"), "{frame}");
    let kept = state.sessions.read().await["s"].key_bindings.clone();
    assert_eq!(
        kept.expect("kept for the next greeting").prefix_key,
        "C-space"
    );
}

/// SEC-11. `serve_viewer` is the whole of what a viewer's server serves:
/// the five reads, and a refusal for everything else. The refusal is the
/// default, so a command variant added later is viewer-safe until someone
/// writes down how a viewer should be served it.
#[tokio::test]
async fn a_viewer_is_served_the_reads_and_refused_everything_else() {
    let viewer = Arc::new(AppState::new().with_read_only(true));

    let parse = |v: serde_json::Value| -> ClientCommand {
        serde_json::from_value(v).expect("should parse")
    };

    // Served — reached the dispatch, whatever each one then answers.
    for body in [
        serde_json::json!({ "cmd": "get_initial_state", "args": { "cols": 80, "rows": 24 } }),
        serde_json::json!({ "cmd": "get_scrollback_cells", "args": { "paneId": "%1" } }),
        serde_json::json!({ "cmd": "get_theme_settings" }),
        serde_json::json!({ "cmd": "get_themes_list" }),
        serde_json::json!({ "cmd": "list_git_worktrees" }),
    ] {
        assert!(
            serve_viewer(parse(body.clone()), "watched", &viewer)
                .await
                .is_some(),
            "a viewer is served {body}"
        );
    }

    // Refused — a 403, before anything runs.
    for body in [
        serde_json::json!({ "cmd": "set_client_size", "args": { "cols": 80, "rows": 24 } }),
        serde_json::json!({ "cmd": "run_tmux_command", "args": { "command": "kill-server" } }),
        serde_json::json!({ "cmd": "query_tmux", "args": { "command": "list-panes" } }),
        serde_json::json!({ "cmd": "set_theme", "args": { "name": "default" } }),
        serde_json::json!({ "cmd": "set_theme_mode", "args": { "mode": "dark" } }),
        serde_json::json!({ "cmd": "set_cursor_blink", "args": { "enabled": true } }),
        serde_json::json!({ "cmd": "set_send_ask", "args": { "enabled": false } }),
        serde_json::json!({ "cmd": "set_trace_enabled", "args": { "enabled": true } }),
        serde_json::json!({ "cmd": "set_trace_level", "args": { "level": "debug" } }),
        serde_json::json!({ "cmd": "get_trace_settings" }),
    ] {
        assert!(
            serve_viewer(parse(body.clone()), "watched", &viewer)
                .await
                .is_none(),
            "a viewer is refused {body}"
        );
    }
}

/// SEC-11. `GetThemeSettings` read fourteen tmux options per request, and
/// a viewer's client asks on every reconnect. A viewer's server sources no
/// config, so nothing it serves can change: it reads once, over its
/// monitor, and answers every later request from that value.
#[tokio::test]
async fn a_viewers_server_reads_its_theme_settings_once() {
    let viewer = Arc::new(
        AppState::new()
            .with_read_only(true)
            .with_session_pin(Some("shared".into())),
    );
    let queries = session_answering_queries(
        &viewer,
        "shared",
        "@tmuxy-theme=nord\n@tmuxy-theme-mode=light\n",
    )
    .await;

    let first = theme_settings_for(&viewer, "shared").await.unwrap();
    let second = theme_settings_for(&viewer, "shared").await.unwrap();

    assert_eq!(
        queries.load(Ordering::SeqCst),
        1,
        "a viewer's second request must cost no tmux call"
    );
    assert_eq!(first["theme"], "nord");
    assert_eq!(first, second);
}
