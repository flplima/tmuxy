//! tmux as a subprocess, for the command-line verbs.
//!
//! Safe where those verbs run: reads anywhere, and mutations only from inside
//! `tmux run-shell`, where tmux runs them in its own context rather than as a
//! second client racing the control-mode one (docs/TMUX.md). The CLI wraps
//! every mutating verb that way.

/// Run one tmux invocation and return what it printed.
pub(crate) fn tmux(argv: &[String]) -> Result<String, String> {
    let output = tmuxy_core::session::tmux_command()
        .args(argv)
        .output()
        .map_err(|e| format!("tmux {}: {e}", argv.join(" ")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "tmux {}: {}",
            argv.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
