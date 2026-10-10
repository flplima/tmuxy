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
//!   - `ControlMode(String)` — tmux-reported error text that fits no more
//!     specific variant.

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

/// Lets `?` lift a `String` error into the `ControlMode` variant, erasing any
/// more specific meaning — so prefer a real variant where one fits.
impl From<String> for TmuxError {
    fn from(s: String) -> Self {
        TmuxError::ControlMode(s)
    }
}

/// Lets `?` stringify a `TmuxError` where a caller speaks `Result<_, String>`
/// — notably the server's command handlers, whose JSON error shape is a
/// plain message string.
impl From<TmuxError> for String {
    fn from(e: TmuxError) -> Self {
        e.to_string()
    }
}
