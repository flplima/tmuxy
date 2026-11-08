use super::clients::schedule_idle_monitor_cleanup;
use super::tests_sessions::session_with_fake_monitor;
use super::*;

/// Idle guards pile up: `ensure_session` schedules a 5 s one while the
/// session has no client yet, and the first client's reload schedules a 2 s
/// one when it leaves. The older guard fired inside the newer one's grace
/// and removed the session, so the reload's stream came back to a fresh
/// entry, a second monitor, and a full resync. A guard a client has outrun
/// leaves the session to the guard scheduled after that client left.
#[tokio::test(start_paused = true)]
async fn a_reload_inside_an_older_guards_grace_is_not_cut_short_by_it() {
    let state = Arc::new(AppState::default());
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
    assert!(conns.runtime.tx_now().is_some());
}

/// An agent on `/mcp` holds no stream between its calls. The guard a
/// leaving browser schedules must not stop the monitor under an agent that
/// called a moment ago — the next call would wait for a fresh attach — and
/// must still stop it once the agent's hold has run out, so a client that
/// went away does not keep a control-mode client attached forever.
#[tokio::test(start_paused = true)]
async fn an_agents_hold_outlasts_the_grace_and_then_ends() {
    let state = Arc::new(AppState::default());
    session_with_fake_monitor(&state, "s").await;
    {
        let mut sessions = state.sessions.write().await;
        let conns = sessions.get_mut("s").unwrap();
        conns.connections.clear();
        conns.agent_hold_until = Some(tokio::time::Instant::now() + Duration::from_millis(400));
    }
    schedule_idle_monitor_cleanup(&state, "s", Duration::from_millis(50)).await;

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        state.sessions.read().await.contains_key("s"),
        "the grace stopped a monitor an agent still holds"
    );

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !state.sessions.read().await.contains_key("s"),
        "the monitor outlived the agent's hold"
    );
}
