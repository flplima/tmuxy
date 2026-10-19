//! Local socket scanning, reachability enrichment, and staged server probing.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::{
    read_servers, read_servers_strict, slug, write_servers, Server, ServerKind, LOCALHOST_ID,
    MY_TMUX_ID,
};
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

/// Lifecycle state of one stage in the 4-step connect flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStageStatus {
    Pending,
    Running,
    Done,
    Failed,
}

/// One row in the Step 3 staged connecting view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeStage {
    pub id: String,
    pub label: String,
    pub status: ProbeStageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Summary of a tmux session discovered on a target server during Step 3.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteSessionInfo {
    pub name: String,
    pub windows: usize,
    pub attached: bool,
}

/// Complete result of probing a server across the connect stages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerProbeResult {
    pub server_id: String,
    pub ok: bool,
    pub stages: Vec<ProbeStage>,
    pub sessions: Vec<RemoteSessionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_version: Option<String>,
}

/// Current UNIX timestamp in seconds.
pub fn now_unix_secs() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Remove a saved server by `id` from `servers.json` and return the refreshed list.
pub fn remove_server(id: &str) -> std::io::Result<Vec<Server>> {
    let mut servers = read_servers_strict()?.unwrap_or_default();
    servers.retain(|s| s.id != id);
    write_servers(&servers)?;
    Ok(read_servers())
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
    ];
    PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Candidate `tmux-<uid>` directories owned/readable by the current user.
pub fn tmux_socket_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(custom) = std::env::var("TMUXY_SOCKET_DIR") {
        let p = PathBuf::from(custom);
        if p.is_dir() {
            dirs.push(p);
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
            // for the current user's socket directory.
            if std::fs::read_dir(&path).is_ok() && !dirs.contains(&path) {
                dirs.push(path);
            }
        }
    }
    dirs
}

/// Count non-stash sessions on a local tmux socket that is NOT the live
/// control-mode socket. Returns `None` if no server is running on that socket.
pub fn query_local_socket_sessions(socket: &str) -> Option<usize> {
    let flag = if socket.contains('/') { "-S" } else { "-L" };
    let out = Command::new("tmux")
        .args([flag, socket, "list-sessions", "-F", "#{session_name}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
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

fn build_tmux_args(socket: &str, tail: &[&str]) -> Vec<String> {
    let flag = if socket.contains('/') { "-S" } else { "-L" };
    let mut args = vec![flag.to_string(), socket.to_string()];
    args.extend(tail.iter().map(|s| (*s).to_string()));
    args
}

fn is_no_server_stderr(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("no server running")
        || lower.contains("no such file or directory")
        || lower.contains("no sessions")
        || lower.contains("connection refused")
}

/// Run the staged connect probe (`ssh` -> `tmux -V` -> `listing sessions` -> `attach`)
/// against `server`.
///
/// When `live_sessions` is `Some`, the target server IS the currently attached
/// control-mode server, so Stage 3 uses the in-memory session list instead of
/// spawning an external `tmux` client against the live socket.
pub fn probe_server(
    server: &Server,
    live_sessions: Option<Vec<RemoteSessionInfo>>,
) -> ServerProbeResult {
    let ssh_tail = match server.kind {
        ServerKind::Ssh => server.ssh.as_ref().map(|s| s.argv_tail()),
        ServerKind::Local => None,
    };
    let ssh_stage_label = match server.kind {
        ServerKind::Ssh => format!("ssh {}", server.label),
        ServerKind::Local => LOCALHOST_ID.to_string(),
    };

    let mut stages = vec![
        ProbeStage {
            id: "ssh".to_string(),
            label: ssh_stage_label.clone(),
            status: ProbeStageStatus::Pending,
            elapsed_ms: None,
            error: None,
        },
        ProbeStage {
            id: "tmux".to_string(),
            label: format!("tmux on the socket {}", server.socket),
            status: ProbeStageStatus::Pending,
            elapsed_ms: None,
            error: None,
        },
        ProbeStage {
            id: "sessions".to_string(),
            label: "listing sessions".to_string(),
            status: ProbeStageStatus::Pending,
            elapsed_ms: None,
            error: None,
        },
        ProbeStage {
            id: "attach".to_string(),
            label: "attach".to_string(),
            status: ProbeStageStatus::Pending,
            elapsed_ms: None,
            error: None,
        },
    ];

    // Stage 1: SSH reachability (or immediate local check).
    let t0 = Instant::now();
    if let Some(ref tail) = ssh_tail {
        let mut cmd = Command::new("ssh");
        cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
        cmd.args(tail);
        cmd.arg("true");
        match cmd.output() {
            Ok(out) if out.status.success() => {
                stages[0].status = ProbeStageStatus::Done;
                stages[0].elapsed_ms = Some(t0.elapsed().as_millis() as u64);
            }
            Ok(out) => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                stages[0].status = ProbeStageStatus::Failed;
                stages[0].elapsed_ms = Some(t0.elapsed().as_millis() as u64);
                stages[0].error = Some(if err.is_empty() {
                    format!("ssh exited with {}", out.status)
                } else {
                    err
                });
                return ServerProbeResult {
                    server_id: server.id.clone(),
                    ok: false,
                    stages,
                    sessions: Vec::new(),
                    tmux_version: None,
                };
            }
            Err(e) => {
                stages[0].status = ProbeStageStatus::Failed;
                stages[0].elapsed_ms = Some(t0.elapsed().as_millis() as u64);
                stages[0].error = Some(e.to_string());
                return ServerProbeResult {
                    server_id: server.id.clone(),
                    ok: false,
                    stages,
                    sessions: Vec::new(),
                    tmux_version: None,
                };
            }
        }
    } else {
        stages[0].status = ProbeStageStatus::Done;
        stages[0].elapsed_ms = Some(0);
    }

    // Stage 2: tmux version on target machine.
    let t1 = Instant::now();
    let version_out = if let Some(ref tail) = ssh_tail {
        let mut cmd = Command::new("ssh");
        cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
        cmd.args(tail);
        cmd.args(["tmux", "-V"]);
        cmd.output()
    } else {
        Command::new("tmux").arg("-V").output()
    };

    let tmux_version = match version_out {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let ver = raw
                .strip_prefix("tmux ")
                .unwrap_or(raw.as_str())
                .trim()
                .to_string();
            stages[1].label = format!("tmux {ver} on the socket {}", server.socket);
            stages[1].status = ProbeStageStatus::Done;
            stages[1].elapsed_ms = Some(t1.elapsed().as_millis() as u64);
            Some(ver)
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            stages[1].status = ProbeStageStatus::Failed;
            stages[1].elapsed_ms = Some(t1.elapsed().as_millis() as u64);
            stages[1].error = Some(if err.is_empty() {
                format!("tmux -V exited with {}", out.status)
            } else {
                err
            });
            return ServerProbeResult {
                server_id: server.id.clone(),
                ok: false,
                stages,
                sessions: Vec::new(),
                tmux_version: None,
            };
        }
        Err(e) => {
            stages[1].status = ProbeStageStatus::Failed;
            stages[1].elapsed_ms = Some(t1.elapsed().as_millis() as u64);
            stages[1].error = Some(e.to_string());
            return ServerProbeResult {
                server_id: server.id.clone(),
                ok: false,
                stages,
                sessions: Vec::new(),
                tmux_version: None,
            };
        }
    };

    // Stage 3: listing sessions on the target socket.
    let t2 = Instant::now();
    let sessions = if let Some(live) = live_sessions {
        stages[2].status = ProbeStageStatus::Done;
        stages[2].elapsed_ms = Some(0);
        live
    } else {
        let tmux_args = build_tmux_args(
            &server.socket,
            &[
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_windows}\t#{session_attached}",
            ],
        );
        let sess_out = if let Some(ref tail) = ssh_tail {
            let mut cmd = Command::new("ssh");
            cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
            cmd.args(tail);
            cmd.arg("tmux");
            cmd.args(&tmux_args);
            cmd.output()
        } else {
            Command::new("tmux").args(&tmux_args).output()
        };

        match sess_out {
            Ok(out) if out.status.success() => {
                stages[2].status = ProbeStageStatus::Done;
                stages[2].elapsed_ms = Some(t2.elapsed().as_millis() as u64);
                parse_session_list(&String::from_utf8_lossy(&out.stdout))
            }
            Ok(out) => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if is_no_server_stderr(&err) {
                    stages[2].status = ProbeStageStatus::Done;
                    stages[2].elapsed_ms = Some(t2.elapsed().as_millis() as u64);
                    Vec::new()
                } else {
                    stages[2].status = ProbeStageStatus::Failed;
                    stages[2].elapsed_ms = Some(t2.elapsed().as_millis() as u64);
                    stages[2].error = Some(if err.is_empty() {
                        format!("tmux list-sessions exited with {}", out.status)
                    } else {
                        err
                    });
                    return ServerProbeResult {
                        server_id: server.id.clone(),
                        ok: false,
                        stages,
                        sessions: Vec::new(),
                        tmux_version,
                    };
                }
            }
            Err(e) => {
                stages[2].status = ProbeStageStatus::Failed;
                stages[2].elapsed_ms = Some(t2.elapsed().as_millis() as u64);
                stages[2].error = Some(e.to_string());
                return ServerProbeResult {
                    server_id: server.id.clone(),
                    ok: false,
                    stages,
                    sessions: Vec::new(),
                    tmux_version,
                };
            }
        }
    };

    stages[3].status = ProbeStageStatus::Done;
    stages[3].elapsed_ms = Some(0);

    ServerProbeResult {
        server_id: server.id.clone(),
        ok: true,
        stages,
        sessions,
        tmux_version,
    }
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
