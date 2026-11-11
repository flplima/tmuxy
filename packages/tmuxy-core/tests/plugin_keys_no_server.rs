//! The plugin keys' reads of the key tables, with no tmux server running.
//!
//! `tmuxy plugin install`'s gate and `tmuxy plugin info` ask which keys a
//! binding of the user's holds, and `install` binds a plugin's keys. tmux
//! starts a server to answer `list-keys`, and a server started that way reads
//! the user's own `~/.tmux.conf`, which may run anything: with no server
//! running, nothing may start one, and nothing holds a key.
//!
//! Needs a `tmux` binary; the socket name is unique per process and no
//! server is ever started on it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use tmuxy_core::plugins::manifest::KeyTable;

#[test]
fn with_no_server_running_the_key_reads_start_none_and_nothing_holds_a_key() {
    let server = common::ScratchServer::process_wide("plugin-keys-idle");
    let no_server = || {
        let out = tmuxy_core::session::local_tmux_on(&server.socket)
            .args(["-N", "list-sessions"])
            .output()
            .unwrap();
        !out.status.success()
            && tmuxy_core::session::is_no_server(&String::from_utf8_lossy(&out.stderr))
    };
    assert!(no_server());

    for table in [KeyTable::Prefix, KeyTable::Root] {
        assert_eq!(tmuxy_core::plugins::keys::user_binding(table, "M-a"), None);
    }
    let layout = tmuxy_core::paths::Layout {
        config: server.home.join("config"),
        data: server.home.join("data"),
        state: server.home.join("state"),
        home: server.home.clone(),
    };
    assert_eq!(
        tmuxy_core::plugins::keys::apply(&layout).unwrap(),
        Vec::new()
    );

    assert!(no_server(), "a key read started a tmux server");
}
