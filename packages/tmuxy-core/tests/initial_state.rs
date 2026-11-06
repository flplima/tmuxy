//! A client's initial state comes from the monitor, not from a poll.
//!
//! The desktop app starts its monitor before the webview can listen, so the
//! monitor's one `StateUpdate::Full` broadcast is gone by the time the
//! frontend asks for its baseline. A baseline built from a subprocess poll
//! did not know the modes an application had set before the client attached
//! — `capture-pane` replays the screen, not `?1049h` or `?1000h` — and a
//! delta only carries what changed, so a pane running a mouse-tracking
//! full-screen program stayed "plain" on the client for as long as the
//! program ran: every wheel over it was dropped instead of forwarded as an
//! SGR mouse report. `MonitorCommand::GetState` answers with the
//! aggregator's own picture, which has the modes from tmux's list-panes.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

mod common;

#[tokio::test]
async fn the_initial_state_knows_the_modes_a_program_set_before_the_client_attached() {
    let server = common::ScratchServer::new("initial-state");

    // A full-screen, mouse-tracking program is already running when the
    // monitor attaches — the way Claude Code is when the desktop app restarts.
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "printf '\\033[?1049h\\033[?1000h\\033[?1006h'; sleep 60",
    ])
    .unwrap();

    let monitor = server.attach("app", false).await;

    // The program's `printf` and the monitor's first `list-panes` race each
    // other on a slow runner: a state read before the modes were set is not
    // yet the one this test is about, so it is read again until it is.
    common::wait_until(
        "the alternate screen and mouse tracking in the state",
        Duration::from_secs(10),
        || async {
            monitor
                .state()
                .await
                .panes
                .first()
                .is_some_and(|p| p.alternate_on && p.mouse_any_flag)
        },
    )
    .await;
    let state = monitor.state().await;

    assert_eq!(state.panes.len(), 1, "one pane: {:?}", state.panes);
    assert_eq!(state.windows.len(), 1);
    assert_eq!(monitor.errors(), Vec::<String>::new());
}
