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
    // Were a read to start a server after all, it would read this home's
    // config, never the developer's own `~/.tmux.conf`.
    std::env::set_var("HOME", &server.home);
    std::env::set_var("XDG_CONFIG_HOME", server.home.join("config"));
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
    // The user's own plugin asks for a key: with no server it is planned,
    // held by nothing, and bound nowhere.
    let layout = tmuxy_core::paths::Layout {
        config: server.home.join("config/tmuxy"),
        data: server.home.join("data"),
        state: server.home.join("state"),
        home: server.home.clone(),
    };
    let script = layout.config.join("bin/hello");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, "#!/bin/sh\necho hello\n").unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(
        layout.user_plugin_manifest(),
        r#"[plugin]
api = 1
name = "user"
version = "0.1.0"

[[actions]]
id = "hello"
title = "Say hello"
surface = "popup"
command = ["bin/hello"]

[[keys]]
key = "M-h"
action = "hello"
"#,
    )
    .unwrap();
    let planned = tmuxy_core::plugins::keys::apply(&layout).unwrap();
    assert_eq!(planned.len(), 1, "{planned:?}");
    assert_eq!(
        (
            planned[0].plugin.as_str(),
            planned[0].action.as_str(),
            planned[0].key.as_str()
        ),
        ("user", "hello", "M-h")
    );
    assert_eq!(planned[0].taken_by, None);

    assert!(no_server(), "a key read started a tmux server");
}
