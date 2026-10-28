use super::tests_sessions::{initial_state_with_viewport, session_with_fake_monitor};
use super::*;
use tmuxy_core::client_size::SizePolicy;
use tmuxy_core::control_mode::StateEmitter;
use tokio::sync::broadcast;

#[tokio::test]
async fn a_writable_server_still_forwards_a_clipboard_write() {
    let broadcast = Arc::new(crate::state::SessionBroadcast::new());
    let mut rx = broadcast.subscribe();
    let emitter = SseEmitter::new(
        broadcast.clone(),
        Arc::new(AppState::new()),
        "s".to_string(),
        Arc::new(tmuxy_core::session_snapshot::SnapshotKeeper::new()),
    );

    emitter.write_clipboard(Some(&"%0".parse().unwrap()), "yanked".into());

    let (_, message) = rx.try_recv().unwrap();
    assert!(message.contains("yanked"));
}

/// SEC-01/SEC-13. The paste-buffer mirror arrives with no pane, so the
/// aggregator's active-pane gate never sees it — the size cap is the one
/// bound that path has.
#[tokio::test]
async fn a_clipboard_write_over_the_cap_is_not_broadcast() {
    let broadcast = Arc::new(crate::state::SessionBroadcast::new());
    let mut rx = broadcast.subscribe();
    let emitter = SseEmitter::new(
        broadcast.clone(),
        Arc::new(AppState::new()),
        "s".to_string(),
        Arc::new(tmuxy_core::session_snapshot::SnapshotKeeper::new()),
    );

    emitter.write_clipboard(
        None,
        "x".repeat(tmuxy_core::control_mode::MAX_CLIPBOARD_BYTES + 1),
    );

    assert!(rx.try_recv().is_err());
}

/// SEC-16. Each `/events` stream is a long-lived task holding a broadcast
/// receiver and a place in the sessions map, and every one of them also ran
/// three external `tmux` processes on a worker thread. Nothing counted
/// them, so a connection flood grew all of it without bound.
#[test]
fn open_streams_are_capped_and_the_slot_comes_back() {
    let state = Arc::new(AppState::new());
    let limit = state.max_live_streams();

    let slots: Vec<_> = (0..limit)
        .map(|i| {
            state
                .claim_stream_slot()
                .unwrap_or_else(|| panic!("slot {i} of {limit} should be free"))
        })
        .collect();
    assert!(
        state.claim_stream_slot().is_none(),
        "the {}th stream should be refused",
        limit + 1
    );

    // A client disconnecting drops its generator, which drops the slot.
    drop(slots);
    assert!(state.claim_stream_slot().is_some());
}

#[tokio::test]
async fn a_writable_server_sizes_the_session_to_the_client_asking_for_state() {
    let state = Arc::new(AppState::new());
    let resizes = session_with_fake_monitor(&state, "s").await;
    initial_state_with_viewport(&state).await;
    let sizes = state.sessions.read().await["s"].client_sizes.clone();
    assert_eq!(sizes.get(&1), Some(&(40, 12)));
    assert_eq!(*resizes.lock().await, vec![(40, 12)]);
}

/// A size sent under an id no stream owns is dropped: nothing would ever
/// clean it up, and a 1x1 one would pin the session for every real client.
#[tokio::test]
async fn a_size_for_a_connection_with_no_stream_is_ignored() {
    let state = Arc::new(AppState::new());
    let resizes = session_with_fake_monitor(&state, "s").await;
    set_client_size(&state, "s", Some(9999), 1, 1).await;
    assert!(!state.sessions.read().await["s"]
        .client_sizes
        .contains_key(&9999));
    assert!(resizes.lock().await.is_empty());
}

/// A viewport below the floor is taken as the floor: a real client whose
/// grid measured as a sliver mid-load, or a forged 1x1, would otherwise size
/// the session down to nothing for every client under `smallest`.
#[tokio::test]
async fn a_viewport_below_the_floor_is_raised_to_it() {
    use tmuxy_core::client_size::{MIN_CLIENT_COLS, MIN_CLIENT_ROWS};
    let state = Arc::new(AppState::new());
    let resizes = session_with_fake_monitor(&state, "s").await;
    set_client_size(&state, "s", Some(1), 1, 1).await;
    assert_eq!(
        state.sessions.read().await["s"].client_sizes[&1],
        (MIN_CLIENT_COLS, MIN_CLIENT_ROWS)
    );
    // The fake monitor records the resize on its own task.
    let sent = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if !resizes.lock().await.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(sent.is_ok(), "the floored size never reached the monitor");
    assert_eq!(
        *resizes.lock().await,
        vec![(MIN_CLIENT_COLS, MIN_CLIENT_ROWS)]
    );
}

/// The 12-touch bug. `last_resize` is the record of a size that REACHED
/// tmux, and it was written before anything was sent — so a monitor that
/// had not registered its command channel yet meant the resize was dropped
/// while the size was remembered as applied. Every later attempt then
/// short-circuited on "same size as last time", and the client's viewport
/// was lost for the life of the session: the window stayed at the
/// control-mode PTY's 200x50 while a phone-width client drew 41 columns.
///
/// Timing-dependent, which is why it failed on a CI runner and not on a
/// developer's machine.
#[tokio::test]
async fn a_size_that_reached_no_monitor_is_asked_for_again() {
    let state = Arc::new(AppState::new());
    // A session whose monitor has not registered its channel yet.
    let mut conns = SessionConnections::new();
    conns.connections.push(1);
    conns.monitor_command_tx = None;
    state.sessions.write().await.insert("s".to_string(), conns);

    set_client_size(&state, "s", Some(1), 41, 29).await;
    assert_eq!(
        state.sessions.read().await["s"].last_resize,
        None,
        "a size nothing received must not be recorded as applied"
    );

    // The monitor comes up, and the same size is offered again — which the
    // old code refused to forward, because it believed it already had.
    let resizes = session_with_fake_monitor(&state, "s").await;
    set_client_size(&state, "s", Some(1), 41, 29).await;
    // `send` returns once the value is in the channel; the fake monitor
    // reads it in its own task, so wait for it to be seen rather than
    // assuming the scheduler got there.
    for _ in 0..200 {
        if !resizes.lock().await.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(*resizes.lock().await, vec![(41, 29)]);
    assert_eq!(
        state.sessions.read().await["s"].last_resize,
        Some((41, 29)),
        "a delivered size IS recorded, so it is not re-sent on every tick"
    );
}

/// Round-trip the Clipboard variant so SSE consumers can rely on the
/// `event=clipboard` discriminator + `{ pane_id, text }` payload shape.
#[test]
fn clipboard_event_serializes_with_expected_shape() {
    let evt = SseEvent::Clipboard {
        pane_id: "%4".parse().unwrap(),
        text: "hello world".to_string(),
    };
    let json = serde_json::to_string(&evt).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["event"], "clipboard");
    assert_eq!(parsed["data"]["pane_id"], "%4");
    assert_eq!(parsed["data"]["text"], "hello world");
}

/// A tmux message goes out as `tmux-message` `{ text }` — never as
/// `message`, which `EventSource.onmessage` would also receive.
#[test]
fn message_event_serializes_with_expected_shape() {
    let evt = SseEvent::Message {
        text: "build done".to_string(),
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&evt).unwrap()).unwrap();
    assert_eq!(parsed["event"], "tmux-message");
    assert_eq!(parsed["data"]["text"], "build done");
}

// ----------------------------------------------------------------
// Lifecycle: a client that stops reading, and a client that vanishes
// ----------------------------------------------------------------

/// A slow consumer — a backgrounded tab, a stalled TCP window — stops
/// draining its broadcast receiver while tmux keeps producing. Tokio drops
/// the overflow and reports `Lagged`; the handler then replays the ring
/// buffer above what it already sent. What that promises (S2 in
/// `docs/INVARIANTS.md`): everything the ring still holds reaches the
/// client once and in order, and the only gap is below the ring's oldest
/// entry — a gap the client's sequencer sees in the ids and answers with
/// a refetch. Here the client falls further behind than the ring, so that
/// gap exists; what must never happen is a second gap or a repeat.
#[tokio::test]
async fn a_client_that_stops_reading_gets_the_ring_tail_once_with_the_gap_below_it() {
    let b = crate::state::SessionBroadcast::new();
    let mut rx = b.subscribe();

    // Deliver a few events normally, then stop reading and overflow the
    // channel by half a buffer.
    for i in 0..3 {
        b.broadcast(format!("m{i}"));
    }
    let mut received: Vec<u64> = Vec::new();
    let mut last_replayed = 0u64;
    for _ in 0..3 {
        let (seq, _) = rx.try_recv().unwrap();
        received.push(seq);
        last_replayed = seq;
    }
    for i in 3..(crate::state::EVENT_BUFFER_SIZE + 50) {
        b.broadcast(format!("m{i}"));
    }

    // The next read reports the drop, exactly as the handler's Lagged arm
    // sees it.
    let lagged = matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Lagged(_))
    );
    assert!(lagged, "the receiver should have reported a lag");

    // The handler's recovery: replay everything above what it already sent.
    for (seq, _) in b.replay_since(last_replayed) {
        received.push(seq);
        last_replayed = seq;
    }
    // Then resume live delivery, deduping against the replay.
    while let Ok((seq, _)) = rx.try_recv() {
        if seq <= last_replayed {
            continue;
        }
        received.push(seq);
        last_replayed = seq;
    }

    let oldest = b.oldest_seq().unwrap();
    let newest = b.broadcast("final".into());
    for (seq, _) in b.replay_since(last_replayed) {
        received.push(seq);
    }

    // Each event was delivered once, the stream ends on the newest, and
    // the one gap sits exactly where the ring could not help: between
    // the last event read before the lag and the ring's oldest entry.
    let unique: std::collections::BTreeSet<u64> = received.iter().copied().collect();
    assert_eq!(unique.len(), received.len(), "an event was delivered twice");
    assert_eq!(*received.last().unwrap(), newest);
    assert!(
        oldest > 4,
        "the ring should have outrun the client: {oldest}"
    );
    let gaps: Vec<(u64, u64)> = received
        .windows(2)
        .filter(|pair| pair[1] != pair[0] + 1)
        .map(|pair| (pair[0], pair[1]))
        .collect();
    assert_eq!(gaps, vec![(3, oldest)], "stream: {received:?}");
}

/// A client that fell further behind than the buffer cannot be resumed
/// without a gap, so it is served no replay at all and waits for the next
/// full state (S3 in `docs/INVARIANTS.md`). A partial replay would be the
/// "Connecting… forever" shape: the buffer answers, the client believes it
/// is caught up, and the UI never matches tmux again.
#[test]
fn a_client_beyond_the_buffer_is_not_resumed_from_it() {
    let b = crate::state::SessionBroadcast::new();
    for i in 1..=(crate::state::EVENT_BUFFER_SIZE + 20) {
        b.broadcast(format!("m{i}"));
    }
    let oldest = b.oldest_seq();
    assert_eq!(oldest, Some(21));

    // Disconnected at seq 5, far behind the buffer's floor: no replay.
    assert!(!can_replay_from(Some(5), oldest));
    // Disconnected at 19: its successor has left the buffer.
    assert!(!can_replay_from(Some(19), oldest));
    // Disconnected at 20 — the buffer still holds its successor.
    assert!(can_replay_from(Some(20), oldest));
    assert!(can_replay_from(Some(100), oldest));
    // A first connection sends no Last-Event-Id, and an empty buffer has
    // nothing to serve; both take the full-snapshot path.
    assert!(!can_replay_from(None, oldest));
    assert!(!can_replay_from(Some(19), None));
}

/// A stream that dies mid-frame is just a dropped connection to the
/// server: the session must lose that client's viewport and resize to the
/// clients still watching. Leaving it behind pins the session to the size
/// of a browser tab that is gone — panes stay small for everyone.
#[tokio::test]
async fn a_client_that_disconnects_stops_holding_the_session_small() {
    let state = Arc::new(AppState::new());
    let resizes = session_with_fake_monitor(&state, "s").await;
    {
        let mut sessions = state.sessions.write().await;
        let conns = sessions.get_mut("s").unwrap();
        conns.connections = vec![1, 2];
        conns.client_sizes.insert(1, (200, 50));
        // The narrow client drags the whole session down to its size.
        conns.client_sizes.insert(2, (80, 24));
        conns.last_resize = Some((80, 24));
    }

    cleanup_connection(&state, "s", 2).await;

    let sessions = state.sessions.read().await;
    let conns = &sessions["s"];
    assert_eq!(conns.connections, vec![1]);
    assert!(!conns.client_sizes.contains_key(&2));
    assert_eq!(conns.last_resize, Some((200, 50)));
    drop(sessions);
    tokio::task::yield_now().await;
    assert_eq!(*resizes.lock().await, vec![(200, 50)]);
}

/// The last client leaving does NOT tear the monitor down on the spot —
/// a page reload reconnects within a second, and killing the control-mode
/// connection there is what a reload used to look like from tmux's side.
#[tokio::test]
async fn the_last_client_leaving_keeps_the_monitor_through_the_grace_period() {
    let state = Arc::new(AppState::new());
    session_with_fake_monitor(&state, "s").await;

    cleanup_connection(&state, "s", 1).await;

    let sessions = state.sessions.read().await;
    let conns = &sessions["s"];
    assert!(conns.connections.is_empty());
    assert!(
        conns.monitor_command_tx.is_some(),
        "the monitor was torn down before the grace period elapsed"
    );
}

/// The resizes the fake monitor has seen once there are `n` of them: it reads
/// the channel in its own task, so `send` returning does not mean it has.
async fn resizes_seen(resizes: &tokio::sync::Mutex<Vec<(u32, u32)>>, n: usize) -> Vec<(u32, u32)> {
    for _ in 0..200 {
        if resizes.lock().await.len() >= n {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    resizes.lock().await.clone()
}

/// Two clients, a wide one and a narrow one, watching session `s`.
async fn two_clients(state: &Arc<AppState>) -> Arc<tokio::sync::Mutex<Vec<(u32, u32)>>> {
    let resizes = session_with_fake_monitor(state, "s").await;
    state
        .sessions
        .write()
        .await
        .get_mut("s")
        .unwrap()
        .connections = vec![1, 2];
    set_client_size(state, "s", Some(1), 200, 50).await;
    set_client_size(state, "s", Some(2), 80, 60).await;
    resizes
}

/// `@tmuxy-size` picks the session's size from the clients' viewports: the
/// smallest by default, the largest, or a fixed grid no client report moves.
#[tokio::test]
async fn the_session_is_sized_by_its_size_policy() {
    let state = Arc::new(AppState::new());
    let resizes = two_clients(&state).await;
    assert_eq!(resizes_seen(&resizes, 2).await, vec![(200, 50), (80, 50)]);

    set_size_policy(&state, "s", SizePolicy::Largest).await;
    assert_eq!(resizes_seen(&resizes, 3).await[2], (200, 60));

    set_size_policy(
        &state,
        "s",
        SizePolicy::Fixed {
            cols: 100,
            rows: 30,
        },
    )
    .await;
    assert_eq!(resizes_seen(&resizes, 4).await[3], (100, 30));

    // A client resizing its window changes nothing a fixed size says.
    set_client_size(&state, "s", Some(2), 40, 20).await;
    cleanup_connection(&state, "s", 1).await;
    assert_eq!(resizes_seen(&resizes, 5).await.len(), 4);
    assert_eq!(
        state.sessions.read().await["s"].last_resize,
        Some((100, 30))
    );
}

/// `latest` follows the client used last: the one that reported a size, and
/// then whichever sends a command.
#[tokio::test]
async fn a_latest_session_follows_the_client_used_last() {
    let state = Arc::new(AppState::new());
    let resizes = two_clients(&state).await;
    set_size_policy(&state, "s", SizePolicy::Latest).await;
    assert_eq!(resizes_seen(&resizes, 3).await[2], (80, 60));

    note_client_activity(&state, "s", Some(1)).await;
    assert_eq!(resizes_seen(&resizes, 4).await[3], (200, 50));

    // Using the same client again is no resize, and neither is the other
    // client reporting the size it already had: its grid is not its own size,
    // so it reports it after every update, and taking that for a use made the
    // two clients take the session from each other on every frame.
    note_client_activity(&state, "s", Some(1)).await;
    set_client_size(&state, "s", Some(2), 80, 60).await;
    assert_eq!(resizes_seen(&resizes, 5).await.len(), 4);

    // A new size from it is a use.
    set_client_size(&state, "s", Some(2), 90, 40).await;
    assert_eq!(resizes_seen(&resizes, 5).await[4], (90, 40));
}
