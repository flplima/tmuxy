//! What a host process — the web server, the desktop app — runs around the
//! sessions it serves, written once.
//!
//! ```text
//!   client ──command──▶ host door ──▶ command::handle(cmd, &ctx) ──▶ runtime
//!                       (HTTP / IPC)        │                          │
//!                                           ▼                          ▼
//!                                   HostCtx: what only           monitor channel
//!                                   the host knows               (supervise loop)
//!                                                                      │
//!   client ◀──HostEvent── Sink (SSE frame / Tauri event) ◀────── runtime emits
//! ```

mod bindings;
pub mod command;
mod event;
mod plugins;
pub mod prepare;
mod requests;
mod runtime;
pub mod socket_watch;
mod start;
mod supervise;

#[cfg(test)]
mod protocol_fixtures;

#[cfg(test)]
pub(crate) use bindings::parse_bindings;
pub use bindings::{
    ConfigChange, ImageStore, KeyBinding, KeyBindings, MAX_PANE_IMAGE_BYTES, SOURCE_ENTRY_CONF,
};
pub use command::{handle, ClientCommand, HostCtx};
pub use event::{ConnectionInfo, EventData, HostEvent};
pub use plugins::PluginToken;
pub use requests::{run_with_output, ScrollbackCells, SnapshotInfo, TraceSettings};
pub use runtime::{ClientId, RuntimeConfig, SessionRuntime, Sink, MONITOR_READY_TIMEOUT};
pub use start::{save_final_snapshots, start, Sessions, Started, FINAL_SNAPSHOT_TIMEOUT};
pub use supervise::*;

use crate::control_mode::MonitorConfig;

/// Create `config`'s session through another session's control-mode client
/// `via`, waiting for tmux's answer: an external `tmux new-session` while a
/// control-mode client is attached crashes tmux 3.5a. Detached, at the size
/// a fresh connection starts at, in the session's start directory unless
/// its first window names one.
pub async fn create_session_via(
    via: &crate::control_mode::MonitorCommandSender,
    config: &MonitorConfig,
) -> Result<(), crate::CommandError> {
    use crate::control_mode::{new_session_flags, INITIAL_PTY_COLS, INITIAL_PTY_ROWS};
    let mut words: Vec<String> = ["new-session", "-d", "-x"]
        .map(String::from)
        .into_iter()
        .chain([
            INITIAL_PTY_COLS.to_string(),
            "-y".to_string(),
            INITIAL_PTY_ROWS.to_string(),
        ])
        .collect();
    if let (None, Some(dir)) = (&config.first_window, &config.working_dir) {
        words.extend(["-c".to_string(), dir.display().to_string()]);
    }
    words.extend(new_session_flags(
        &config.session,
        config.group_target.as_deref(),
        config.first_window.as_ref(),
    ));
    crate::control_mode::query(via, &crate::argv::control_line(&words))
        .await
        .map(|_| ())
}

/// Whether tmux has a session called `session`. Asked with a subprocess, so
/// only before the host's own control-mode connection attaches (docs/TMUX.md).
pub async fn session_exists(session: &str) -> bool {
    let session = session.to_string();
    tokio::task::spawn_blocking(move || crate::session::session_known(&session))
        .await
        .unwrap_or(true)
}

pub fn monitor_config(session: &str, create_session: bool) -> MonitorConfig {
    MonitorConfig {
        session: session.to_string(),
        create_session,
        working_dir: Some(session_start_dir()),
        ..Default::default()
    }
}

/// The directory a host-created session starts in, and so every new tab's
/// cwd: `TMUXY_START_DIR` when set (the dev loop sets the checkout), else the
/// home directory. Never the process cwd while there is a home: an AppImage
/// runs from its mount (`/tmp/.mount_tmuxy…/usr`), and an app opened from
/// Finder or a launcher runs from `/`.
pub fn session_start_dir() -> std::path::PathBuf {
    session_start_dir_from(
        std::env::var_os("TMUXY_START_DIR")
            .filter(|dir| !dir.is_empty())
            .map(std::path::PathBuf::from),
        std::env::var_os("HOME").map(std::path::PathBuf::from),
        std::env::current_dir().ok(),
    )
}

fn session_start_dir_from(
    asked: Option<std::path::PathBuf>,
    home: Option<std::path::PathBuf>,
    cwd: Option<std::path::PathBuf>,
) -> std::path::PathBuf {
    asked
        .or(home)
        .or(cwd)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// The machine's host name for the status line. The web client cannot use
/// `location.hostname` (the address typed, `localhost` or an IP), so the
/// greeting carries it. Empty when the OS will not say.
pub fn host_name() -> String {
    #[cfg(unix)]
    {
        nix::unistd::gethostname()
            .ok()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

/// The name of the machine tmux runs on, for the status line, the page title
/// and push notifications: this machine's, unless tmux is reached over ssh,
/// where it is the remote's own (tmux's `#{host}`), which an ssh window or
/// `tmuxy connect` showed as this machine's name. Read once per ssh target,
/// over the connection the target already rides; empty when it cannot be read.
pub fn server_host_name() -> String {
    let Some(ssh) = crate::session::ssh_target() else {
        return host_name();
    };
    static REMOTE: std::sync::Mutex<Vec<(Vec<String>, String)>> = std::sync::Mutex::new(Vec::new());
    let mut known = REMOTE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, name)) = known.iter().find(|(target, _)| *target == ssh) {
        return name.clone();
    }
    // Over ssh the arguments reach the remote shell as text, where an
    // unquoted `#` starts a comment: the format goes quoted for it.
    let name = crate::session::tmux_command()
        .args(["display-message", "-p", "'#{host}'"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    if !name.is_empty() {
        known.push((ssh, name.clone()));
    }
    name
}

#[cfg(test)]
mod tests {
    use super::session_start_dir_from;
    use std::path::PathBuf;

    #[test]
    fn the_asked_directory_wins_so_the_dev_loop_starts_in_the_repo() {
        let dir = session_start_dir_from(
            Some(PathBuf::from("/src/tmuxy")),
            Some(PathBuf::from("/home/u")),
            Some(PathBuf::from("/tmp/.mount_tmuxyAb12/usr")),
        );
        assert_eq!(dir, PathBuf::from("/src/tmuxy"));
    }

    /// A process started under any JS monorepo (a `package.json` with
    /// `"workspaces"` above its cwd) used to start its sessions at that
    /// repository's root: the dev loop's rule, sniffed in production.
    #[test]
    fn unasked_the_home_directory_not_the_process_cwd() {
        let dir = session_start_dir_from(
            None,
            Some(PathBuf::from("/home/u")),
            Some(PathBuf::from("/tmp/.mount_tmuxyAb12/usr")),
        );
        assert_eq!(dir, PathBuf::from("/home/u"));
    }

    #[test]
    fn with_no_home_the_cwd_is_what_is_left() {
        let dir = session_start_dir_from(None, None, Some(PathBuf::from("/")));
        assert_eq!(dir, PathBuf::from("/"));
    }

    /// The courier's `new-session` is the direct path's, plus what a session
    /// made from another client needs (detached, a size, a directory), and it
    /// is answered: it was queued fire-and-forget and polled for with
    /// `has-session` fifty times.
    #[tokio::test]
    async fn a_session_made_through_another_client_is_waited_for_by_its_answer() {
        use crate::control_mode::{CommandReply, MonitorCommand};
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let asked = tokio::spawn(async move {
            match rx.recv().await {
                Some(MonitorCommand::RunCommandWithReply { command, reply }) => {
                    let _ = reply.send(CommandReply {
                        output: String::new(),
                        error: None,
                    });
                    command
                }
                _ => panic!("expected a command with a reply"),
            }
        });
        let config = crate::control_mode::MonitorConfig {
            session: "work".to_string(),
            group_target: Some("base".to_string()),
            working_dir: Some(PathBuf::from("/home/u")),
            ..Default::default()
        };
        super::create_session_via(&tx, &config).await.unwrap();
        assert_eq!(
            asked.await.unwrap(),
            "new-session -d -x 200 -y 50 -c /home/u -s work -t =base"
        );
    }
}
