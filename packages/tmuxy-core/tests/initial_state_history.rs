//! A client's baseline reports the scrollback a pane really has.
//!
//! Copy mode asks the server for `start: -historySize .. height-1`. When the
//! initial state reported `history_size: 0` for every pane — the polling-mode
//! `list-panes` format string omitted `#{history_size}`, and the capture
//! hardcoded it — that range collapsed to the visible band, so scrolling up in
//! a pane with thousands of lines behind it showed nothing until a later
//! control-mode delta happened to deliver the real number.
//!
//! This is a server-side contract, so it is tested here rather than through a
//! browser: the state the monitor answers `GetState` with, which is what every
//! fresh client's `get_initial_state` returns.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

mod common;

#[tokio::test]
async fn the_initial_state_reports_the_scrollback_a_pane_already_has() {
    let server = common::ScratchServer::process_wide("initial-history");

    // Far more lines than any window is tall, so tmux has real history to
    // report, and the pane stays alive afterwards.
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "i=1; while [ $i -le 400 ]; do echo HISTMARK_$i; i=$((i+1)); done; sleep 60",
    ])
    .unwrap();

    // The loop has finished writing — its last line is in the history — before
    // the monitor reads list-panes.
    common::wait_until(
        "the pane to print its 400 lines",
        Duration::from_secs(10),
        || async {
            common::tmux(&["capture-pane", "-p", "-t", "app", "-S", "-"])
                .is_ok_and(|history| history.contains("HISTMARK_400"))
        },
    )
    .await;

    let monitor = server.attach("app", false).await;
    let state = monitor.state().await;

    assert_eq!(state.panes.len(), 1, "one pane: {:?}", state.panes);
    let pane = &state.panes[0];
    assert!(
        pane.history_size > 0,
        "the baseline carries the pane's scrollback, not a hardcoded 0 (history_size = {}, pane height = {})",
        pane.history_size,
        pane.height
    );
    // 400 lines into a window far shorter than that: most of them are history.
    assert!(
        pane.history_size >= u64::from(pane.height),
        "history_size {} is at least a screenful behind the {}-row viewport",
        pane.history_size,
        pane.height
    );
}
