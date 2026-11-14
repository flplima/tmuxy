//! A read about a pane answers for that pane or not at all. tmux's
//! `display-message -t` does not fail when the target is gone: it answers
//! for no pane, or for its default one when a client is attached, so a raw
//! read of a closed pane says nothing true about it. `ask::pane_read`
//! refuses any answer that is not the pane's own.
//!
//! Needs a `tmux` binary; the socket is unique per process and no
//! control-mode client is attached.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tmuxy_core::ask;
use tmuxy_core::{ErrorKind, PaneId};

#[path = "common/real_tmux.rs"]
mod real_tmux;
#[path = "common/scratch.rs"]
mod scratch;

#[tokio::test]
async fn a_read_about_a_gone_pane_is_refused_not_answered_by_another() {
    let s =
        scratch::ScratchServer::with_session(&format!("pane-read-{}", std::process::id()), 100, 30);
    let gone = s.tmux(&[
        "split-window",
        "-d",
        "-t",
        "work:0",
        "-P",
        "-F",
        "#{pane_id}",
    ]);
    let stays = s.tmux(&["display-message", "-p", "-t", "work:0.0", "#{pane_id}"]);
    s.tmux(&[
        "set-option",
        "-p",
        "-t",
        &stays,
        "@tmuxy-pane-state",
        "idle",
    ]);
    s.tmux(&["kill-pane", "-t", &gone]);

    // tmux does not refuse the gone pane's read: it succeeds, answering for
    // no pane (no client here) or for its default one (with a client).
    let raw = s.tmux(&["display-message", "-p", "-t", &gone, "#{pane_id}"]);
    assert_ne!(raw, gone);

    let tmux = real_tmux::RealTmux(&s.socket);
    let refused = ask::pane_read(
        &tmux,
        &PaneId::parse(&gone).unwrap(),
        "#{@tmuxy-pane-state}",
    )
    .await;
    let error = refused.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Tmux);
    assert!(error.error.contains("is gone"), "{}", error.error);

    let answered = ask::pane_read(
        &tmux,
        &PaneId::parse(&stays).unwrap(),
        "#{@tmuxy-pane-state}",
    )
    .await
    .unwrap();
    assert_eq!(answered.trim(), "idle");
}
