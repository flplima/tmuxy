use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::{read_servers_strict, slug, write_servers, Server, ServerKind, MY_TMUX_ID};
use crate::constants::STASH_SESSION;
use crate::session::{tmux_socket_dirs, USERS_OWN_SOCKET};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteSessionInfo {
    pub name: String,
    pub windows: usize,
    pub attached: bool,
}

pub fn now_unix_secs() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Stamp `last_used` (and the session, when given) on a saved server.
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

fn socket_mtime(socket: &str) -> Option<SystemTime> {
    if crate::session::is_socket_path(socket) {
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

/// How long a look at another tmux server on this machine may take. A server
/// that is stopped (a `SIGSTOP`, a debugger) keeps its socket and never
/// answers, and a look is taken on every connect and every poll of the tree.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// What `command` printed, or `None` when it could not be run or has not
/// ended within `limit`; it is killed then, so a look leaves no process
/// behind. For a command that prints little: its output is read at the end.
pub(super) fn output_within(mut command: Command, limit: Duration) -> Option<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The non-stash sessions on a local tmux socket that is NOT the live
/// control-mode socket, in tmux's order. `None` when no server is running on
/// that socket, or it holds nothing but the stash.
pub fn local_socket_session_names(socket: &str) -> Option<Vec<String>> {
    let mtime = socket_mtime(socket);
    if let Ok(cache) = dead_socket_cache().lock() {
        if let Some(cached_mtime) = cache.get(socket) {
            if *cached_mtime == mtime {
                return None;
            }
        }
    }
    let mut look = crate::session::local_tmux_on(socket);
    look.args(["list-sessions", "-F", "#{session_name}"]);
    // No answer in time is not "no server": nothing is cached, so the server
    // is found again once it answers.
    let out = output_within(look, PROBE_TIMEOUT)?;
    if !out.status.success() {
        if let Ok(mut cache) = dead_socket_cache().lock() {
            cache.insert(socket.to_string(), mtime);
        }
        return None;
    }
    if let Ok(mut cache) = dead_socket_cache().lock() {
        cache.remove(socket);
    }
    let names: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != STASH_SESSION)
        .map(String::from)
        .collect();
    (!names.is_empty()).then_some(names)
}

/// How many sessions [`local_socket_session_names`] finds on `socket`.
pub fn query_local_socket_sessions(socket: &str) -> Option<usize> {
    local_socket_session_names(socket).map(|names| names.len())
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

/// The separator of [`LIST_SESSIONS`]'s fields. Only the name can hold it,
/// and the name is the first field, so a row is split from the right.
pub(super) const SESSION_FIELD_SEP: char = '|';

/// The row [`parse_session_list`] reads, as a `list-sessions -F` format: name,
/// window count, attached clients.
pub const LIST_SESSIONS_FORMAT: &str = "#{session_name}|#{session_windows}|#{session_attached}";

/// The `list-sessions` command whose rows [`parse_session_list`] reads.
pub const LIST_SESSIONS: &str = concat!(
    "list-sessions -F '",
    "#{session_name}|#{session_windows}|#{session_attached}",
    "'"
);

/// The sessions [`LIST_SESSIONS`] printed, less tmuxy's stash. A row that does
/// not have its three fields is skipped.
pub fn parse_session_list(stdout: &str) -> Vec<RemoteSessionInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().rsplitn(3, SESSION_FIELD_SEP);
            let attached = fields.next()?.trim();
            let windows = fields.next()?.trim().parse::<usize>().ok()?;
            let name = fields.next()?.trim();
            if name.is_empty() || name == STASH_SESSION {
                return None;
            }
            Some(RemoteSessionInfo {
                name: name.to_string(),
                windows,
                attached: !attached.is_empty() && attached != "0",
            })
        })
        .collect()
}
