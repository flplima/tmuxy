use super::order::{LOST_SEQ_TIMEOUT, MAX_WAITING};
use super::*;
use tmuxy_core::control_mode::MonitorCommand;

/// A session with client 1 on it, whose monitor records every command it is
/// handed, in the order it got them.
async fn session_recording_commands(state: &Arc<AppState>) -> Arc<std::sync::Mutex<Vec<String>>> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::RunCommand { command } = cmd {
                record.lock().unwrap().push(command);
            }
        }
    });
    super::tests_sessions::watched_with(state, "s", tx, &[1]).await;
    seen
}

/// `POST /commands` typing `text` into `%1`, numbered `seq` on connection 1.
fn type_numbered(
    state: &Arc<AppState>,
    seq: Option<u64>,
    text: &str,
) -> tokio::task::JoinHandle<StatusCode> {
    let body = serde_json::json!({
        "cmd": "run_tmux_command",
        "args": { "command": format!("send-keys -t %1 -l {text}") },
    });
    post(state, seq, &[], body.to_string())
}

/// `POST /commands` on connection 1 with `body`, numbered `seq`, under
/// `extra` headers on top of the usual ones.
fn post(
    state: &Arc<AppState>,
    seq: Option<u64>,
    extra: &[(&'static str, &str)],
    body: String,
) -> tokio::task::JoinHandle<StatusCode> {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    headers.insert("x-connection-id", axum::http::HeaderValue::from_static("1"));
    if let Some(seq) = seq {
        headers.insert("x-command-seq", seq.into());
    }
    for (name, value) in extra {
        headers.insert(*name, value.parse().unwrap());
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        commands_handler(
            State(state),
            Query(SessionQuery {
                session: Some("s".to_string()),
            }),
            headers,
            axum::body::Body::from(body),
        )
        .await
        .status()
    })
}

/// Every order the numbers `1..=n` can arrive in.
fn arrival_orders(n: u64) -> Vec<Vec<u64>> {
    if n == 0 {
        return vec![Vec::new()];
    }
    let mut orders = Vec::new();
    for shorter in arrival_orders(n - 1) {
        for at in 0..=shorter.len() {
            let mut order = shorter.clone();
            order.insert(at, n);
            orders.push(order);
        }
    }
    orders
}

/// Let every spawned request run as far as it can without the clock moving.
async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn typed(seen: &std::sync::Mutex<Vec<String>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|command| command.rsplit(' ').next().unwrap_or_default().to_string())
        .collect()
}

/// S7: the client sends its next POST before the previous one is answered,
/// and the requests arrive in whatever order their connections deliver
/// them. Here all 120 arrival orders of five are tried; tmux is handed them in
/// the order they were numbered, and nothing runs ahead of a number still
/// on its way.
#[tokio::test(start_paused = true)]
async fn numbered_commands_reach_tmux_in_number_order_whatever_order_they_arrive_in() {
    let arrivals = arrival_orders(5);
    assert_eq!(arrivals.len(), 120);
    for arrival in arrivals {
        let state = Arc::new(AppState::default());
        let seen = session_recording_commands(&state).await;
        let mut requests = Vec::new();
        for &seq in &arrival {
            requests.push(type_numbered(&state, Some(seq), &format!("k{seq}")));
            settle().await;
            let ran = typed(&seen);
            let in_order: Vec<String> = (1..=ran.len()).map(|n| format!("k{n}")).collect();
            assert_eq!(ran, in_order, "arrival {arrival:?}: ran ahead of its turn");
        }
        for request in requests {
            assert_eq!(request.await.unwrap(), StatusCode::OK);
        }
        assert_eq!(
            typed(&seen),
            ["k1", "k2", "k3", "k4", "k5"],
            "arrival {arrival:?}"
        );
    }
}

/// A number that never arrives (its request died on the way) holds the ones
/// after it for `LOST_SEQ_TIMEOUT`, not for ever; they then run in order,
/// and the gate moves on, so the next number runs at once.
#[tokio::test(start_paused = true)]
async fn a_number_that_never_arrives_is_given_up_on() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;

    let third = type_numbered(&state, Some(3), "k3");
    let second = type_numbered(&state, Some(2), "k2");
    settle().await;
    assert!(
        typed(&seen).is_empty(),
        "ran before number 1 was given up on"
    );

    tokio::time::sleep(LOST_SEQ_TIMEOUT - Duration::from_millis(10)).await;
    settle().await;
    assert!(typed(&seen).is_empty(), "gave up on number 1 early");

    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(second.await.unwrap(), StatusCode::OK);
    assert_eq!(third.await.unwrap(), StatusCode::OK);
    assert_eq!(typed(&seen), ["k2", "k3"]);

    let fourth = type_numbered(&state, Some(4), "k4");
    settle().await;
    assert_eq!(typed(&seen), ["k2", "k3", "k4"]);
    assert_eq!(fourth.await.unwrap(), StatusCode::OK);

    // The lost one turning up after all is refused: run now, it would land
    // after keys typed after it (an Enter on a line not yet finished).
    assert_eq!(
        type_numbered(&state, Some(1), "k1").await.unwrap(),
        StatusCode::CONFLICT
    );
    assert_eq!(typed(&seen), ["k2", "k3", "k4"]);
}

/// A number the server answers without running it has still had its turn:
/// the next one runs at once, not after `LOST_SEQ_TIMEOUT`. Each refusal
/// here is returned before the command would reach the gate.
#[tokio::test(start_paused = true)]
async fn a_refused_number_does_not_hold_the_ones_after_it() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;
    let refusals = [
        post(&state, Some(1), &[], "not json".to_string()),
        post(
            &state,
            Some(2),
            &[],
            r#"{"cmd":"no_such_command"}"#.to_string(),
        ),
        post(
            &state,
            Some(3),
            &[("content-type", "text/plain")],
            "{}".to_string(),
        ),
    ];
    let after = type_numbered(&state, Some(4), "k4");
    settle().await;
    assert_eq!(typed(&seen), ["k4"], "waited for a refused number");
    assert_eq!(after.await.unwrap(), StatusCode::OK);
    let statuses = [
        StatusCode::BAD_REQUEST,
        StatusCode::BAD_REQUEST,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
    ];
    for (refusal, status) in refusals.into_iter().zip(statuses) {
        assert_eq!(refusal.await.unwrap(), status);
    }
}

/// A POST that failed on the way never reaches the gate. The client names
/// its number on the next one (`X-Command-Lost`), and nothing waits for it.
#[tokio::test(start_paused = true)]
async fn a_number_the_client_reports_lost_is_passed_over() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;
    let body = serde_json::json!({
        "cmd": "run_tmux_command",
        "args": { "command": "send-keys -t %1 -l k3" },
    });
    let third = post(
        &state,
        Some(3),
        &[("x-command-lost", "1, 2")],
        body.to_string(),
    );
    settle().await;
    assert_eq!(typed(&seen), ["k3"], "waited for a number reported lost");
    assert_eq!(third.await.unwrap(), StatusCode::OK);
}

/// The server can see a stream close before its client does, and the client
/// goes on posting under the old id meanwhile: those commands are still
/// ordered, for `GATE_GRACE`.
#[tokio::test(start_paused = true)]
async fn a_closed_stream_still_orders_its_commands_for_a_while() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;
    cleanup_connection(&state, "s", 1).await;
    settle().await;

    let second = type_numbered(&state, Some(2), "k2");
    settle().await;
    assert!(typed(&seen).is_empty(), "number 2 ran ahead of number 1");
    let first = type_numbered(&state, Some(1), "k1");
    assert_eq!(first.await.unwrap(), StatusCode::OK);
    assert_eq!(second.await.unwrap(), StatusCode::OK);
    assert_eq!(typed(&seen), ["k1", "k2"]);

    tokio::time::sleep(super::GATE_GRACE).await;
    settle().await;
    assert!(
        state.command_gate(1).is_none(),
        "the gate was never dropped"
    );
}

/// The first number after a long pause is not mistaken for a lost one: the
/// wait is timed from when a request started waiting, not from when the
/// connection last ran something.
#[tokio::test(start_paused = true)]
async fn a_pause_in_typing_does_not_count_towards_giving_up() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;
    assert_eq!(
        type_numbered(&state, Some(1), "k1").await.unwrap(),
        StatusCode::OK
    );
    tokio::time::sleep(LOST_SEQ_TIMEOUT * 3).await;

    let third = type_numbered(&state, Some(3), "k3");
    settle().await;
    assert_eq!(typed(&seen), ["k1"], "number 3 overtook number 2");
    let second = type_numbered(&state, Some(2), "k2");
    assert_eq!(second.await.unwrap(), StatusCode::OK);
    assert_eq!(third.await.unwrap(), StatusCode::OK);
    assert_eq!(typed(&seen), ["k1", "k2", "k3"]);
}

/// A request dropped while it waits (its client went away) leaves the line.
#[tokio::test(start_paused = true)]
async fn a_waiting_request_that_is_dropped_leaves_the_line() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;

    let second = type_numbered(&state, Some(2), "k2");
    settle().await;
    second.abort();
    let _ = second.await;

    assert_eq!(
        type_numbered(&state, Some(1), "k1").await.unwrap(),
        StatusCode::OK
    );
    let third = type_numbered(&state, Some(3), "k3");
    tokio::time::sleep(LOST_SEQ_TIMEOUT + Duration::from_millis(10)).await;
    assert_eq!(third.await.unwrap(), StatusCode::OK);
    assert_eq!(typed(&seen), ["k1", "k3"]);
}

/// A command with no number (the CLI, an older tab) and one from a
/// connection with no open stream run as they arrive, waiting for nothing.
#[tokio::test(start_paused = true)]
async fn a_command_with_no_number_waits_for_nothing() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;

    let parked = type_numbered(&state, Some(2), "k2");
    settle().await;
    assert_eq!(
        type_numbered(&state, None, "plain").await.unwrap(),
        StatusCode::OK
    );
    assert_eq!(typed(&seen), ["plain"]);
    parked.abort();
}

/// A connection cannot park requests without bound.
#[tokio::test(start_paused = true)]
async fn a_connection_with_too_many_waiting_is_refused_more() {
    let state = Arc::new(AppState::default());
    let seen = session_recording_commands(&state).await;

    let parked: Vec<_> = (0..MAX_WAITING as u64)
        .map(|n| type_numbered(&state, Some(n + 2), "k"))
        .collect();
    settle().await;
    let over = type_numbered(&state, Some(MAX_WAITING as u64 + 2), "k");
    assert_eq!(over.await.unwrap(), StatusCode::TOO_MANY_REQUESTS);

    // The refused number has had its turn: once the line clears, the one
    // after it runs without waiting for it.
    assert_eq!(
        type_numbered(&state, Some(1), "first").await.unwrap(),
        StatusCode::OK
    );
    for request in parked {
        assert_eq!(request.await.unwrap(), StatusCode::OK);
    }
    let ran = typed(&seen).len();
    let next = type_numbered(&state, Some(MAX_WAITING as u64 + 3), "next");
    settle().await;
    assert_eq!(typed(&seen).len(), ran + 1, "waited for the refused number");
    assert_eq!(next.await.unwrap(), StatusCode::OK);
}
