//! A pane-group verb aimed at a pane that has closed fails with exit 3 and
//! changes nothing: tmux answers the closed pane's `display-message` for no
//! pane (or, with a client attached, for its default pane) and exits 0, so
//! the verb checks the id that answered.
//!
//! Needs a `tmux` binary; the socket is unique per process and no
//! control-mode client is attached.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Command;

#[path = "../../tmuxy-core/tests/common/scratch.rs"]
mod scratch;

#[test]
fn parking_beside_a_closed_pane_is_exit_3_and_makes_no_pane() {
    let s = scratch::ScratchServer::with_session(
        &format!("group-gone-{}", std::process::id()),
        100,
        30,
    );
    let gone = s.tmux(&[
        "split-window",
        "-d",
        "-t",
        "work:0",
        "-P",
        "-F",
        "#{pane_id}",
    ]);
    s.tmux(&["kill-pane", "-t", &gone]);
    let panes = || s.tmux(&["list-panes", "-a", "-F", "#{pane_id}"]);
    let before = panes();

    let out = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"))
        .args(["group", "park", &gone, "g1", "/"])
        .env("TMUX_SOCKET", &s.socket)
        .env("HOME", &s.home)
        .env("XDG_CONFIG_HOME", s.home.join("config"))
        .env("TMUXY_STATE_DIR", s.home.join("state"))
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .env_remove("TMUX_BIN")
        .output()
        .expect("tmuxy-server runs");
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains(&format!("no such pane: {gone}")),
        "{out:?}"
    );
    assert_eq!(panes(), before, "a pane was made");
}
