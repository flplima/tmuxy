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
/// layer dispatches it.
pub(super) async fn initial_state_with_viewport(state: &Arc<AppState>) {
    let cmd = ClientCommand::GetInitialState {
        cols: Some(40),
        rows: Some(12),
    };
    // The fake monitor never answers with a state; only the sizing matters.
    let _ = handle_command(cmd, "s", state, Some(1)).await;
}

fn query(name: Option<&str>) -> SessionQuery {
    SessionQuery {
        session: name.map(str::to_string),
    }
}

fn rejection_status(name: Option<&str>) -> StatusCode {
    match query(name).session() {
        Ok(_) => StatusCode::OK,
        Err(rejection) => rejection.into_response().status(),
    }
}

/// A writable server's client can run `new-session` itself, so pinning it
/// would only break switching sessions.
#[test]
fn a_server_serves_every_session_name() {
    assert_eq!(
        query(Some("anything")).session().unwrap(),
        "anything".to_string()
    );
    assert_eq!(
        query(None).session().unwrap(),
        tmuxy_core::DEFAULT_SESSION_NAME.to_string()
    );
}

/// A session the monitor would create costs a tmux session and a shell that
/// outlive the stream, so past a budget of existing sessions the stream is
/// refused as unavailable — never with the 400 of a malformed name, which
/// a client is not meant to retry.
#[test]
fn a_session_past_the_budget_is_a_503() {
    assert!(may_create_session(0));
    assert!(may_create_session(MAX_AUTO_CREATED_SESSIONS - 1));
    assert!(!may_create_session(MAX_AUTO_CREATED_SESSIONS));
    assert_eq!(
        SessionRejection::TooMany.into_response().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        SessionRejection::TooMany.into_command_failure().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

/// A name that would end the control-mode command line is refused before
/// the pin is consulted — it is malformed, not merely someone else's.
#[test]
fn an_unwritable_session_name_is_a_400() {
    assert_eq!(rejection_status(Some("")), StatusCode::BAD_REQUEST);
    assert_eq!(
        rejection_status(Some("a\nkill-server")),
        StatusCode::BAD_REQUEST
    );
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
