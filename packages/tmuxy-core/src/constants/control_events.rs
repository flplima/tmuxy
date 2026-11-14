//! Control-mode event prefixes as `tmux -CC` writes them on its stdout.

pub const BEGIN: &str = "%begin ";
pub const END: &str = "%end ";
pub const ERROR: &str = "%error ";
pub const OUTPUT: &str = "%output ";
pub const EXTENDED_OUTPUT: &str = "%extended-output ";
pub const LAYOUT_CHANGE: &str = "%layout-change ";
pub const WINDOW_ADD: &str = "%window-add ";
pub const WINDOW_CLOSE: &str = "%window-close ";
pub const UNLINKED_WINDOW_ADD: &str = "%unlinked-window-add ";
pub const UNLINKED_WINDOW_CLOSE: &str = "%unlinked-window-close ";
pub const WINDOW_RENAMED: &str = "%window-renamed ";
pub const WINDOW_PANE_CHANGED: &str = "%window-pane-changed ";
pub const PANE_MODE_CHANGED: &str = "%pane-mode-changed ";
pub const SESSION_CHANGED: &str = "%session-changed ";
pub const SESSION_RENAMED: &str = "%session-renamed ";
pub const SESSIONS_CHANGED: &str = "%sessions-changed";
pub const SESSION_WINDOW_CHANGED: &str = "%session-window-changed ";
pub const PASTE_BUFFER_CHANGED: &str = "%paste-buffer-changed ";
pub const SUBSCRIPTION_CHANGED: &str = "%subscription-changed ";
pub const PAUSE: &str = "%pause ";
pub const CONTINUE: &str = "%continue ";
pub const MESSAGE: &str = "%message ";
pub const EXIT: &str = "%exit";
