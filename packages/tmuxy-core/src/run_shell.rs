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

/// Run one tmux command list (`;` as its own argument) inside `run-shell`
/// and return what it printed; a failure is its stderr.
pub fn tmux(dirs: &Layout, argv: &[String]) -> Result<String, RunShellError> {
    let mut line = run_shell_line(&crate::session::tmux_argv(false));
    line.push(' ');
    line.push_str(&run_shell_line(argv));
    let ran = shell(dirs, &line, None)?;
    if ran.status != 0 {
        return Err(RunShellError::Failed(ran.err.trim().to_string()));
    }
    Ok(ran.out)
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
