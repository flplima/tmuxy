//! Running a tmux command that changes something from a command-line verb:
//! inside `tmux run-shell`, where tmux runs it in its own context rather than
//! as a second client racing the control-mode one (docs/TMUX.md).
//!
//! The verb itself runs in the caller's process, so a `--wait` or an
//! interrupt is the caller's own and leaves nothing running inside tmux; only
//! the command goes through `run-shell`. Its output and exit status come back
//! through owner-only files, as the CLI's `_run_shell` (`bin/tmuxy/_lib`)
//! does: tmux 3.4 shows a `run-shell`'s output, and a "returned 1", in a view
//! mode on the target pane instead of handing them to the client, and a pane
//! in view mode swallows every key typed into it.

use std::path::Path;

use crate::argv::{run_shell_line, run_shell_word};
use crate::paths::Layout;

/// What the command printed and its exit status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub status: i32,
    pub out: String,
    pub err: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunShellError {
    /// No tmux server answered on the socket.
    #[error("no tmux server: {0}")]
    NoServer(String),
    /// `run-shell` never ran the command; why, as tmux or the OS said it.
    #[error("{0}")]
    NotRun(String),
    /// The command ran and failed: its stderr.
    #[error("tmux: {0}")]
    Failed(String),
}

/// The pane the caller runs in, as tmuxy-cli resolved it (`TMUX_PANE`):
/// what a target-less command means, since the client inside `run-shell` is
/// attached to nothing.
pub fn caller_pane() -> Option<String> {
    std::env::var("TMUX_PANE")
        .ok()
        .filter(|pane| crate::PaneId::parse(pane).is_ok())
}

/// Run one tmux command list (`;` as its own argument) inside `run-shell`
/// and return what it printed; a failure is its stderr.
pub fn tmux(dirs: &Layout, argv: &[String]) -> Result<String, RunShellError> {
    let ran = tmux_as(dirs, None, argv)?;
    if ran.status != 0 {
        return Err(RunShellError::Failed(ran.err.trim().to_string()));
    }
    Ok(ran.out)
}

/// [`tmux`] run for `caller`, a pane: `run-shell -t` it, so the line's
/// formats expand for it, and it rides along as the inner client's
/// TMUX_PANE, which tmux reads for an unattached client the way it does for a
/// shell in a pane. What the command printed and its status, failed or not.
pub fn tmux_as(dirs: &Layout, caller: Option<&str>, argv: &[String]) -> Result<Ran, RunShellError> {
    let line = tmux_line(caller, &crate::session::tmux_argv(false), argv);
    shell(dirs, &line, caller)
}

/// tmux (its argv, `tmux`) running `argv`, as a line for `run-shell`: each
/// word quoted so neither run-shell's format expansion nor its shell reads
/// anything in it.
fn tmux_line(caller: Option<&str>, tmux: &[String], argv: &[String]) -> String {
    let mut line = caller
        .map(|pane| format!("TMUX_PANE={pane} "))
        .unwrap_or_default();
    line.push_str(&run_shell_line(tmux));
    line.push(' ');
    line.push_str(&run_shell_line(argv));
    line
}

/// Run `line`, a shell command line already written for `run-shell` (every
/// `#` meant literally doubled), with `target` as `run-shell -t`: the pane
/// its formats expand for.
pub fn shell(dirs: &Layout, line: &str, target: Option<&str>) -> Result<Ran, RunShellError> {
    let dir = dirs
        .run_dir()
        .join(format!("job-{}", crate::random::token()));
    crate::private_files::create_dir_all(&dir)
        .map_err(|e| RunShellError::NotRun(format!("creating {}: {e}", dir.display())))?;
    let result = shell_in(&dir, line, target);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn shell_in(dir: &Path, line: &str, target: Option<&str>) -> Result<Ran, RunShellError> {
    let file = |name: &str| run_shell_word(&dir.join(name).display().to_string());
    let wrapped = format!(
        "{{ {line} ; }} >{} 2>{}; echo $? >{}",
        file("out"),
        file("err"),
        file("status"),
    );
    let mut command = crate::session::tmux_command();
    command.arg("run-shell");
    if let Some(target) = target {
        command.args(["-t", target]);
    }
    let client = command
        .arg(&wrapped)
        .output()
        .map_err(|e| RunShellError::NotRun(format!("running tmux: {e}")))?;
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap_or_default();
    let Ok(status) = read("status").trim().parse::<i32>() else {
        let why = String::from_utf8_lossy(&client.stderr).trim().to_string();
        if crate::session::is_no_server(&why) {
            return Err(RunShellError::NoServer(why));
        }
        return Err(RunShellError::NotRun(if why.is_empty() {
            "tmux did not run the command".to_string()
        } else {
            format!("tmux: {why}")
        }));
    };
    Ok(Ran {
        status,
        out: read("out"),
        err: read("err"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_reaches_tmux_as_written_and_the_caller_rides_along() {
        let words = |w: &[&str]| w.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(
            tmux_line(
                Some("%1"),
                &words(&["tmux", "-S", "/tmp/my sockets/tmuxy"]),
                &words(&["list-panes", "-F", "#{a:59}id", "it's"]),
            ),
            "TMUX_PANE=%1 tmux -S '/tmp/my sockets/tmuxy' list-panes -F '##{a:59}id' 'it'\\''s'"
        );
        assert_eq!(
            tmux_line(
                None,
                &words(&["tmux", "-L", "tmuxy"]),
                &words(&["kill-server"])
            ),
            "tmux -L tmuxy kill-server"
        );
    }
}
