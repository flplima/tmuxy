//! A later window's splash page and what it chooses: a session on this
//! machine, whose group the window joins, a new session on this machine, or
//! an ssh host, whose tmuxy server the window attaches to (docs/DESKTOP.md;
//! the ssh connection itself is `ssh_link.rs`).
//!
//! The choice becomes the window's own target before its monitor starts, and
//! the monitor runs inside it, so every tmux call made for the window — the
//! control-mode connection and the reads beside it — reaches that server while
//! the other windows stay where they are.

use std::process::Command;

use tauri::{AppHandle, Manager};
use tmuxy_core::servers::{parse_session_list, RemoteSessionInfo, LIST_SESSIONS_FORMAT};
use tmuxy_core::session::{scoped, ConnectTarget, DEFAULT_TMUX_SOCKET};

use super::ssh_link::{self, Opened, SshForm, SshLink};
use super::{new_monitor, GuiWindow, GuiWindows};

/// What a splash page chose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attach {
    /// A session on this machine: the window joins its group, keeping a
    /// current tab of its own, as every later window did before.
    Local(String),
    /// A machine over ssh: the window attaches to the default session of
    /// that machine's tmuxy server, created if missing.
    Ssh(SshForm),
    /// A session of its own on this machine, named or numbered, which is
    /// the user's like any other and outlives the window.
    New(Option<String>),
}

/// What an attach came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attached {
    Done,
    /// The ssh host's key is not known: the page shows its fingerprint and
    /// asks again with the form's `trust_new_host` set.
    UnknownHost {
        fingerprint: Option<String>,
    },
}

/// The tmux socket "this machine" means: the one the app is on, or, while the
/// app has been pointed over ssh (`tmuxy connect`), the one it launched on.
fn local_socket() -> String {
    if tmuxy_core::session::ssh_target().is_none() {
        return tmuxy_core::session::tmux_socket();
    }
    match std::env::var("TMUX_SOCKET") {
        Ok(socket) if !socket.is_empty() => socket,
        _ => DEFAULT_TMUX_SOCKET.to_string(),
    }
}

/// A session a later window made for itself (`<session>+<n>`): a view of
/// another session, never one to offer.
fn is_window_member(name: &str) -> bool {
    name.rsplit_once('+').is_some_and(|(base, n)| {
        !base.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// The sessions a splash page lists, from `list-sessions` output.
fn sessions_to_offer(stdout: &str) -> Vec<RemoteSessionInfo> {
    parse_session_list(stdout)
        .into_iter()
        .filter(|s| !is_window_member(&s.name))
        .collect()
}

/// The sessions on this machine's tmuxy server, from a read-only
/// `list-sessions`; empty when no server is running.
pub fn local_sessions() -> Vec<RemoteSessionInfo> {
    let socket = local_socket();
    let flag = if socket.contains('/') { "-S" } else { "-L" };
    Command::new(tmuxy_core::session::tmux_path())
        .args([
            flag,
            socket.as_str(),
            "list-sessions",
            "-F",
            LIST_SESSIONS_FORMAT,
        ])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| sessions_to_offer(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

/// A window's place in a session group on this machine: the target that
/// joins `name`'s group as the window's own member.
fn plan_local(name: &str, index: usize, local_socket: &str) -> Result<ConnectTarget, String> {
    if !tmuxy_core::session::is_safe_session_name(name) || is_window_member(name) {
        return Err(format!("'{name}' is not a session to join"));
    }
    Ok(ConnectTarget {
        socket: local_socket.to_string(),
        session: format!("{name}+{index}"),
        ssh: None,
    })
}

/// The name of a new session: the one asked for, which must be free, else the
/// lowest number no session has.
fn new_session_name(asked: Option<&str>, taken: &[String]) -> Result<String, String> {
    match asked.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => {
            if !tmuxy_core::session::is_safe_session_name(name) || is_window_member(name) {
                return Err(format!(
                    "'{name}' cannot name a session: letters, digits, '-', '_' and '.'"
                ));
            }
            if taken.iter().any(|t| t == name) {
                return Err(format!("there is a session named '{name}' already"));
            }
            Ok(name.to_string())
        }
        None => Ok((1..)
            .map(|n: usize| n.to_string())
            .find(|n| !taken.contains(n))
            .unwrap_or_default()),
    }
}

/// What the Window menu and the title name an ssh window by.
fn ssh_shown(form: &ssh_link::Checked) -> String {
    let mut shown = match &form.user {
        Some(user) => format!("{user}@{}", form.host),
        None => form.host.clone(),
    };
    if let Some(port) = form.port {
        shown.push_str(&format!(":{port}"));
    }
    shown
}

/// Attach the splash window `label` as chosen, and start its monitor there.
/// Blocks while an ssh connection authenticates: call it off the main thread.
pub fn attach(app: &AppHandle, label: &str, choice: Attach) -> Result<Attached, String> {
    let registry = app.state::<GuiWindows>();
    let entry = registry
        .get(label)
        .ok_or_else(|| format!("no window '{label}'"))?;
    if entry.attached() {
        return Err("this window is already attached".to_string());
    }
    let mut link: Option<SshLink> = None;
    let (target, group, owns_session, shown) = match &choice {
        Attach::Local(name) => {
            let target = plan_local(name, entry.index, &local_socket())?;
            if !local_sessions().iter().any(|s| &s.name == name) {
                return Err(format!("no session '{name}' on this machine"));
            }
            let shown = target.session.clone();
            (target, Some(name.clone()), true, shown)
        }
        Attach::New(asked) => {
            let taken: Vec<String> = local_sessions().into_iter().map(|s| s.name).collect();
            let name = new_session_name(asked.as_deref(), &taken)?;
            let target = ConnectTarget {
                socket: local_socket(),
                session: name.clone(),
                ssh: None,
            };
            (target, None, false, name)
        }
        Attach::Ssh(form) => {
            let checked = form.checked()?;
            let opened = match ssh_link::open(label, &checked)? {
                Opened::UnknownHost { fingerprint } => {
                    return Ok(Attached::UnknownHost { fingerprint })
                }
                Opened::Link(opened) => opened,
            };
            let target = ConnectTarget {
                socket: DEFAULT_TMUX_SOCKET.to_string(),
                session: tmuxy_core::DEFAULT_SESSION_NAME.to_string(),
                ssh: Some(opened.tail()),
            };
            link = Some(opened);
            (target, None, false, ssh_shown(&checked))
        }
    };
    let session = target.session.clone();
    if let Ok(mut cell) = entry.target.write() {
        *cell = Some(target);
    }
    let monitor = new_monitor(app, label, session);
    registry.attach(label, monitor.clone(), owns_session, link);
    if let Some(window) = app.get_webview_window(label) {
        // What the Window menu lists this window as.
        let _ = window.set_title(&format!("tmuxy — {shown}"));
    }

    tauri::async_runtime::spawn(scoped::with_cell(
        entry.target.clone(),
        crate::monitor::start_monitoring_window(monitor, group),
    ));
    Ok(Attached::Done)
}

/// Whether the first window's client is on the server `entry` is attached
/// to, so it can kill `entry`'s session when `entry` closes.
pub(super) fn main_shares_server(entry: &GuiWindow) -> bool {
    let target = entry.target.read().ok().and_then(|t| t.clone());
    target.is_some_and(|t| {
        t.ssh.is_none()
            && tmuxy_core::session::ssh_target().is_none()
            && t.socket == tmuxy_core::session::tmux_socket()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_pick_joins_the_session_group_as_its_own_member() {
        let Ok(target) = plan_local("work", 3, "tmuxy") else {
            panic!("a session name is a session to join");
        };
        assert_eq!(target.session, "work+3");
        assert_eq!(target.socket, "tmuxy");
        assert_eq!(target.ssh, None);
    }

    #[test]
    fn a_new_session_takes_the_name_asked_for_or_the_lowest_free_number() {
        let taken = vec!["1".to_string(), "work".to_string(), "3".to_string()];
        assert_eq!(new_session_name(None, &taken).as_deref(), Ok("2"));
        assert_eq!(new_session_name(Some("  "), &taken).as_deref(), Ok("2"));
        assert_eq!(
            new_session_name(Some(" notes "), &taken).as_deref(),
            Ok("notes")
        );
        assert!(new_session_name(Some("work"), &taken).is_err());
        assert!(new_session_name(Some("a b"), &taken).is_err());
        assert!(new_session_name(Some("work+2"), &taken).is_err());
    }

    #[test]
    fn an_ssh_window_is_named_by_who_where_and_which_port() {
        let form = |host: &str, port: Option<u16>| SshForm {
            host: host.to_string(),
            port,
            ..SshForm::default()
        };
        let Ok(plain) = form("box", None).checked() else {
            panic!("a form");
        };
        assert_eq!(ssh_shown(&plain), "box");
        let Ok(full) = form("me@box", Some(2222)).checked() else {
            panic!("a form");
        };
        assert_eq!(ssh_shown(&full), "me@box:2222");
    }

    #[test]
    fn a_window_member_or_unsafe_name_is_not_offered_or_joined() {
        assert!(plan_local("work+2", 3, "tmuxy").is_err());
        assert!(plan_local("a b", 3, "tmuxy").is_err());
        let listed = sessions_to_offer("work|3|1\nwork+2|3|1\nnotes|1|0\nc++|1|0\n");
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["work", "notes", "c++"]);
        assert_eq!((listed[0].windows, listed[0].attached), (3, true));
    }
}
