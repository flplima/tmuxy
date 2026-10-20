//! Local socket scanning and reachability enrichment.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{read_servers_strict, slug, write_servers, Server, ServerKind, MY_TMUX_ID};
use crate::constants::STASH_SESSION;
use crate::session::USERS_OWN_SOCKET;

/// Reachability state displayed as the status dot on a server row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerReachability {
    /// Live local socket or verified reachable server.
    Online,
    /// Saved server not yet probed in this session.
    Known,
    /// Probe failed or server unreachable.
    Offline,
}

/// Summary of a tmux session on a server, as `list-sessions` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteSessionInfo {
    pub name: String,
    pub windows: usize,
    pub attached: bool,
}

/// Current UNIX timestamp in seconds.
pub fn now_unix_secs() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Record a fresh `last_used` timestamp (and optional preferred session) for a
/// saved server in `servers.json`.
pub fn touch_server(id: &str, session: Option<&str>) -> std::io::Result<()> {
    let mut servers = read_servers_strict()?.unwrap_or_default();
    if let Some(existing) = servers.iter_mut().find(|s| s.id == id) {
        existing.last_used = now_unix_secs();
        if let Some(sess) = session.filter(|s| !s.is_empty()) {
            existing.session = Some(sess.to_string());
        }
        write_servers(&servers)?;
    }
    Ok(())
}

/// Whether a socket name belongs to an automated test harness rather than a
/// user server.
pub fn is_ephemeral_test_socket(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "tmuxy-test",
        "tmuxy-e2e",
        "tmuxy-cli",
        "tmuxy-snap",
        "tmuxy-bench",
        "tmuxy-probe",
        "tmuxy-enforced-settings",
        "tmuxy-pin-race",
        "tmuxy-initial-",
        "tmuxy-reply-test",
        "tmuxy-pane-groups",
        "tmuxy-repro",
    ];
    if PREFIXES.iter().any(|p| name.starts_with(p)) {
        return true;
    }
    // Any `tmuxy-<suite>-<pid>` socket left behind by an integration test.
    if name.starts_with("tmuxy-")
        && name
            .rsplit_once('-')
            .is_some_and(|(_, tail)| !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()))
    {
        return true;
    }
    false
}

/// Candidate `tmux-<uid>` directories owned/readable by the current user.
pub fn tmux_socket_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(custom) = std::env::var("TMUXY_SOCKET_DIR") {
        let p = PathBuf::from(custom);
        if p.is_dir() {
            dirs.push(std::fs::canonicalize(&p).unwrap_or(p));
            return dirs;
        }
    }
    let mut roots = Vec::new();
    if let Ok(tmpdir) = std::env::var("TMUX_TMPDIR") {
        if !tmpdir.is_empty() {
            roots.push(PathBuf::from(tmpdir));
        }
    }
    roots.push(PathBuf::from("/tmp"));
    roots.push(PathBuf::from("/private/tmp"));

    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if !name_str.starts_with("tmux-") {
                continue;
            }
            let path = entry.path();
            // Tmux creates `tmux-$UID` mode 0700, so `read_dir` succeeds only
            // for the current user's socket directory. Canonicalize so `/tmp`
            // and `/private/tmp` on macOS do not scan the same directory twice.
            if std::fs::read_dir(&path).is_ok() {
                let canonical = std::fs::canonicalize(&path).unwrap_or(path);
                if !dirs.contains(&canonical) {
                    dirs.push(canonical);
                }
            }
        }
    }
    dirs
}

fn socket_mtime(socket: &str) -> Option<SystemTime> {
    if socket.contains('/') {
        return std::fs::metadata(socket).ok()?.modified().ok();
    }
    for dir in tmux_socket_dirs() {
        if let Ok(meta) = std::fs::metadata(dir.join(socket)) {
            if let Ok(mtime) = meta.modified() {
                return Some(mtime);
            }
        }
    }
    None
}

fn dead_socket_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, Option<SystemTime>>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Option<SystemTime>>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Count non-stash sessions on a local tmux socket that is NOT the live
/// control-mode socket. Returns `None` if no server is running on that socket.
pub fn query_local_socket_sessions(socket: &str) -> Option<usize> {
    let mtime = socket_mtime(socket);
    if let Ok(cache) = dead_socket_cache().lock() {
        if let Some(cached_mtime) = cache.get(socket) {
            if *cached_mtime == mtime {
                return None;
            }
        }
    }
    let flag = if socket.contains('/') { "-S" } else { "-L" };
    let out = Command::new("tmux")
        .args([flag, socket, "list-sessions", "-F", "#{session_name}"])
        .output()
        .ok()?;
    if !out.status.success() {
        if let Ok(mut cache) = dead_socket_cache().lock() {
            cache.insert(socket.to_string(), mtime);
        }
        return None;
    }
    if let Ok(mut cache) = dead_socket_cache().lock() {
        cache.remove(socket);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let count = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != STASH_SESSION)
        .count();
    if count == 0 {
        None
    } else {
        Some(count)
    }
}

/// Merge discovered local sockets from `socket_dirs` and populate reachability
/// and session counts on all entries.
pub fn enrich_and_scan_sockets(
    mut servers: Vec<Server>,
    socket_dirs: &[PathBuf],
    live_socket: &str,
    live_ssh: Option<&str>,
    mut query_sessions: impl FnMut(&str) -> Option<usize>,
) -> Vec<Server> {
    for server in &mut servers {
        let (s_sock, s_ssh) = server.connect_env();
        if s_sock == live_socket && s_ssh.as_deref() == live_ssh {
            server.reachable = Some(ServerReachability::Online);
            continue;
        }
        match server.kind {
            ServerKind::Local => match query_sessions(&server.socket) {
                Some(count) => {
                    server.reachable = Some(ServerReachability::Online);
                    server.session_count = Some(count);
                }
                None => {
                    server.reachable.get_or_insert(ServerReachability::Known);
                    server.session_count.get_or_insert(0);
                }
            },
            ServerKind::Ssh => {
                server.reachable.get_or_insert(ServerReachability::Known);
            }
        }
    }

    for dir in socket_dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        for sock_name in names {
            if sock_name.is_empty() || is_ephemeral_test_socket(&sock_name) {
                continue;
            }
            if live_ssh.is_none() && sock_name == live_socket {
                continue;
            }
            if servers
                .iter()
                .any(|s| s.kind == ServerKind::Local && s.socket == sock_name)
            {
                continue;
            }
            let Some(count) = query_sessions(&sock_name) else {
                continue;
            };
            let (id, label) = if sock_name == USERS_OWN_SOCKET {
                (MY_TMUX_ID.to_string(), "my tmux".to_string())
            } else {
                (format!("local-{}", slug(&sock_name)), sock_name.clone())
            };
            servers.push(Server {
                id,
                label,
                kind: ServerKind::Local,
                ssh: None,
                socket: sock_name,
                session: None,
                last_used: None,
                reachable: Some(ServerReachability::Online),
                session_count: Some(count),
                extra: serde_json::Map::new(),
            });
        }
    }

    servers
}

pub fn parse_session_list(stdout: &str) -> Vec<RemoteSessionInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.split('\t');
            let name = parts.next()?.trim();
            if name.is_empty() || name == STASH_SESSION {
                return None;
            }
            let windows = parts
                .next()
                .and_then(|w| w.trim().parse::<usize>().ok())
                .unwrap_or(1);
            let attached = parts
                .next()
                .map(|a| a.trim() != "0" && !a.trim().is_empty())
                .unwrap_or(false);
            Some(RemoteSessionInfo {
                name: name.to_string(),
                windows,
                attached,
            })
        })
        .collect()
}
