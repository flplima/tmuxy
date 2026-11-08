//! Which process listens on a port, asked of the OS. `tmuxy server stop` and
//! `status` reach for it when the port's pid file is missing or names a
//! process that is gone: the port is a server's identity, the pid file a
//! shortcut to it.

/// The pid of a process with a TCP socket in LISTEN on `port`, on any local
/// address, among the processes this user can see.
#[cfg(target_os = "linux")]
pub(super) fn listening_pid(port: u16) -> Option<u32> {
    let inodes: Vec<u64> = ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .filter_map(|table| std::fs::read_to_string(table).ok())
        .flat_map(|table| listening_inodes(&table, port))
        .collect();
    if inodes.is_empty() {
        return None;
    }
    pid_holding_socket(&inodes)
}

/// The pid of a process with a TCP socket in LISTEN on `port`, on any local
/// address, as `lsof` reports it.
#[cfg(all(unix, not(target_os = "linux")))]
pub(super) fn listening_pid(port: u16) -> Option<u32> {
    let out = std::process::Command::new("lsof")
        .args(["-nP", "-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| line.trim().parse().ok())
}

/// The socket inodes of `/proc/net/tcp{,6}` rows in LISTEN (state `0A`) on
/// `port`: columns are `sl local_address rem_address st tx_queue:rx_queue
/// tr:tm->when retrnsmt uid timeout inode …`, the port the hex after the
/// local address's colon.
#[cfg(any(target_os = "linux", test))]
fn listening_inodes(table: &str, port: u16) -> Vec<u64> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let local = fields.nth(1)?;
            let state = fields.nth(1)?;
            let inode = fields.nth(5)?;
            let (_, local_port) = local.rsplit_once(':')?;
            (state == "0A" && u16::from_str_radix(local_port, 16).ok()? == port)
                .then(|| inode.parse().ok())
                .flatten()
        })
        .collect()
}

/// The process whose `/proc/<pid>/fd/` holds one of `inodes` as `socket:[N]`.
#[cfg(target_os = "linux")]
fn pid_holding_socket(inodes: &[u64]) -> Option<u32> {
    let targets: Vec<String> = inodes.iter().map(|i| format!("socket:[{i}]")).collect();
    std::fs::read_dir("/proc")
        .ok()?
        .flatten()
        .find_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            let fds = std::fs::read_dir(entry.path().join("fd")).ok()?;
            fds.flatten()
                .filter_map(|fd| std::fs::read_link(fd.path()).ok())
                .any(|link| targets.iter().any(|t| link.as_os_str() == t.as_str()))
                .then_some(pid)
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_proc_net_tcp_table_yields_the_listening_sockets_inode_on_the_port_only() {
        // Port 0x2328 = 9000: one LISTEN row (inode 41001), one ESTABLISHED
        // row on the same port (inode 41002), one LISTEN row on 9001.
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                     \x20  0: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0\n\
                     \x20  1: 0100007F:2328 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 20 4 30 10 -1\n\
                     \x20  2: 00000000:2329 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41003 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(super::listening_inodes(table, 9000), vec![41001]);
        assert_eq!(super::listening_inodes(table, 9001), vec![41003]);
        assert!(super::listening_inodes(table, 9002).is_empty());

        let table6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                      \x20  0: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52001 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(super::listening_inodes(table6, 9000), vec![52001]);
    }

    #[cfg(unix)]
    #[test]
    fn the_process_listening_on_a_port_is_found_through_the_os() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(super::listening_pid(port), Some(std::process::id()));
        drop(listener);
        assert_eq!(super::listening_pid(port), None);
    }
}
