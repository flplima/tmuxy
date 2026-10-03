//! The server-side browser engine behind `tmuxy browser`.
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
//! DevTools Protocol (`discover`). tmuxy ships none: see that module for why,
//! and `docs/SECURITY.md` ("A Server-Side Browser Changes Whose Network This
//! Is") for what changes once a page is fetched by the server instead of by
//! the viewer.

use std::path::PathBuf;

pub mod discover;
pub mod engine;
pub mod pipe;
pub mod verbs;
// The pipe transport places file descriptors in a forked child, which has no
// Windows equivalent; the desktop app does not use this module at all.
#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod process;
#[cfg(unix)]
pub mod session;

/// Where a session's profile and screenshots live.
///
/// The same resolution the trace file uses (`tmuxy-core::trace`): the XDG state
/// dir on Linux, `~/Library/Application Support` on macOS, which has none. A
/// browser profile is a few hundred MB and must not land anywhere `/api/file`
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
