//! Running a tmux command that changes something from a plugin verb: inside
//! `tmux run-shell`, where tmux runs it in its own context rather than as a
//! second client racing the control-mode one (docs/TMUX.md).
//!
//! The verb itself runs in the caller's process, so a `--wait` or an
//! interrupt is the caller's own and leaves nothing running inside tmux;
//! only the command list goes through `run-shell`. Its output and exit status
//! come back through owner-only files, as the CLI's `_run_shell` does: tmux
//! 3.4 shows a `run-shell`'s output, and a "returned 1", in a view mode on
//! the current pane instead of handing them to the client.

use super::{private_dir, PluginError, Result};
use crate::paths::Layout;

/// Run one tmux command list (`;` as its own argument) inside `run-shell`
/// and return what it printed.
pub fn run(dirs: &Layout, argv: &[String]) -> Result<String> {
    let dir = dirs
        .run_dir()
        .join(format!("job-{}", crate::random::token()));
    private_dir(&dir)?;
    let result = run_in(&dir, argv);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn run_in(dir: &std::path::Path, argv: &[String]) -> Result<String> {
    use crate::argv::{run_shell_line, run_shell_word};
    let file = |name: &str| run_shell_word(&dir.join(name).display().to_string());
    let line = format!(
        "{{ {} {} ; }} >{} 2>{}; echo $? >{}",
        run_shell_line(&crate::session::tmux_argv(false)),
        run_shell_line(argv),
        file("out"),
        file("err"),
        file("status"),
    );
    let client = crate::session::tmux_command()
        .args(["run-shell", &line])
        .output()
        .map_err(|e| PluginError::io("running tmux", e))?;
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap_or_default();
    let Ok(status) = read("status").trim().parse::<i32>() else {
        let why = String::from_utf8_lossy(&client.stderr).trim().to_string();
        if crate::session::is_no_server(&why) {
            return Err(PluginError::NoServer(why));
        }
        return Err(PluginError::Invalid(if why.is_empty() {
            "tmux did not run the command".to_string()
        } else {
            format!("tmux: {why}")
        }));
    };
    if status != 0 {
        return Err(PluginError::Invalid(format!(
            "tmux: {}",
            read("err").trim()
        )));
    }
    Ok(read("out"))
}
