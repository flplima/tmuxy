//! A session's start directory, kept somewhere a shell can start.
//!
//! tmux starts every new window and every split without a `-c` in the
//! session's working directory, fixed when the session was made. When that
//! directory goes away — the mount of an AppImage that started the server and
//! has since exited, a deleted checkout, an unplugged drive — every new tab
//! opens on `getcwd: cannot access parent directories`. The session outlives
//! the cause, so the attach is where it is put right: the directory is moved
//! to the user's home, the way `attach-session -c` moves it by hand.

use std::path::Path;

use crate::control_mode::MonitorCommandSender;
use crate::executor::tmux_quote;
use crate::CommandError;

/// The query whose answer [`start_dir_repair`] reads: the id of the session
/// the asking connection is attached to, and that session's start directory.
pub const START_DIR_QUERY: &str = "display-message -p '#{session_id} #{session_path}'";

/// The command that moves the session's start directory to `home`, from the
/// answer to [`START_DIR_QUERY`], when the directory is not one a shell could
/// start in; none while it is.
pub fn start_dir_repair(
    answer: &str,
    home: &Path,
    usable: impl Fn(&Path) -> bool,
) -> Option<String> {
    let (session_id, start_dir) = answer.trim().split_once(' ')?;
    if !session_id.starts_with('$') || start_dir.is_empty() || usable(Path::new(start_dir)) {
        return None;
    }
    Some(format!(
        "attach-session -t {} -c {}",
        tmux_quote(session_id),
        tmux_quote(&home.to_string_lossy())
    ))
}

/// Whether a shell can start in `dir`: it is a directory and it can be read.
/// A dead FUSE mount answers `ENOTCONN` here, a deleted one `ENOENT`.
fn usable_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok()
}

/// Read the start directory of the session the monitor is attached to, over
/// its own connection, and move it home if it is gone. A server over SSH is
/// another machine's, whose paths this one cannot judge.
pub async fn repair_start_dir(tx: &MonitorCommandSender) -> Result<(), CommandError> {
    if crate::session::ssh_target().is_some() {
        return Ok(());
    }
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        return Ok(());
    };
    let answer = super::query(tx, START_DIR_QUERY).await?;
    if let Some(cmd) = start_dir_repair(&answer, &home, usable_dir) {
        tracing::info!(
            target: "tmuxy_core::session",
            "the session's start directory is gone; new tabs start at home"
        );
        super::run(tx, &cmd).await?;
    }
    Ok(())
}
