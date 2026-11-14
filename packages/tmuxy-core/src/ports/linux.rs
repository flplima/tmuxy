//! The process table from `/proc`: each process's parent from its `stat`,
//! the listening sockets from `/proc/net/tcp` and `tcp6`, and which process
//! holds which socket from its open files. Only the processes under a pane
//! have their files read.

use std::collections::HashMap;
use std::path::Path;

use super::{descendants, Processes};

pub(super) fn read(roots: &[u32]) -> Processes {
    read_from(Path::new("/proc"), roots)
}

pub(super) fn read_from(proc: &Path, roots: &[u32]) -> Processes {
    let mut parents = HashMap::new();
    for entry in std::fs::read_dir(proc).into_iter().flatten().flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if let Some(parent) = std::fs::read_to_string(entry.path().join("stat"))
            .ok()
            .and_then(|stat| parent_in_stat(&stat))
        {
            parents.insert(pid, parent);
        }
    }

    let mut sockets: HashMap<u64, u16> = HashMap::new();
    for table in ["net/tcp", "net/tcp6"] {
        if let Ok(text) = std::fs::read_to_string(proc.join(table)) {
            sockets.extend(listening_sockets(&text));
        }
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &parent) in &parents {
        children.entry(parent).or_default().push(pid);
    }
    let mut listening = HashMap::new();
    if !sockets.is_empty() {
        for &root in roots {
            for pid in descendants(root, &children) {
                let ports = ports_held(&proc.join(pid.to_string()).join("fd"), &sockets);
                if !ports.is_empty() {
                    listening.insert(pid, ports);
                }
            }
        }
    }
    Processes { parents, listening }
}

/// The parent in a `/proc/<pid>/stat` line, `pid (comm) state ppid …`. The
/// command name can hold spaces and parentheses, so the fields are counted
/// from the last `)`.
pub(super) fn parent_in_stat(stat: &str) -> Option<u32> {
    let (_, rest) = stat.rsplit_once(')')?;
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Socket inode to port, for the sockets in LISTEN (`0A`) in a
/// `/proc/net/tcp` table.
pub(super) fn listening_sockets(table: &str) -> HashMap<u64, u16> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.get(3) != Some(&"0A") {
                return None;
            }
            let (_, port) = fields.get(1)?.rsplit_once(':')?;
            let port = u16::from_str_radix(port, 16).ok().filter(|p| *p > 0)?;
            let inode = fields.get(9)?.parse().ok().filter(|i| *i > 0)?;
            Some((inode, port))
        })
        .collect()
}

/// The ports of the listening sockets among the open files in `fd_dir`.
fn ports_held(fd_dir: &Path, sockets: &HashMap<u64, u16>) -> Vec<u16> {
    let mut ports: Vec<u16> = std::fs::read_dir(fd_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|fd| std::fs::read_link(fd.path()).ok())
        .filter_map(|target| {
            let target = target.to_str()?;
            let inode = target.strip_prefix("socket:[")?.strip_suffix(']')?;
            sockets.get(&inode.parse().ok()?).copied()
        })
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}
