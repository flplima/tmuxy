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
mod supervise;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod protocol_fixtures;

#[cfg(test)]
pub(crate) use bindings::parse_bindings;
pub use bindings::{
    watch_config, ConfigChange, ImageStore, KeyBinding, KeyBindings, MAX_PANE_IMAGE_BYTES,
    SOURCE_ENTRY_CONF,
};
pub use command::{handle, ClientCommand, HostCtx};
pub use event::{ConnectionInfo, EventData, HostEvent};
pub use plugins::PluginToken;
pub use requests::{run_with_output, ScrollbackCells, SnapshotInfo, TraceSettings};
pub use runtime::{ClientId, RuntimeConfig, SessionRuntime, Sink, MONITOR_READY_TIMEOUT};
pub use supervise::*;

use crate::control_mode::MonitorConfig;

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
/// cwd: the checkout when run from one (the dev loop lives there), else the
/// home directory. Never the process cwd: an AppImage runs from its mount
/// (`/tmp/.mount_tmuxy…/usr`), and an app opened from Finder or a launcher
/// runs from `/`.
pub fn session_start_dir() -> std::path::PathBuf {
    session_start_dir_from(
        checkout_root(),
        std::env::var_os("HOME").map(std::path::PathBuf::from),
        std::env::current_dir().ok(),
    )
}

fn session_start_dir_from(
    checkout: Option<std::path::PathBuf>,
    home: Option<std::path::PathBuf>,
    cwd: Option<std::path::PathBuf>,
) -> std::path::PathBuf {
    checkout
        .or(home)
        .or(cwd)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// The repository root when the process runs from a checkout: the nearest
/// ancestor whose package.json declares "workspaces" (a package's own does not).
pub fn checkout_root() -> Option<std::path::PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        let pkg_json = current.join("package.json");
        if let Ok(content) = std::fs::read_to_string(&pkg_json) {
            if content.contains("\"workspaces\"") {
                return Some(current);
            }
        }
        if !current.pop() {
            return None;
        }
    }
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

#[cfg(test)]
mod tests {
    use super::session_start_dir_from;
    use std::path::PathBuf;

    #[test]
    fn a_checkout_wins_so_the_dev_loop_starts_in_the_repo() {
        let dir = session_start_dir_from(
            Some(PathBuf::from("/src/tmuxy")),
            Some(PathBuf::from("/home/u")),
            Some(PathBuf::from("/tmp/.mount_tmuxyAb12/usr")),
        );
        assert_eq!(dir, PathBuf::from("/src/tmuxy"));
    }

    #[test]
    fn outside_a_checkout_the_home_directory_not_the_process_cwd() {
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
}
