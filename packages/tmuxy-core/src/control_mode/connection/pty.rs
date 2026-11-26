//! The PTY a control-mode client runs on: its size, and raw before the
//! client starts (X12).

use super::*;

impl ControlModeConnection {
    pub(super) fn allocate_pty(
        log: Option<&Arc<dyn LogSink>>,
    ) -> Result<(pty_process::Pty, pty_process::Pts), TmuxError> {
        let failed = |what: &str, e: &dyn std::fmt::Display| {
            let msg = format!("Failed to {what}: {e}");
            log_to(log, LogKind::Error, msg.clone());
            TmuxError::other(msg)
        };
        let (pty, pts) = pty_process::open().map_err(|e| failed("open pty", &e))?;
        pty.resize(pty_process::Size::new(
            INITIAL_PTY_ROWS as u16,
            INITIAL_PTY_COLS as u16,
        ))
        .map_err(|e| failed("set pty size", &e))?;
        make_raw(&pts).map_err(|e| failed("make the pty raw", &e))?;
        Ok((pty, pts))
    }
}

/// No echo, no line editing, no output translation, set before anything runs
/// on the terminal. tmux in control mode makes its terminal raw itself before
/// it writes a line. Over ssh the terminal is ssh's to set, and an ssh
/// window's client rides a master connection: the master forwards tmux's
/// lines while the client may not have left echo mode yet. A terminal still
/// echoing wrote each command tmuxy sent back in among tmux's lines, glued to
/// whatever line was arriving, and lost the answer that line framed.
fn make_raw(pts: &pty_process::Pts) -> nix::Result<()> {
    use nix::sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg};
    let mut mode = tcgetattr(pts)?;
    cfmakeraw(&mut mode);
    tcsetattr(pts, SetArg::TCSANOW, &mode)
}
