use super::*;

/// S1: ids count up from 1 — 0 is what a stream that has sent nothing
/// remembers, and an id equal to it would never be delivered.
#[test]
fn seqs_are_monotonic_from_one() {
    let b = SessionBroadcast::new();
    assert_eq!(b.broadcast("a".into()), 1);
    assert_eq!(b.broadcast("b".into()), 2);
    assert_eq!(b.broadcast("c".into()), 3);
}

#[test]
fn replay_since_returns_strictly_newer() {
    let b = SessionBroadcast::new();
    for i in 1..=5 {
        b.broadcast(format!("m{}", i));
    }
    let replay = b.replay_since(3);
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[0].0, 4);
    assert_eq!(&*replay[0].1, "m4");
    assert_eq!(replay[1].0, 5);
    assert_eq!(&*replay[1].1, "m5");
}

#[test]
fn ring_buffer_drops_oldest_at_capacity() {
    let b = SessionBroadcast::new();
    for i in 1..=(EVENT_BUFFER_SIZE + 5) {
        b.broadcast(format!("m{}", i));
    }
    assert_eq!(b.oldest_seq(), Some(6));
    let replay = b.replay_since(5);
    assert_eq!(replay.len(), EVENT_BUFFER_SIZE);
    assert_eq!(replay[0].0, 6);
}

/// S1: the ring is sorted and gap-free however many threads broadcast at
/// once — the monitor and the initial-sync task do. A stress run, not an
/// exhaustive one: the threads are released together and the run is
/// repeated, which makes the old interleaving (a seq taken, then the ring
/// written under a separate lock) likely rather than certain to show.
/// What makes it impossible is `broadcast` taking the seq and writing the
/// ring under one lock, which review has to hold.
#[test]
fn concurrent_broadcasters_keep_the_ring_in_order() {
    let per_thread = EVENT_BUFFER_SIZE / 4;
    for _round in 0..25 {
        let b = std::sync::Arc::new(SessionBroadcast::new());
        let gate = std::sync::Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (0..4)
            .map(|t| {
                let b = std::sync::Arc::clone(&b);
                let gate = std::sync::Arc::clone(&gate);
                std::thread::spawn(move || {
                    gate.wait();
                    for i in 0..per_thread {
                        b.broadcast(format!("t{t}-{i}"));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let seqs: Vec<u64> = b.replay_since(0).into_iter().map(|(s, _)| s).collect();
        let expected: Vec<u64> = (1..=(4 * per_thread) as u64).collect();
        assert_eq!(seqs, expected, "the ring is out of order or has a gap");
    }
}

/// A burst of large deltas does not stay in memory for want of newer
/// events: past the byte budget the oldest go, and a client resuming from
/// before them is told the ring cannot serve it (`oldest_seq` moved on).
#[test]
fn the_ring_keeps_no_more_than_its_byte_budget() {
    let b = SessionBroadcast::new();
    let big = "x".repeat(EVENT_BUFFER_MAX_BYTES / 2 - 1);
    for _ in 0..4 {
        b.broadcast(big.clone());
    }
    let kept = b.replay_since(0);
    assert_eq!(kept.len(), 2, "two half-budget events fit, four do not");
    assert_eq!(b.oldest_seq(), Some(3));
    assert_eq!(kept.iter().map(|(s, _)| *s).collect::<Vec<_>>(), [3, 4]);

    // One event over the whole budget is still kept, alone.
    b.broadcast("y".repeat(EVENT_BUFFER_MAX_BYTES + 1));
    assert_eq!(b.replay_since(0).len(), 1);
    assert_eq!(b.oldest_seq(), Some(5));
}

#[test]
fn oldest_seq_is_none_when_empty() {
    let b = SessionBroadcast::new();
    assert_eq!(b.oldest_seq(), None);
}
