use super::tests_sessions::{initial_state_with_viewport, resizes_seen, session_with_fake_monitor};
use super::*;
use tokio::sync::broadcast;

/// SEC-16. Each `/events` stream is a long-lived task holding a broadcast
/// receiver and a place in the sessions map, and every one of them also ran
/// three external `tmux` processes on a worker thread. Nothing counted
/// them, so a connection flood grew all of it without bound.
#[test]
fn open_streams_are_capped_and_the_slot_comes_back() {
    let state = Arc::new(AppState::default());
    let limit = MAX_LIVE_STREAMS;

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
    let state = Arc::new(AppState::default());
    let resizes = session_with_fake_monitor(&state, "s").await;
    initial_state_with_viewport(&state).await;
    assert_eq!(resizes_seen(&resizes, 1).await, vec![(40, 12)]);
}

/// A size sent under an id no stream owns is dropped: nothing would ever
/// clean it up, and a 1x1 one would pin the session for every real client.
#[tokio::test]
async fn a_size_for_a_connection_with_no_stream_is_ignored() {
    let state = Arc::new(AppState::default());
    let resizes = session_with_fake_monitor(&state, "s").await;
    let cmd = ClientCommand::SetClientSize { cols: 1, rows: 1 };
    handle_command(cmd, "s", &state, Some(9999)).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(resizes.lock().await.is_empty());
    assert_eq!(state.sessions.read().await["s"].runtime.size(), None);
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
        b.broadcast("state-update", format!("m{i}"));
    }
    let mut received: Vec<u64> = Vec::new();
    let mut last_replayed = 0u64;
    for _ in 0..3 {
        let (seq, _) = rx.try_recv().unwrap();
        received.push(seq);
        last_replayed = seq;
    }
    for i in 3..(crate::state::EVENT_BUFFER_SIZE + 50) {
        b.broadcast("state-update", format!("m{i}"));
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
    let newest = b.broadcast("state-update", "final".into());
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
        b.broadcast("state-update", format!("m{i}"));
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
    let state = Arc::new(AppState::default());
    let resizes = session_with_fake_monitor(&state, "s").await;
    state
        .sessions
        .write()
        .await
        .get_mut("s")
        .unwrap()
        .connections = vec![1, 2];
    for (client, cols, rows) in [(1, 200, 50), (2, 80, 24)] {
        let cmd = ClientCommand::SetClientSize { cols, rows };
        handle_command(cmd, "s", &state, Some(client))
            .await
            .unwrap();
    }
    assert_eq!(resizes_seen(&resizes, 2).await, vec![(200, 50), (80, 24)]);

    cleanup_connection(&state, "s", 2).await;

    assert_eq!(state.sessions.read().await["s"].connections, vec![1]);
    assert_eq!(resizes_seen(&resizes, 3).await[2], (200, 50));
}

/// The last client leaving does NOT tear the monitor down on the spot —
/// a page reload reconnects within a second, and killing the control-mode
/// connection there is what a reload used to look like from tmux's side.
#[tokio::test]
async fn the_last_client_leaving_keeps_the_monitor_through_the_grace_period() {
    let state = Arc::new(AppState::default());
    session_with_fake_monitor(&state, "s").await;

    cleanup_connection(&state, "s", 1).await;

    let sessions = state.sessions.read().await;
    let conns = &sessions["s"];
    assert!(conns.connections.is_empty());
    assert!(
        conns.runtime.tx_now().is_some(),
        "the monitor was torn down before the grace period elapsed"
    );
}
