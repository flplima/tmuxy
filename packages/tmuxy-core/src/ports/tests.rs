use super::*;

fn table(parents: &[(u32, u32)], listening: &[(u32, &[u16])]) -> Processes {
    Processes {
        parents: parents.iter().copied().collect(),
        listening: listening
            .iter()
            .map(|(pid, ports)| (*pid, ports.to_vec()))
            .collect(),
    }
}

fn panes(list: &[(&str, u32)]) -> Vec<(String, u32)> {
    list.iter().map(|(p, pid)| (p.to_string(), *pid)).collect()
}

#[test]
fn the_pane_listing_is_read_and_what_is_not_a_pane_is_dropped() {
    let listing = "%1 4242\n%12 777\n\n@3 99\n%4 1\n%5 x\n%6 0\n";
    assert_eq!(pane_pids(listing), panes(&[("%1", 4242), ("%12", 777)]));
}

/// A pane's ports are those of its process and of every process below it,
/// however deep: a shell running a script running the server.
#[test]
fn a_pane_has_the_ports_of_every_process_below_it() {
    // %1: shell 10 -> npm 11 -> node 12 (:5173) and 13 (:24678)
    // %2: shell 20 -> python 21 (:8123, :8124)
    // %3: shell 30, nothing listening
    // 40, outside every pane, listens on :9000
    let processes = table(
        &[
            (11, 10),
            (12, 11),
            (13, 11),
            (21, 20),
            (40, 1),
            (10, 1),
            (20, 1),
            (30, 1),
        ],
        &[
            (12, &[5173]),
            (13, &[24678]),
            (21, &[8124, 8123]),
            (40, &[9000]),
        ],
    );
    assert_eq!(
        ports_of(&panes(&[("%1", 10), ("%2", 20), ("%3", 30)]), &processes),
        vec![
            PanePorts {
                pane_id: "%1".into(),
                ports: vec![5173, 24678]
            },
            PanePorts {
                pane_id: "%2".into(),
                ports: vec![8123, 8124]
            },
        ]
    );
}

#[test]
fn a_port_held_twice_shows_once_and_a_row_shows_at_most_eight() {
    let many: Vec<u16> = (3000..3020).collect();
    let processes = table(
        &[(11, 10), (12, 10)],
        &[(11, &[8080]), (12, &[8080]), (10, &many)],
    );
    let found = ports_of(&panes(&[("%1", 10)]), &processes);
    assert_eq!(found[0].ports.len(), MAX_PORTS_PER_PANE);
    assert_eq!(found[0].ports[0], 3000);
    let twice = table(&[(11, 10), (12, 10)], &[(11, &[8080]), (12, &[8080])]);
    assert_eq!(ports_of(&panes(&[("%1", 10)]), &twice)[0].ports, vec![8080]);
}

/// A table read while processes come and go can say anything: a loop in it
/// ends, it does not hang the request.
#[test]
fn a_loop_in_the_process_table_ends() {
    let looped = table(&[(10, 11), (11, 10)], &[(11, &[7000])]);
    assert_eq!(
        ports_of(&panes(&[("%1", 10)]), &looped)[0].ports,
        vec![7000]
    );
}

#[test]
fn ps_and_lsof_are_read() {
    let ps = "    1     0\n  501     1\n  777   501\nnot a line\n";
    assert_eq!(
        output::parse_ps(ps),
        [(1, 0), (501, 1), (777, 501)].into_iter().collect()
    );
    let lsof = "p777\nn*:8123\nn127.0.0.1:8124\nn[::1]:8123\np900\nn[::]:5173\nnwhat\n";
    let listening = output::parse_lsof(lsof);
    assert_eq!(listening[&777], vec![8123, 8124]);
    assert_eq!(listening[&900], vec![5173]);
}

#[cfg(target_os = "linux")]
mod on_linux {
    use super::super::linux::{listening_sockets, parent_in_stat, read_from};
    use super::*;
    use std::path::Path;

    #[test]
    fn a_stat_line_names_its_parent_whatever_the_command_is_called() {
        assert_eq!(parent_in_stat("42 (bash) S 7 42 42 0"), Some(7));
        assert_eq!(parent_in_stat("42 (a) b) (c) R 9 1 1"), Some(9));
        assert_eq!(parent_in_stat("42 (tmux: server) S 1 1"), Some(1));
        assert_eq!(parent_in_stat("garbage"), None);
    }

    #[test]
    fn only_sockets_in_listen_are_taken_from_the_tcp_tables() {
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:1FBB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5550 1\n\
   1: 0100007F:A3F2 0100007F:1FBB 01 00000000:00000000 00:00000000 00000000  1000        0 5551 1\n\
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1\n";
        assert_eq!(listening_sockets(tcp), [(5550, 8123)].into_iter().collect());
    }

    /// A `/proc` of its own: a pane's shell, a server under it holding a
    /// listening socket, and another process holding a socket that is not
    /// listening.
    #[test]
    fn a_proc_tree_is_walked_from_the_pane_down() {
        let root = std::env::temp_dir().join(format!("tmuxy-ports-proc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let process = |pid: u32, parent: u32, sockets: &[u64]| {
            let dir = root.join(pid.to_string());
            std::fs::create_dir_all(dir.join("fd")).unwrap();
            std::fs::write(dir.join("stat"), format!("{pid} (p {pid}) S {parent} 0 0")).unwrap();
            for (fd, inode) in sockets.iter().enumerate() {
                std::os::unix::fs::symlink(
                    format!("socket:[{inode}]"),
                    dir.join("fd").join(fd.to_string()),
                )
                .unwrap();
            }
        };
        process(10, 1, &[]);
        process(11, 10, &[777]);
        process(12, 11, &[888]);
        std::fs::create_dir_all(root.join("net")).unwrap();
        let header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
        std::fs::write(
            root.join("net/tcp"),
            format!("{header}   0: 0100007F:1FBB 00000000:0000 0A 0:0 0:0 0 1000 0 777 1\n   1: 0100007F:2000 0100007F:1FBB 01 0:0 0:0 0 1000 0 888 1\n"),
        )
        .unwrap();
        std::fs::write(
            root.join("net/tcp6"),
            format!("{header}   0: 00000000000000000000000001000000:1F40 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 888 1\n"),
        )
        .unwrap();

        let processes = read_from(&root, &[10]);
        assert_eq!(
            ports_of(&panes(&[("%1", 10)]), &processes),
            vec![PanePorts {
                pane_id: "%1".into(),
                ports: vec![8000, 8123]
            }]
        );
        let _ = std::fs::remove_dir_all(&root);
        assert!(Path::new("/proc").exists());
    }

    /// The real table: this test process listens, as a pane's program would.
    #[test]
    fn a_process_listening_now_is_found_under_its_pane() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        let found = listening_ports(&panes(&[("%1", me)]));
        assert!(
            found
                .iter()
                .any(|p| p.pane_id == "%1" && p.ports.contains(&port)),
            "{found:?} has no :{port}"
        );
        drop(listener);
        let found = listening_ports(&panes(&[("%1", me)]));
        assert!(!found.iter().any(|p| p.ports.contains(&port)), "{found:?}");
    }
}
