//! Saved tmux *servers* the app can attach to.
//!
//! A "server" is a tmux server tmuxy drives in control mode: the local machine
//! (the default) or a remote host reached over SSH. Entries are persisted to
//! `servers.json` in the state dir (this machine's list, not portable config)
//! by `tmuxy session connect` and read by the sidebar's server picker, in
//! the desktop app and the web app alike.
//!
//! Attaching to a server means pointing the monitor at its socket and, for a
//! remote, its SSH tunnel: the values `TMUX_SOCKET` / `TMUXY_SSH` hold at
//! launch ([`Server::connect_env`]).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::session::{DEFAULT_TMUX_SOCKET, USERS_OWN_SOCKET};

pub mod connect;
pub mod discovery;
pub use discovery::{
    enrich_and_scan_sockets, is_ephemeral_test_socket, local_socket_session_names, now_unix_secs,
    parse_session_list, query_local_socket_sessions, tmux_socket_dirs, touch_server,
    RemoteSessionInfo, ServerReachability, LIST_SESSIONS, LIST_SESSIONS_FORMAT,
};

pub const LOCALHOST_ID: &str = "localhost";

/// The picker's entry for the user's OWN tmux server, the one a bare `tmux`
/// talks to. tmuxy runs on a socket of its own, so a tmux user's first
/// question ("where are my sessions?") would have no answer in the UI. The
/// entry appears only when that server has sessions.
pub const MY_TMUX_ID: &str = "my-tmux";

fn default_socket() -> String {
    DEFAULT_TMUX_SOCKET.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    #[default]
    Local,
    Ssh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    /// Stable: the picker key and reconnect target.
    pub id: String,
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
    /// The session to attach to on this server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Unix seconds when this server was last added or connected to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<u64>,
    /// Computed when listing or probing; never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable: Option<ServerReachability>,
    /// Non-stash sessions on this server, when known; never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_count: Option<usize>,
    /// Unknown keys, kept so a newer build's file isn't truncated when an
    /// older one reads and writes it.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Server {
    /// The always-present local-machine entry, on the socket this process is
    /// actually attached to.
    pub fn localhost() -> Self {
        Self::localhost_on(&crate::session::tmux_socket())
    }

    /// The socket follows the live `TMUX_SOCKET`, not the default name:
    /// `localhost` is the picker's word for "the server this app is attached
    /// to". With the default hardcoded, an app launched against another socket
    /// listed a row that retargeted the monitor onto a *different* tmux server
    /// (from a sandboxed debug build, the user's real one).
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

    /// The `(socket, ssh)` pair, as `TMUX_SOCKET` / `TMUXY_SSH` hold them at
    /// launch. `ssh` is `None` for a local server, and for an SSH server
    /// missing its `ssh` block (treated as local).
    pub fn connect_env(&self) -> (String, Option<String>) {
        let ssh = match self.kind {
            ServerKind::Ssh => self.ssh.as_ref().map(|s| s.argv_tail().join(" ")),
            ServerKind::Local => None,
        };
        (self.socket.clone(), ssh)
    }
}

/// Filesystem-safe fragment of an id: a server `tmuxy session connect` saved
/// (`connect::ConnectRequest::server`) and one listed here share a key.
fn slug(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

/// In the state dir, not the config: saved servers are machine state (an
/// ssh host reachable from here, a socket on this machine).
pub fn servers_path() -> PathBuf {
    crate::paths::state_dir().join(crate::paths::SERVERS.name)
}

/// An absent file is `Ok(None)`, one that can't be read or parsed `Err`.
/// Mutating operations use this so they never overwrite an unparseable file:
/// a transient corruption must not become data loss.
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

fn with_localhost(mut servers: Vec<Server>) -> Vec<Server> {
    if !servers.iter().any(|s| s.id == LOCALHOST_ID) {
        servers.insert(0, Server::localhost());
    }
    servers
}

/// Add the user's own tmux server, unless tmuxy is attached to it (then
/// `localhost` IS that server), the list already names it, or it has no
/// sessions.
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

/// What a launch tells a tmux user who finds none of their sessions here:
/// their own server has `sessions` of them, and `session` is the one a switch
/// would open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnTmuxOffer {
    /// The picker's id for that server ([`MY_TMUX_ID`]): what a switch connects to.
    pub server_id: &'static str,
    pub sessions: usize,
    /// The first session whose name tmuxy can attach to
    /// ([`crate::session::SessionName`]); without one a switch opens tmuxy's
    /// own session on that server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Whether this host can switch to that server itself
    /// (`HostCtx::switches_servers`); one that cannot says how to start there.
    pub can_switch: bool,
}

/// Where tmuxy stands when it wonders whether to make the [`OwnTmuxOffer`].
pub struct OwnTmuxAsk<'a> {
    /// The user has answered the offer to switch before (`own_tmux_asked`).
    pub asked: bool,
    /// A host that cannot switch has shown the notice before (`own_tmux_told`).
    pub told: bool,
    pub socket: &'a str,
    pub over_ssh: bool,
    pub can_switch: bool,
}

/// The offer, for a tmuxy that is on its own socket on this machine and has
/// not asked before. A socket somebody chose (`TMUX_SOCKET`, a server from the
/// picker, a remote host) is an answer already. A host that cannot switch
/// only tells, and having told does not stand for the answer to an offer the
/// desktop app has yet to make: the two share one state file on a machine
/// that runs both. `sessions` is only looked at when everything else says
/// ask.
pub fn own_tmux_offer_for(
    ask: &OwnTmuxAsk<'_>,
    sessions: impl FnOnce() -> Option<Vec<String>>,
) -> Option<OwnTmuxOffer> {
    let answered = ask.asked || (ask.told && !ask.can_switch);
    if answered || ask.over_ssh || ask.socket != DEFAULT_TMUX_SOCKET {
        return None;
    }
    // A session with tmuxy's own name is one an earlier tmuxy made there
    // (it was once pointed at that socket): not work the user would miss.
    let names: Vec<String> = sessions()?
        .into_iter()
        .filter(|name| name != crate::DEFAULT_SESSION_NAME)
        .collect();
    if names.is_empty() {
        return None;
    }
    Some(OwnTmuxOffer {
        server_id: MY_TMUX_ID,
        sessions: names.len(),
        session: names
            .iter()
            .find(|name| crate::session::is_safe_session_name(name))
            .cloned(),
        can_switch: ask.can_switch,
    })
}

/// [`own_tmux_offer_for`] this process, with the detection the picker's
/// "my tmux" entry uses.
pub fn own_tmux_offer(can_switch: bool) -> Option<OwnTmuxOffer> {
    let state = crate::session::read_managed_state();
    own_tmux_offer_for(
        &OwnTmuxAsk {
            asked: state.own_tmux_asked == Some(true),
            told: state.own_tmux_told == Some(true),
            socket: &crate::session::tmux_socket(),
            over_ssh: crate::session::ssh_target().is_some(),
            can_switch,
        },
        || local_socket_session_names(USERS_OWN_SOCKET),
    )
}

/// What closing the launch notice remembers: the answer to the offer on a
/// host that made one (`can_switch`), else only that the user was told.
pub fn own_tmux_answer(can_switch: bool) -> crate::session::ManagedState {
    let mut state = crate::session::ManagedState::default();
    if can_switch {
        state.own_tmux_asked = Some(true);
    } else {
        state.own_tmux_told = Some(true);
    }
    state
}

/// Remember that the launch notice was closed on this host, so it is not
/// shown there again.
pub fn close_own_tmux_offer(can_switch: bool) -> std::io::Result<PathBuf> {
    crate::session::write_managed_state(own_tmux_answer(can_switch))
}

/// Saved servers with `localhost` at the front, plus any live local sockets
/// in tmux's socket directory. A missing or unparseable file yields just
/// `[localhost]`, so a broken list never bricks the picker; a caller that
/// writes the list back must use [`read_servers_strict`] instead.
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

/// The transient `reachable` and `session_count` are not written.
pub fn write_servers(servers: &[Server]) -> std::io::Result<PathBuf> {
    let dir = crate::paths::state_dir();
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
    crate::private_files::replace(&path, format!("{body}\n"))?;
    Ok(path)
}

pub fn find_server(id: &str) -> Option<Server> {
    read_servers().into_iter().find(|s| s.id == id)
}

/// The id of the saved server matching the live socket and ssh host, or
/// [`LOCALHOST_ID`] when none matches.
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    pub servers: Vec<Server>,
    pub current_id: String,
}

/// `live_sessions`, the sessions the attached server holds now when they
/// could be read, becomes the current server's count.
pub fn list(live_sessions: Option<usize>) -> ServerList {
    let mut servers = read_servers();
    let current_id = current_server_id();
    if let Some(cur) = servers.iter_mut().find(|s| s.id == current_id) {
        cur.session_count = live_sessions.or(cur.session_count);
    }
    ServerList {
        servers,
        current_id,
    }
}

/// The session is `session`, else the one the server was last used with,
/// else this process's own, and must be a valid session name. The server's
/// `last_used` is stamped; failing to write that is logged, not fatal.
pub fn connect_target(
    id: &str,
    session: Option<String>,
) -> Result<crate::session::ConnectTarget, crate::CommandError> {
    let server = find_server(id)
        .ok_or_else(|| crate::CommandError::invalid(format!("unknown server '{id}'")))?;
    let (socket, ssh) = server.connect_env();
    let session = session
        .or_else(|| server.session.clone())
        .unwrap_or_else(crate::session::session_name);
    if crate::session::SessionName::parse(&session).is_none() {
        return Err(crate::CommandError::invalid(format!(
            "'{session}' is not a session name"
        )));
    }
    if let Err(e) = touch_server(id, Some(&session)) {
        tracing::warn!(server = id, error = %e, "could not record the server as used");
    }
    Ok(crate::session::ConnectTarget {
        socket,
        session,
        ssh,
    })
}

#[cfg(test)]
mod tests;
