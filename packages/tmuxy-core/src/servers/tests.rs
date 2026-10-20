use super::*;

/// The "my tmux" entry is not offered when tmuxy is already attached to
/// that server — `localhost` IS it, and two rows for one server is how a
/// picker teaches someone the wrong thing about where their work lives.
#[test]
fn my_tmux_is_not_offered_twice() {
    // A list that already names the user's own socket gets nothing added,
    // whatever the id on that entry happens to be.
    let existing = vec![
        Server::localhost_on("tmuxy"),
        Server {
            id: "local-default".to_string(),
            label: "default".to_string(),
            kind: ServerKind::Local,
            ssh: None,
            socket: USERS_OWN_SOCKET.to_string(),
            session: None,
            last_used: None,
            reachable: None,
            session_count: None,
            extra: serde_json::Map::new(),
        },
    ];
    let listed = with_users_own_tmux(existing);
    assert_eq!(
        listed
            .iter()
            .filter(|s| s.socket == USERS_OWN_SOCKET)
            .count(),
        1
    );
    assert!(!listed.iter().any(|s| s.id == MY_TMUX_ID));
}

#[test]
fn localhost_follows_the_live_socket() {
    // `localhost` means "the server this app is attached to". While it
    // meant "the socket named `tmuxy`", connecting to that row from an app
    // launched on another socket retargeted the live monitor onto a
    // different tmux server.
    let server = Server::localhost_on("tmuxy-deskdemo");
    assert_eq!(server.id, LOCALHOST_ID);
    let (socket, ssh) = server.connect_env();
    assert_eq!(socket, "tmuxy-deskdemo");
    assert_eq!(ssh, None);
}

#[test]
fn localhost_is_local_with_no_ssh() {
    let (socket, ssh) = Server::localhost().connect_env();
    assert_eq!(socket, crate::session::tmux_socket());
    assert_eq!(ssh, None);
}

#[test]
fn ssh_tail_orders_options_port_then_destination() {
    let cfg = SshConfig {
        host: "box".to_string(),
        user: Some("felipe".to_string()),
        port: Some(2222),
        options: Some("-i ~/.ssh/id_ed25519".to_string()),
    };
    assert_eq!(
        cfg.argv_tail(),
        vec!["-i", "~/.ssh/id_ed25519", "-p", "2222", "felipe@box"]
    );
}

#[test]
fn ssh_tail_bare_host_when_no_user_or_port() {
    let cfg = SshConfig {
        host: "example.com".to_string(),
        user: None,
        port: None,
        options: None,
    };
    assert_eq!(cfg.argv_tail(), vec!["example.com"]);
}

#[test]
fn ssh_server_connect_env_carries_the_tail() {
    let server = Server {
        id: "ssh-box".to_string(),
        label: "felipe@box".to_string(),
        kind: ServerKind::Ssh,
        ssh: Some(SshConfig {
            host: "box".to_string(),
            user: Some("felipe".to_string()),
            port: None,
            options: None,
        }),
        socket: "tmuxy".to_string(),
        session: None,
        last_used: None,
        reachable: None,
        session_count: None,
        extra: serde_json::Map::new(),
    };
    let (socket, ssh) = server.connect_env();
    assert_eq!(socket, "tmuxy");
    assert_eq!(ssh.as_deref(), Some("felipe@box"));
}

#[test]
fn unknown_keys_survive_a_roundtrip() {
    let json = r#"[{"id":"x","label":"X","kind":"ssh","socket":"tmuxy","ssh":{"host":"h"},"futureField":42}]"#;
    let servers: Vec<Server> = serde_json::from_str(json).unwrap();
    let back = serde_json::to_string(&servers).unwrap();
    assert!(back.contains("futureField"));
}

#[test]
fn ssh_kind_without_block_is_treated_as_local() {
    let server = Server {
        id: "broken".to_string(),
        label: "broken".to_string(),
        kind: ServerKind::Ssh,
        ssh: None,
        socket: "tmuxy".to_string(),
        session: None,
        last_used: None,
        reachable: None,
        session_count: None,
        extra: serde_json::Map::new(),
    };
    assert_eq!(server.connect_env().1, None);
}

#[test]
fn enrich_and_scan_sockets_discovers_live_local_sockets_and_skips_test_sockets() {
    let dir = std::env::temp_dir().join(format!("tmuxy-scan-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(dir.join("tmuxy"), b"").unwrap();
    std::fs::write(dir.join("work"), b"").unwrap();
    std::fs::write(dir.join("dead"), b"").unwrap();
    std::fs::write(dir.join("tmuxy-test-123"), b"").unwrap();
    std::fs::write(dir.join("tmuxy-reply-test-54953"), b"").unwrap();
    std::fs::write(dir.join("tmuxy-enforced-settings-11220"), b"").unwrap();

    let base = vec![
        Server::localhost_on("tmuxy"),
        Server {
            id: "ssh-user-prod-tmuxy".to_string(),
            label: "user@prod".to_string(),
            kind: ServerKind::Ssh,
            ssh: Some(SshConfig {
                host: "prod".to_string(),
                user: Some("user".to_string()),
                port: None,
                options: None,
            }),
            socket: "tmuxy".to_string(),
            session: None,
            last_used: None,
            reachable: None,
            session_count: None,
            extra: serde_json::Map::new(),
        },
    ];
    let enriched = enrich_and_scan_sockets(
        base,
        std::slice::from_ref(&dir),
        "tmuxy",
        None,
        |sock| match sock {
            "work" => Some(3),
            _ => None,
        },
    );
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(enriched.len(), 3);
    assert_eq!(enriched[0].id, LOCALHOST_ID);
    assert_eq!(enriched[0].reachable, Some(ServerReachability::Online));
    assert_eq!(enriched[1].id, "ssh-user-prod-tmuxy");
    assert_eq!(enriched[1].reachable, Some(ServerReachability::Known));
    assert_eq!(enriched[2].id, "local-work");
    assert_eq!(enriched[2].socket, "work");
    assert_eq!(enriched[2].reachable, Some(ServerReachability::Online));
    assert_eq!(enriched[2].session_count, Some(3));
}

#[test]
fn parse_session_list_filters_out_stash_session() {
    let out = "main\t3\t1\n__tmuxy_stash\t2\t0\nnotes\t1\t0\n";
    let sessions = parse_session_list(out);
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].name, "main");
    assert_eq!(sessions[0].windows, 3);
    assert!(sessions[0].attached);
    assert_eq!(sessions[1].name, "notes");
    assert_eq!(sessions[1].windows, 1);
    assert!(!sessions[1].attached);
}
