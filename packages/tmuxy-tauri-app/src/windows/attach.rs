//! A later window's splash page and what it chooses: a session on this
//! machine, whose group the window joins, or an ssh host, whose tmuxy server
//! the window attaches to (docs/DESKTOP.md).
//!
//! The choice becomes the window's own target before its monitor starts, and
//! the monitor runs inside it, so every tmux call made for the window — the
//! control-mode connection and the reads beside it — reaches that server while
//! the other windows stay where they are.

use std::process::Command;

use tauri::{AppHandle, Manager};
use tmuxy_core::servers::{parse_session_list, RemoteSessionInfo, LIST_SESSIONS_FORMAT};
use tmuxy_core::session::{scoped, ConnectTarget, DEFAULT_TMUX_SOCKET};

use super::{new_monitor, GuiWindow, GuiWindows};

/// What a splash page chose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attach {
    /// A session on this machine: the window joins its group, keeping a
    /// current tab of its own, as every later window did before.
    Local(String),
    /// An ssh destination (`[user@]host`): the window attaches to the default
    /// session of that machine's tmuxy server, created if missing.
    Ssh(String),
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

/// What attaching means for a choice: the window's target, the session whose
/// group it joins, and whether the window owns (and on close kills) its session.
fn plan(
    choice: &Attach,
    index: usize,
    local_socket: &str,
) -> Result<(ConnectTarget, Option<String>, bool), String> {
    match choice {
        Attach::Local(name) => {
            if !tmuxy_core::session::is_safe_session_name(name) || is_window_member(name) {
                return Err(format!("'{name}' is not a session to join"));
            }
            let target = ConnectTarget {
                socket: local_socket.to_string(),
                session: format!("{name}+{index}"),
                ssh: None,
            };
            Ok((target, Some(name.clone()), true))
        }
        Attach::Ssh(dest) => {
            let dest = dest.trim();
            if !tmuxy_core::session::is_ssh_destination(dest) {
                return Err(format!(
                    "'{dest}' is not an ssh destination: host or user@host"
                ));
            }
            let target = ConnectTarget {
                socket: DEFAULT_TMUX_SOCKET.to_string(),
                session: tmuxy_core::DEFAULT_SESSION_NAME.to_string(),
                ssh: Some(dest.to_string()),
            };
            Ok((target, None, false))
        }
    }
}

/// Attach the splash window `label` as chosen, and start its monitor there.
pub fn attach(app: &AppHandle, label: &str, choice: Attach) -> Result<(), String> {
    let registry = app.state::<GuiWindows>();
    let entry = registry
        .get(label)
        .ok_or_else(|| format!("no window '{label}'"))?;
    if entry.attached() {
        return Err("this window is already attached".to_string());
    }
    let (target, group, owns_session) = plan(&choice, entry.index, &local_socket())?;
    if let Attach::Local(name) = &choice {
        if !local_sessions().iter().any(|s| &s.name == name) {
            return Err(format!("no session '{name}' on this machine"));
        }
    }
    let session = target.session.clone();
    let shown = match &choice {
        Attach::Local(_) => session.clone(),
        Attach::Ssh(dest) => dest.trim().to_string(),
    };
    if let Ok(mut cell) = entry.target.write() {
        *cell = Some(target);
    }
    let monitor = new_monitor(app, label, session);
    registry.attach(label, monitor.clone(), owns_session);
    if let Some(window) = app.get_webview_window(label) {
        // What the Window menu lists this window as.
        let _ = window.set_title(&format!("tmuxy — {shown}"));
    }

    tauri::async_runtime::spawn(scoped::with_cell(
        entry.target.clone(),
        crate::monitor::start_monitoring_window(monitor, group),
    ));
    Ok(())
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
        let Ok((target, group, owns)) = plan(&Attach::Local("work".into()), 3, "tmuxy") else {
            panic!("a session name is a session to join");
        };
        assert_eq!(target.session, "work+3");
        assert_eq!(target.socket, "tmuxy");
        assert_eq!(target.ssh, None);
        assert_eq!(group.as_deref(), Some("work"));
        assert!(owns);
    }

    #[test]
    fn an_ssh_host_attaches_to_that_machines_default_session() {
        let Ok((target, group, owns)) = plan(&Attach::Ssh(" me@box ".into()), 2, "tmuxy") else {
            panic!("user@host is an ssh destination");
        };
        assert_eq!(target.ssh.as_deref(), Some("me@box"));
        assert_eq!(target.socket, DEFAULT_TMUX_SOCKET);
        assert_eq!(target.session, tmuxy_core::DEFAULT_SESSION_NAME);
        assert_eq!(group, None);
        assert!(!owns);
    }

    #[test]
    fn an_ssh_option_or_command_is_refused() {
        for bad in ["-oProxyCommand=sh", "me@box ls", "", "a;b"] {
            assert!(plan(&Attach::Ssh(bad.into()), 2, "tmuxy").is_err(), "{bad}");
        }
    }

    #[test]
    fn a_window_member_or_unsafe_name_is_not_offered_or_joined() {
        assert!(plan(&Attach::Local("work+2".into()), 3, "tmuxy").is_err());
        assert!(plan(&Attach::Local("a b".into()), 3, "tmuxy").is_err());
        let listed = sessions_to_offer("work|3|1\nwork+2|3|1\nnotes|1|0\nc++|1|0\n");
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["work", "notes", "c++"]);
        assert_eq!((listed[0].windows, listed[0].attached), (3, true));
    }
}
