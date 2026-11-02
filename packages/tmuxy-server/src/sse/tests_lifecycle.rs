//! A session's monitor across the moments a client is not there: idle
//! guards, and a control link that drops while the session survives.

use super::clients::{monitor_config, schedule_idle_monitor_cleanup};
use super::tests_sessions::{resizes_seen, session_with_fake_monitor};
use super::*;

/// Idle guards pile up: `ensure_session` schedules a 5 s one while the
/// session has no client yet, and the first client's reload schedules a 2 s
/// one when it leaves. The older guard fired inside the newer one's grace
/// and removed the session, so the reload's stream came back to a fresh
/// entry, a second monitor, and a full resync. A guard a client has outrun
/// leaves the session to the guard scheduled after that client left.
#[tokio::test]
async fn a_reload_inside_an_older_guards_grace_is_not_cut_short_by_it() {
    let state = Arc::new(AppState::new());
    session_with_fake_monitor(&state, "s").await;
    state
        .sessions
        .write()
        .await
        .get_mut("s")
        .unwrap()
        .connections
        .clear();
    schedule_idle_monitor_cleanup(&state, "s", std::time::Duration::from_millis(50)).await;

    // A client arrives, and reloads: gone again for a moment, with the
    // reload's own grace period ahead of it.
    state
        .sessions
        .write()
        .await
        .get_mut("s")
        .unwrap()
        .register(1);
    cleanup_connection(&state, "s", 1).await;

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let sessions = state.sessions.read().await;
    let conns = sessions
        .get("s")
        .expect("the older guard removed the session inside the reload's grace");
    assert!(conns.monitor_command_tx.is_some());
}

/// A monitor whose control link dropped while the session survived (its CC
/// client killed, a `detach-client`) attaches again, and the attach resizes
/// the session to the control-mode PTY's 200x50. `last_resize` still said
/// the clients' size had reached tmux, so nothing sent it again, and the
/// session stayed at 200x50 under a client drawing 41 columns.
#[tokio::test]
async fn a_reconnected_monitor_is_told_the_clients_size_again() {
    use tmuxy_core::transport::Host;
    let state = Arc::new(AppState::new());
    let resizes = session_with_fake_monitor(&state, "s").await;
    set_client_size(&state, "s", Some(1), 41, 29).await;
    assert_eq!(resizes_seen(&resizes, 1).await, vec![(41, 29)]);

    let (tx, broadcast) = {
        let sessions = state.sessions.read().await;
        let conns = &sessions["s"];
        (
            conns.monitor_command_tx.clone().unwrap(),
            Arc::clone(&conns.broadcast),
        )
    };
    let mut host = monitor::ServerHost {
        config: monitor_config("s", false),
        broadcast,
        session: "s".to_string(),
        state: Arc::clone(&state),
        first_connect: false,
    };
    host.ended().await;
    assert!(
        host.connected(
            tx,
            Arc::new(tmuxy_core::session_snapshot::SnapshotKeeper::new())
        )
        .await
    );

    assert_eq!(resizes_seen(&resizes, 2).await, vec![(41, 29), (41, 29)]);
    assert_eq!(state.sessions.read().await["s"].last_resize, Some((41, 29)));
}
