//! A tmux server over SSH runs on another machine, which cannot read this
//! one's config chain: every path that hands the chain to tmux (the `-f` of
//! a new server, the `source-file` of a connect or a reload) asks
//! `get_config_path`, and over SSH it has nothing to give. Its own binary,
//! since the connect target is process-wide.

use tmuxy_core::session::{get_config_path, set_connect_target, ConnectTarget};

#[test]
fn a_server_over_ssh_is_never_handed_this_machines_config_chain() {
    set_connect_target(ConnectTarget {
        socket: "tmuxy-test".to_string(),
        session: "tmuxy".to_string(),
        ssh: Some("-p 2222 user@remote".to_string()),
    });
    assert_eq!(get_config_path(), None);
}
