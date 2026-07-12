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

use crate::session::{config_dir, DEFAULT_TMUX_SOCKET};

/// Where the local machine's server sits in the picker.
pub const LOCALHOST_ID: &str = "localhost";

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
    /// Preserve unknown keys across roundtrips so a newer build's file isn't
    /// truncated when read+written by an older one (mirrors `ManagedState`).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Server {
    /// The always-present local-machine entry.
    pub fn localhost() -> Self {
        Server {
            id: LOCALHOST_ID.to_string(),
            label: "localhost".to_string(),
            kind: ServerKind::Local,
            ssh: None,
            socket: default_socket(),
            session: None,
            extra: serde_json::Map::new(),
        }
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
pub fn servers_path() -> PathBuf {
    config_dir().join("servers.json")
}

/// Read saved servers, always guaranteeing a `localhost` entry at the front.
/// A missing, empty, or unparseable file yields just `[localhost]` rather than
/// erroring — a broken server list should never brick the picker.
pub fn read_servers() -> Vec<Server> {
    let path = servers_path();
    let mut servers: Vec<Server> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    // Localhost is implicit and always available; surface it first if the file
    // didn't include it (e.g. brand-new install or a hand-edited list).
    if !servers.iter().any(|s| s.id == LOCALHOST_ID) {
        servers.insert(0, Server::localhost());
    }
    servers
}

/// Overwrite the servers file with the given list.
pub fn write_servers(servers: &[Server]) -> std::io::Result<PathBuf> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let path = servers_path();
    let body = serde_json::to_string_pretty(servers).map_err(std::io::Error::other)?;
    std::fs::write(&path, format!("{body}\n"))?;
    Ok(path)
}

/// Add (or replace, by `id`) a server and persist. Returns the updated list.
/// The `localhost` entry can't be replaced away — it's re-guaranteed on read.
pub fn add_server(server: Server) -> std::io::Result<Vec<Server>> {
    let mut servers = read_servers();
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
    read_servers()
        .into_iter()
        .find(|s| {
            let (s_socket, s_ssh) = s.connect_env();
            s_socket == socket && s_ssh == ssh
        })
        .map(|s| s.id)
        .unwrap_or_else(|| LOCALHOST_ID.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localhost_is_local_with_no_ssh() {
        let (socket, ssh) = Server::localhost().connect_env();
        assert_eq!(socket, DEFAULT_TMUX_SOCKET);
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
            extra: serde_json::Map::new(),
        };
        assert_eq!(server.connect_env().1, None);
    }
}
