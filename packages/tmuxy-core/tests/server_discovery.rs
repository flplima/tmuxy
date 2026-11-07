//! The server picker's look at another local socket runs the tmux tmuxy
//! resolved, not whatever `tmux` the PATH holds: an app launched from a GUI
//! inherits a PATH without Homebrew or Nix (`session::tmux_path`). Its own
//! binary, since PATH is process-wide.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tmuxy_core::servers::query_local_socket_sessions;

mod common;

#[test]
fn another_socket_is_counted_with_the_resolved_tmux_on_a_path_without_one() {
    // Resolved (and kept) while the PATH still finds it.
    tmuxy_core::session::tmux_path();
    let server = common::ScratchServer::with_session("discovery", 80, 24);
    std::env::set_var("PATH", server.home.join("no-tmux-here"));

    assert_eq!(query_local_socket_sessions(&server.socket), Some(1));
}
