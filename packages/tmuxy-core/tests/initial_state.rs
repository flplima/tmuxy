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

use tmuxy_core::control_mode::{LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor};
use tmuxy_core::{executor, Ctx, StateUpdate};

struct Quiet;
impl LogSink for Quiet {}
impl StateEmitter for Quiet {
    fn emit_state(&self, _update: StateUpdate) {}
    fn emit_error(&self, error: String) {
        panic!("unexpected error: {error}");
    }
}

#[tokio::test]
async fn the_initial_state_knows_the_modes_a_program_set_before_the_client_attached() {
    let socket = format!("tmuxy-initial-state-{}", std::process::id());
    std::env::set_var("TMUX_SOCKET", &socket);

    // A full-screen, mouse-tracking program is already running when the
    // monitor attaches — the way Claude Code is when the desktop app restarts.
    executor::execute_tmux_command(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "printf '\\033[?1049h\\033[?1000h\\033[?1006h'; sleep 60",
    ])
    .unwrap();

    let config = MonitorConfig {
        session: "app".to_string(),
        create_session: false,
        ..Default::default()
    };
    let (mut monitor, tx) = TmuxMonitor::connect(config, None, Ctx::live())
        .await
        .expect("control-mode connection on the scratch socket");
    let runner = tokio::spawn(async move { monitor.run(&Quiet).await });

    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::GetState { reply }).await.unwrap();
    let state = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .expect("the initial state arrives")
        .expect("the monitor answered");

    assert_eq!(state.panes.len(), 1, "one pane: {:?}", state.panes);
    let pane = &state.panes[0];
    assert!(pane.alternate_on, "the alternate screen is reported");
    assert!(pane.mouse_any_flag, "mouse tracking is reported");
    assert_eq!(state.windows.len(), 1);

    tx.send(MonitorCommand::Shutdown).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), runner).await;
    let _ = executor::execute_tmux_command(&["kill-server"]);
}
