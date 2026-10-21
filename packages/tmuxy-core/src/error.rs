//! Typed errors for tmuxy-core.
//!
//! A typed error lets a caller act on the variant instead of matching on
//! message text: the server tells a missing session apart from everything
//! else.
//!
//! `TmuxError` is `#[non_exhaustive]`, so matchers outside the crate keep a
//! `_` arm and a new variant breaks none of them.
//!
//! Each variant carries the minimum context needed to act on it:
//!   - `ProcessExited { reason }` — control mode `%exit` was received or the
//!     PTY EOF'd.
//!   - `Timeout { operation, after }` — an operation exceeded its deadline.
//!   - `SessionNotFound { name }` — the named session does not exist.
//!   - `Io(std::io::Error)` — anything from the OS (PTY allocation, file
//!     reads). `#[from]` makes `?` propagation natural.
//!   - `Command { command, message }` — a one-off `tmux` subprocess that
//!     failed, with what it said.
//!   - `ControlMode(String)` — tmux-reported error text that fits no more
//!     specific variant.
//!
//! There is deliberately no `From<String>` and no `Into<String>`: a `?` that
//! turned a message into the fallback variant erased what the error was, and
//! one that turned a typed error back into text lost it again at the next
//! boundary. A boundary that speaks strings (a CLI's exit message, a JSON
//! error body) spells `.to_string()` where it crosses.

use thiserror::Error;

/// Convenience alias so call sites don't have to spell out the error type.
pub type Result<T, E = TmuxError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum TmuxError {
    /// The tmux process (or its control-mode session) ended unexpectedly.
    /// `reason` carries the message tmux wrote on `%exit`, if any.
    #[error("tmux process exited: {reason}")]
    ProcessExited { reason: String },

    /// An operation exceeded its deadline before tmux responded.
    #[error("tmux operation '{operation}' timed out after {after:?}")]
    Timeout {
        operation: String,
        after: std::time::Duration,
    },

    /// `has-session` (or equivalent) reports the named session doesn't exist.
    #[error("tmux session '{name}' does not exist")]
    SessionNotFound { name: String },

    /// Underlying I/O error (PTY, file system, signals, etc.).
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A one-off `tmux <command>` run as a subprocess failed: it could not be
    /// started, or it exited non-zero with `message` on stderr.
    #[error("tmux {command}: {message}")]
    Command { command: String, message: String },

    /// Fallback for tmux-reported errors that don't fit a more specific
    /// variant yet. Add a real variant when a recurring pattern emerges
    /// rather than growing this bucket indefinitely.
    #[error("tmux error: {0}")]
    ControlMode(String),
}

impl TmuxError {
    /// Convenience constructor for the `ControlMode` fallback. Lets call sites
    /// write `TmuxError::other("…")` without the verbose
    /// `TmuxError::ControlMode("…".to_string())`.
    pub fn other(msg: impl Into<String>) -> Self {
        TmuxError::ControlMode(msg.into())
    }
}
