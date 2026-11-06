//! A pane cannot speak for tmux.
//!
//! What a pane shows reaches the monitor inside `capture-pane` replies, and
//! the monitor tells its own replies apart by the marker blocks around them
//! and by tmux's `%begin`/`%end` guards. A program that prints a line shaped
//! like one of those — `cat` of a hostile file is enough — must not be able to
//! close a capture early, open a reply, or end a block: before, a pane showing
//! the capture's closing marker left its capture pending forever, and every
//! client that connected after waited for a first state that never came.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::TmuxPane;

mod common;

/// What each pane prints, then holds on screen. Every line is something the
/// monitor once read as its own: a capture's END marker, a reply's BEGIN
/// marker, the buffer-read markers, and a `%end` guard followed by a
/// notification (`%exit` ended the monitor's connection).
const SPOOFS: [&str; 4] = [
    "TMUXY_CAP_END",
    "TMUXY_RPY_BEGIN 1",
    "TMUXY_BUF_BEGIN",
    "%end 0 0 1\n%exit",
];

fn screen_text(pane: &TmuxPane) -> String {
    pane.content
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.char.as_str())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn a_pane_printing_tmuxys_markers_cannot_stall_or_end_the_monitor() {
    let server = common::ScratchServer::new("spoof-test");

    // Scaffolding before any control-mode client exists: one pane per spoof,
    // each printing its lines and then holding them on screen.
    let show = |text: &str| {
        let printf = text.replace('%', "%%").replace('\n', "\\n");
        format!("printf '{printf}'; exec sleep 300")
    };
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "-x",
        "120",
        "-y",
        "40",
        &show(SPOOFS[0]),
    ])
    .unwrap();
    for spoof in &SPOOFS[1..] {
        common::tmux(&["split-window", "-t", "app", &show(spoof)]).unwrap();
    }
    // The monitor's first capture must see the spoof, not a pane that has not
    // printed yet.
    common::wait_until("every pane to print", Duration::from_secs(10), || async {
        let listing =
            common::tmux(&["list-panes", "-t", "app", "-F", "#{pane_id}"]).unwrap_or_default();
        let panes: Vec<String> = listing.lines().map(str::to_string).collect();
        panes.len() == SPOOFS.len()
            && panes.iter().all(|pane| {
                common::tmux(&["capture-pane", "-p", "-t", pane])
                    .is_ok_and(|screen| screen.trim().len() > 4)
            })
    })
    .await;

    let monitor = server.attach("app", false).await;

    // The first state waits for every pane's capture: it comes back only if
    // each capture landed on its own pane.
    let state = monitor.state().await;

    assert_eq!(state.panes.len(), SPOOFS.len(), "{:?}", state.panes);
    let screens: Vec<String> = state.panes.iter().map(screen_text).collect();
    for spoof in SPOOFS {
        assert!(
            screens.iter().any(|screen| screen.trim() == spoof),
            "a pane shows {spoof:?} as plain text: {screens:?}"
        );
    }

    // The connection is still up and replies still pair with their callers.
    let hello = monitor.ask("display-message -p STILL_ANSWERING").await;
    assert_eq!(hello.error, None);
    assert_eq!(hello.output.trim(), "STILL_ANSWERING");
}
