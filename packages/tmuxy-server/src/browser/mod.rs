//! The browser engine behind `tmuxy browser`, driven by a program in a pane.
//!
//! The browser widget frames pages in the VIEWER's browser (see
//! `tmuxy-ui/src/components/widgets/browser/`). That is the right thing for a
//! human reading a page: the client renders natively, inherits the theme, and
//! the page has the viewer's own network position. It cannot do three things,
//! and this module is for those three:
//!
//!   * frame a site that refuses to be framed (`X-Frame-Options: DENY`);
//!   * let an agent DRIVE a page — query the DOM, click, wait, read back —
//!     which an iframe gives no access to across origins;
//!   * outlive the tab, so a session survives a reload, a detach or an SSH
//!     drop.
//!
//! So the two coexist rather than compete, and the widget stays the default.
//!
//! The engine is the user's own Chromium-family browser, driven over the
//! DevTools Protocol (`discover`) and launched as whoever typed the command.
//! tmuxy ships none: see that module for why, and `docs/SECURITY.md` ("A Real
//! Browser Driven From a Pane Changes Whose Network This Is") for what changes
//! once a page is fetched from the pane's machine instead of by the viewer.

use std::path::PathBuf;

pub mod discover;
pub mod engine;
pub mod verbs;
// The pane program puts the terminal in raw mode and reads SGR mouse reports
// off the pty, neither of which has a Windows equivalent here. The engine and
// the verbs are portable; driving a pane is not.
#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod pane;
#[cfg(unix)]
pub mod session;

/// Where a session's profile and screenshots live.
///
/// The same resolution the trace file uses (`tmuxy-core::trace`): the XDG state
/// dir on Linux, `~/Library/Application Support` on macOS, which has none. A
/// browser profile is a few hundred MB and must not land anywhere `/api/browse`
/// serves, which rules out the config dir.
///
/// `TMUXY_STATE_DIR` overrides it, matching `bin/dev-server` — a test or a
/// second server needs somewhere of its own, and two servers sharing a profile
/// path would fight over the lock.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TMUXY_STATE_DIR") {
        return PathBuf::from(dir);
    }
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(std::env::temp_dir)
        .join("tmuxy")
}
