//! Moving the desktop app onto another tmux server from a shell:
//! `tmuxy connect` and `tmuxy session connect` write one [`ConnectRequest`]
//! into the current server's global environment, and the desktop app reads it,
//! clears it and reconnects. One variable holding the whole request, so no
//! reader can see half of one; the request is checked where it is read,
//! since anything that reaches the server can write it.
//!
//! A server reached this way is saved to `servers.json` ([`remember`]), so the
//! picker lists it next time.

use serde::{Deserialize, Serialize};

use super::{read_servers_strict, slug, write_servers, Server, ServerKind, SshConfig};
use crate::session::{is_safe_session_name, is_safe_socket, is_ssh_destination};

/// The tmux global environment variable a request is written to.
pub const CONNECT_REQUEST: &str = "TMUXY_CONNECT";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub socket: String,
    /// The session to attach to; the app's own when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// `[user@]host` for a remote server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<String>,
}

impl ConnectRequest {
    /// A request whose every part is a plain name, so none of it can turn
    /// into an ssh option or a command; else why not.
    pub fn new(socket: &str, session: Option<&str>, ssh: Option<&str>) -> Result<Self, String> {
        let request = Self {
            socket: socket.to_string(),
            session: session.filter(|s| !s.is_empty()).map(String::from),
            ssh: ssh.filter(|s| !s.is_empty()).map(String::from),
        };
        request.check()?;
        Ok(request)
    }

    fn check(&self) -> Result<(), String> {
        if !is_safe_socket(&self.socket) {
            return Err(format!(
                "'{}' is not a valid tmux socket name or absolute path",
                self.socket
            ));
        }
        if let Some(session) = self.session.as_deref().filter(|s| !is_safe_session_name(s)) {
            return Err(format!("'{session}' is not a valid tmux session name"));
        }
        if let Some(ssh) = self.ssh.as_deref().filter(|d| !is_ssh_destination(d)) {
            return Err(format!("'{ssh}' is not a [user@]host destination"));
        }
        Ok(())
    }

    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// A request read back from the variable, or `None` for a value that is
    /// not one, or names anything but plain names.
    pub fn decode(value: &str) -> Option<Self> {
        let request: Self = serde_json::from_str(value.trim()).ok()?;
        request.check().ok()?;
        Some(request)
    }

    /// The `servers.json` entry for the server this request reaches: `None`
    /// for `live_socket` on this machine, which is the `localhost` entry.
    pub fn server(&self, live_socket: &str) -> Option<Server> {
        let (id, label, kind, ssh) = match &self.ssh {
            Some(dest) => {
                let (host, port) = crate::session::split_ssh_port(dest);
                let (user, host) = match host.split_once('@') {
                    Some((user, host)) => (Some(user.to_string()), host.to_string()),
                    None => (None, host.to_string()),
                };
                (
                    format!("ssh-{}-{}", slug(dest), slug(&self.socket)),
                    dest.clone(),
                    ServerKind::Ssh,
                    Some(SshConfig {
                        host,
                        user,
                        port,
                        options: None,
                    }),
                )
            }
            None if self.socket == live_socket => return None,
            None => (
                format!("local-{}", slug(&self.socket)),
                self.socket.clone(),
                ServerKind::Local,
                None,
            ),
        };
        Some(Server {
            id,
            label,
            kind,
            ssh,
            socket: self.socket.clone(),
            session: None,
            last_used: super::now_unix_secs(),
            reachable: None,
            session_count: None,
            extra: serde_json::Map::new(),
        })
    }
}

/// Save `server` to `servers.json`, replacing an entry with its id. An
/// unparseable file is left as it is rather than overwritten.
pub fn remember(server: Server) -> std::io::Result<()> {
    let mut servers = read_servers_strict()?.unwrap_or_default();
    servers.retain(|s| s.id != server.id);
    servers.push(server);
    write_servers(&servers).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_round_trips_and_one_naming_anything_but_plain_names_is_refused() {
        let request = ConnectRequest::new("work", Some("dev"), Some("felipe@prod")).unwrap();
        assert_eq!(ConnectRequest::decode(&request.encode()), Some(request));
        let local = ConnectRequest::new("default", None, Some("")).unwrap();
        assert_eq!(local.encode(), r#"{"socket":"default"}"#);

        assert!(ConnectRequest::new("a b", None, None).is_err());
        assert!(ConnectRequest::new("work", Some("x;y"), None).is_err());
        assert!(ConnectRequest::new("work", None, Some("-oProxyCommand=id")).is_err());
        assert_eq!(
            ConnectRequest::decode(r#"{"socket":"work","ssh":"-oProxyCommand=id"}"#),
            None
        );
        assert_eq!(ConnectRequest::decode("work"), None);
    }

    #[test]
    fn the_saved_entry_is_keyed_by_host_and_socket_and_the_live_socket_is_not_saved() {
        let remote = ConnectRequest::new("work", None, Some("felipe@Prod.Example:2222"))
            .unwrap()
            .server("tmuxy")
            .unwrap();
        assert_eq!(remote.id, "ssh-felipe-prod-example-2222-work");
        assert_eq!(remote.label, "felipe@Prod.Example:2222");
        assert_eq!(remote.kind, ServerKind::Ssh);
        let ssh = remote.ssh.unwrap();
        assert_eq!(
            (ssh.host.as_str(), ssh.user.as_deref(), ssh.port),
            ("Prod.Example", Some("felipe"), Some(2222))
        );
        assert_eq!(ssh.argv_tail(), ["-p", "2222", "felipe@Prod.Example"]);
        assert!(remote.last_used.is_some());

        let other = ConnectRequest::new("default", None, None).unwrap();
        assert_eq!(other.server("tmuxy").unwrap().id, "local-default");
        assert!(other.server("default").is_none());
    }
}
