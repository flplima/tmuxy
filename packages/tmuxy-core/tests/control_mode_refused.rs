//! A tmux that reaches control mode but refuses the command it was started
//! with, against a real tmux on a scratch socket: the connect fails with
//! tmux's own words rather than counting tmux's `%exit` as a connection
//! (X7 in `docs/INVARIANTS.md`). Its own binary, since the socket is
//! process-wide.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tmuxy_core::control_mode::ControlModeConnection;

mod common;

#[tokio::test]
async fn a_session_tmux_refuses_to_create_is_no_connection() {
    let _server = common::ScratchServer::new("refused-test");

    // tmux names no session "": `new-session` answers in the opening
    // block with `%error`, then the client exits.
    let outcome = ControlModeConnection::connect("", None, None, true, None, None).await;

    let message = outcome.err().expect("no connection").to_string();
    assert!(
        message.contains("tmux refused control mode") && message.contains("invalid session"),
        "{message}"
    );
    // tmux's words are the opening block's body, not its raw transcript:
    // `-CC` glues its DCS to that block's `%begin`.
    assert!(!message.contains("%error"), "{message}");
}
