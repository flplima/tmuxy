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
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    headers.insert("x-connection-id", axum::http::HeaderValue::from_static("1"));
    if let Some(seq) = seq {
        headers.insert("x-command-seq", seq.into());
    }
    let body = serde_json::json!({
        "cmd": "run_tmux_command",
        "args": { "command": format!("send-keys -t %1 -l {text}") },
    });
    let state = Arc::clone(state);
    tokio::spawn(async move {
        commands_handler(
            State(state),
            Query(SessionQuery {
                session: Some("s".to_string()),
            }),
            headers,
            axum::body::Body::from(body.to_string()),
        )
        .await
        .status()
    })
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
/// them. Here every arrival order of five is tried; tmux is handed them in
/// the order they were numbered, and nothing runs ahead of a number still
/// on its way.
#[tokio::test(start_paused = true)]
async fn numbered_commands_reach_tmux_in_number_order_whatever_order_they_arrive_in() {
    let arrivals: [[u64; 5]; 6] = [
        [2, 1, 3, 4, 5],
        [5, 4, 3, 2, 1],
        [3, 5, 1, 4, 2],
        [2, 3, 4, 5, 1],
        [1, 3, 2, 5, 4],
        [4, 1, 5, 2, 3],
    ];
    for arrival in arrivals {
        let state = Arc::new(AppState::default());
        let seen = session_recording_commands(&state).await;
        let mut requests = Vec::new();
        for seq in arrival {
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

    // The lost one turning up after all is run, late, rather than dropped.
    assert_eq!(
        type_numbered(&state, Some(1), "k1").await.unwrap(),
        StatusCode::OK
    );
    assert_eq!(typed(&seen), ["k2", "k3", "k4", "k1"]);
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
    let _seen = session_recording_commands(&state).await;

    let parked: Vec<_> = (0..MAX_WAITING as u64)
        .map(|n| type_numbered(&state, Some(n + 2), "k"))
        .collect();
    settle().await;
    let over = type_numbered(&state, Some(MAX_WAITING as u64 + 2), "k");
    assert_eq!(over.await.unwrap(), StatusCode::TOO_MANY_REQUESTS);
    for request in parked {
        request.abort();
    }
}
