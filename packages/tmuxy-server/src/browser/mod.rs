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

pub mod discover;
pub mod engine;
pub mod pipe;
// The pipe transport places file descriptors in a forked child, which has no
// Windows equivalent; the desktop app does not use this module at all.
#[cfg(unix)]
pub mod process;
