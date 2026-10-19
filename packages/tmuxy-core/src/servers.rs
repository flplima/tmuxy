//! Saved tmux *servers* the desktop app can attach to.
//!
//! A "server" is a tmux server tmuxy drives in control mode: the local machine
//! (the default) or a remote host reached over SSH. Entries are persisted to
//! `~/.config/tmuxy/servers.json` by the `tmuxy connect` TUI and read by the
//! desktop app's sidebar server picker. This is a desktop-only concept — the
//! web server always uses whatever socket/host it was launched against.
//!
//! Attaching to a server means pointing the monitor at its socket and, for a
//! remote, its SSH tunnel. Both are surfaced as the `TMUX_SOCKET` / `TMUXY_SSH`
//! env vars that [`crate::session::tmux_argv`] already resolves — so a saved
//! server maps cleanly onto the existing invocation path with no special-casing
//! downstream. See [`Server::connect_env`].

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::session::{config_dir, DEFAULT_TMUX_SOCKET, USERS_OWN_SOCKET};

pub mod discovery;
pub use discovery::{
    enrich_and_scan_sockets, is_ephemeral_test_socket, now_unix_secs, parse_session_list,
    probe_server, query_local_socket_sessions, remove_server, tmux_socket_dirs, touch_server,
    ProbeStage, ProbeStageStatus, RemoteSessionInfo, ServerProbeResult, ServerReachability,
};

/// Where the local machine's server sits in the picker.
pub const LOCALHOST_ID: &str = "localhost";

/// The picker's entry for the user's OWN tmux server — the one their bare
/// `tmux` command talks to.
///
/// tmuxy runs on a socket of its own, which is what keeps a test run or a dev
/// server from disturbing real work. The cost is that a tmux user's first
/// question — "where are my sessions?" — has no answer anywhere in the UI. This
/// entry is that answer: it appears in the picker only when that server really
/// does have sessions, so it is never an invitation to an empty room.
pub const MY_TMUX_ID: &str = "my-tmux";

fn default_socket() -> String {
    DEFAULT_TMUX_SOCKET.to_string()
}

/// Whether a saved server is the local machine or a remote SSH host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    #[default]
    Local,
    Ssh,
}

/// SSH connection details for a remote server. Assembled into the `ssh` argv
/// tail (`[options…, -p port, user@host]`) that fronts every tmux invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    /// Hostname or IP of the remote box.
    pub host: String,
    /// Login user; omitted uses ssh's own default (current user / ssh_config).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// TCP port; omitted uses ssh's default (22 / ssh_config).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Extra raw ssh options, e.g. `-i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<String>,
}

impl SshConfig {
    /// The `ssh` argv tail: options, then `-p <port>`, then `[user@]host`.
    /// Joined with spaces this is exactly the `TMUXY_SSH` env value that
    /// [`crate::session::ssh_target`] parses back.
    pub fn argv_tail(&self) -> Vec<String> {
        let mut tail: Vec<String> = Vec::new();
        if let Some(opts) = &self.options {
            tail.extend(opts.split_whitespace().map(String::from));
        }
        if let Some(port) = self.port {
            tail.push("-p".to_string());
            tail.push(port.to_string());
        }
        tail.push(match &self.user {
            Some(user) if !user.is_empty() => format!("{user}@{}", self.host),
            _ => self.host.clone(),
        });
        tail
    }
}

/// A saved tmux server: an entry in the sidebar server picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    /// Stable identifier used as the picker key and reconnect target.
    pub id: String,
    /// Human-readable label shown in the picker (e.g. `localhost`, `user@host`).
    pub label: String,
    #[serde(default)]
    pub kind: ServerKind,
    /// Present when `kind == Ssh`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
    /// tmux socket name (tmux `-L`) or path (`-S`, if it contains a `/`).
    /// Defaults to the dedicated `tmuxy` socket; the user's vanilla tmux is
    /// `default`.
    #[serde(default = "default_socket")]
    pub socket: String,
    /// Optional preferred session to attach to on this server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Unix timestamp (seconds) when this server was last added or connected to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<u64>,
    /// Reachability state computed when listing or probing servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable: Option<ServerReachability>,
    /// Number of non-stash sessions on this server when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_count: Option<usize>,
    /// Preserve unknown keys across roundtrips so a newer build's file isn't
    /// truncated when read+written by an older one (mirrors `ManagedState`).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Server {
    /// The always-present local-machine entry, on the socket this process is
    /// actually attached to.
    pub fn localhost() -> Self {
        Self::localhost_on(&crate::session::tmux_socket())
    }

    /// `localhost` pinned to an explicit socket.
    ///
    /// The socket has to follow the live `TMUX_SOCKET` rather than the default
    /// name: `localhost` is the picker's word for "the server this app is
    /// attached to", and hardcoding the default made it mean "the server named
    /// `tmuxy`". An app launched against any other socket then listed a row
    /// that retargeted the monitor onto a *different* tmux server — including,
    /// from a sandboxed debug build, the user's real one.
    ///
    /// Split from the env-reading wrapper so that resolution can be tested
    /// without mutating process-wide env vars from a parallel test.
    pub fn localhost_on(socket: &str) -> Self {
        Server {
            id: LOCALHOST_ID.to_string(),
            label: "localhost".to_string(),
            kind: ServerKind::Local,
            ssh: None,
            socket: socket.to_string(),
            session: None,
            last_used: None,
            reachable: Some(ServerReachability::Online),
            session_count: None,
            extra: serde_json::Map::new(),
        }
    }

    /// Build a server from a single typed destination.
    ///
    /// `dest` is what the user types: `[user@]host[:port]`, where `host` may be
    /// any name their `~/.ssh/config` defines. That is deliberately the whole
    /// form. tmuxy runs the system `ssh` binary rather than speaking the
    /// protocol, so User, Port, IdentityFile, ProxyJump, agent forwarding and
    /// 2FA all come from that file for free — re-asking for them here is how
    /// other clients ended up with their own half-implementations of it.
    ///
    /// An empty `dest` means this machine. `socket` defaults to the dedicated
    /// `tmuxy` socket.
    pub fn from_destination(dest: &str, socket: Option<&str>) -> Result<Self, String> {
        let dest = dest.trim();
        // An unspecified socket means "the default" for a remote host, but
        // "wherever this app is attached" for this machine — otherwise a blank
        // form filled in on a non-default socket saves a server pointing
        // somewhere the user never named.
        let live_socket = crate::session::tmux_socket();
        let socket = match socket.map(str::trim) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ if dest.is_empty() => live_socket.clone(),
            _ => default_socket(),
        };

        if dest.is_empty() {
            let mut server = Server::localhost();
            // Compared against the LIVE socket, not the default name: typing
            // the default socket explicitly while attached elsewhere names a
            // different server, so it must get its own id.
            if socket != live_socket {
                server.id = format!("local-{}", slug(&socket));
                server.label = socket.clone();
                server.socket = socket;
            }
            return Ok(server);
        }

        let (user, host, port) = parse_destination(dest)?;
        let label = dest.to_string();
        Ok(Server {
            id: format!("ssh-{}-{}", slug(dest), slug(&socket)),
            label,
            kind: ServerKind::Ssh,
            ssh: Some(SshConfig {
                host,
                user,
                port,
                options: None,
            }),
            socket,
            session: None,
            last_used: now_unix_secs(),
            reachable: Some(ServerReachability::Known),
            session_count: None,
            extra: serde_json::Map::new(),
        })
    }

    /// The `(TMUX_SOCKET, TMUXY_SSH)` env pair for attaching to this server.
    /// `TMUXY_SSH` is `None` for a local server (and for an SSH server missing
    /// its `ssh` block, which we then treat as local rather than crash).
    pub fn connect_env(&self) -> (String, Option<String>) {
        let ssh = match self.kind {
            ServerKind::Ssh => self.ssh.as_ref().map(|s| s.argv_tail().join(" ")),
            ServerKind::Local => None,
        };
        (self.socket.clone(), ssh)
    }
}

/// Path to the servers file inside the user's config dir.
/// Split `[user@]host[:port]` into its parts.
///
/// A bracketed IPv6 literal (`[::1]:22`) is handled explicitly; an unbracketed
/// one is taken whole as the host, because `::1:22` cannot be split without
/// guessing which colon is the port.
fn parse_destination(dest: &str) -> Result<(Option<String>, String, Option<u16>), String> {
    let (user, rest) = match dest.split_once('@') {
        Some((u, r)) if !u.is_empty() => (Some(u.to_string()), r),
        Some(_) => return Err("missing user before '@'".to_string()),
        None => (None, dest),
    };
    if rest.is_empty() {
        return Err("missing host".to_string());
    }

    let (host, port) = if let Some(rest) = rest.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| "unclosed '[' in address".to_string())?;
        (host.to_string(), tail.strip_prefix(':').map(str::to_string))
    } else {
        match rest.split_once(':') {
            // Only the LAST colon can be a port, and only when the rest parses
            // as one; anything else is an unbracketed IPv6 address.
            Some((h, p)) if !p.contains(':') => (h.to_string(), Some(p.to_string())),
            _ => (rest.to_string(), None),
        }
    };

    if host.is_empty() {
        return Err("missing host".to_string());
    }
    let port = match port {
        Some(p) => Some(
            p.parse::<u16>()
                .map_err(|_| format!("'{p}' is not a port number"))?,
        ),
        None => None,
    };
    Ok((user, host, port))
}

/// Filesystem-safe fragment of an id, mirroring `tmuxy connect`'s own ids so a
/// server added from either surface lands on the same key.
fn slug(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

pub fn servers_path() -> PathBuf {
    config_dir().join("servers.json")
}

/// Read and parse the servers file, distinguishing an absent file (`Ok(None)`)
/// from one that exists but can't be read or parsed (`Err`). Mutating operations
/// use this so they never overwrite an unparseable file — a transient corruption
/// must not be silently turned into data loss.
fn read_servers_strict() -> std::io::Result<Option<Vec<Server>>> {
    let path = servers_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let servers = serde_json::from_str(&text).map_err(std::io::Error::other)?;
            Ok(Some(servers))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Guarantee a `localhost` entry at the front of the list.
fn with_localhost(mut servers: Vec<Server>) -> Vec<Server> {
    // Localhost is implicit and always available; surface it first if the file
    // didn't include it (e.g. brand-new install or a hand-edited list).
    if !servers.iter().any(|s| s.id == LOCALHOST_ID) {
        servers.insert(0, Server::localhost());
    }
    servers
}

/// Add the user's own tmux server to the list, when there is one to add.
///
/// Three conditions, all of them about not lying to the user:
///   - tmuxy is not already attached to it (then `localhost` IS that server);
///   - the list does not already name it;
///   - it actually has sessions, which is the only thing that makes the entry
///     worth offering.
fn with_users_own_tmux(mut servers: Vec<Server>) -> Vec<Server> {
    if crate::session::on_users_own_server() {
        return servers;
    }
    if servers.iter().any(|s| {
        s.id == MY_TMUX_ID || (s.kind == ServerKind::Local && s.socket == USERS_OWN_SOCKET)
    }) {
        return servers;
    }
    let Some(count) = query_local_socket_sessions(USERS_OWN_SOCKET) else {
        return servers;
    };
    servers.push(Server {
        id: MY_TMUX_ID.to_string(),
        label: "my tmux".to_string(),
        kind: ServerKind::Local,
        ssh: None,
        socket: USERS_OWN_SOCKET.to_string(),
        session: None,
        last_used: None,
        reachable: Some(ServerReachability::Online),
        session_count: Some(count),
        extra: serde_json::Map::new(),
    });
    servers
}

/// Read saved servers, always guaranteeing a `localhost` entry at the front,
/// plus any live local sockets in tmux's socket directory.
/// A missing, empty, or unparseable file yields just `[localhost]` rather than
/// erroring — a broken server list should never brick the picker. Callers that
/// then *write* the list back must instead use [`read_servers_strict`] so a
/// parse failure aborts the write rather than persisting the empty fallback.
pub fn read_servers() -> Vec<Server> {
    let base = with_users_own_tmux(with_localhost(
        read_servers_strict().ok().flatten().unwrap_or_default(),
    ));
    let live_socket = crate::session::tmux_socket();
    let live_ssh = crate::session::ssh_target().map(|v| v.join(" "));
    enrich_and_scan_sockets(
        base,
        &tmux_socket_dirs(),
        &live_socket,
        live_ssh.as_deref(),
        query_local_socket_sessions,
    )
}

/// Overwrite the servers file with the given list (excluding transient runtime
/// fields `reachable` and `session_count`).
pub fn write_servers(servers: &[Server]) -> std::io::Result<PathBuf> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let path = servers_path();
    let persisted: Vec<Server> = servers
        .iter()
        .cloned()
        .map(|mut s| {
            s.reachable = None;
            s.session_count = None;
            s
        })
        .collect();
    let body = serde_json::to_string_pretty(&persisted).map_err(std::io::Error::other)?;
    std::fs::write(&path, format!("{body}\n"))?;
    Ok(path)
}

/// Add (or replace, by `id`) a server and persist. Returns the updated list.
///
/// The synthetic `localhost` entry is deliberately NOT injected here: its
/// socket follows the live `TMUX_SOCKET`, so writing it would freeze whichever
/// socket this app happened to be on into the file and hand that stale value
/// to every later read. It is re-guaranteed on read instead.
pub fn add_server(mut server: Server) -> std::io::Result<Vec<Server>> {
    // Refuse to overwrite a file that exists but can't be parsed — reading it
    // leniently (empty fallback) and writing that back would wipe every saved
    // server on one transient corruption.
    if server.last_used.is_none() {
        server.last_used = now_unix_secs();
    }
    let mut servers = read_servers_strict()?.unwrap_or_default();
    match servers.iter_mut().find(|s| s.id == server.id) {
        Some(existing) => *existing = server,
        None => servers.push(server),
    }
    write_servers(&servers)?;
    Ok(servers)
}

/// Look up a saved server by id.
pub fn find_server(id: &str) -> Option<Server> {
    read_servers().into_iter().find(|s| s.id == id)
}

/// The id of the saved server matching the live `TMUX_SOCKET`/`TMUXY_SSH` env,
/// or [`LOCALHOST_ID`] when none matches. Lets the sidebar picker mark which
/// server the app is currently attached to.
pub fn current_server_id() -> String {
    let socket = crate::session::tmux_socket();
    let ssh = crate::session::ssh_target().map(|v| v.join(" "));
    let candidates = with_users_own_tmux(with_localhost(
        read_servers_strict().ok().flatten().unwrap_or_default(),
    ));
    candidates
        .into_iter()
        .find(|s| {
            let (s_socket, s_ssh) = s.connect_env();
            s_socket == socket && s_ssh == ssh
        })
        .map(|s| s.id)
        .unwrap_or_else(|| LOCALHOST_ID.to_string())
}

#[cfg(test)]
mod tests;
