//! There is deliberately no `From<String>` and no `Into<String>`: a `?` that
//! turned a message into the fallback variant erased what the error was, and
//! one that turned a typed error back into text lost it again at the next
//! boundary. A boundary that speaks strings (a CLI's exit message, a JSON
//! error body) spells `.to_string()` where it crosses.

use thiserror::Error;

pub type Result<T, E = TmuxError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum TmuxError {
    /// The tmux process (or its control-mode session) ended unexpectedly.
    /// `reason` carries the message tmux wrote on `%exit`, if any.
    #[error("tmux process exited: {reason}")]
    ProcessExited { reason: String },

    #[error("tmux operation '{operation}' timed out after {after:?}")]
    Timeout {
        operation: String,
        after: std::time::Duration,
    },

    /// `has-session` (or equivalent) reports the named session doesn't exist.
    #[error("tmux session '{name}' does not exist")]
    SessionNotFound { name: String },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A one-off `tmux <command>` run as a subprocess failed: it could not be
    /// started, or it exited non-zero with `message` on stderr.
    #[error("tmux {command}: {message}")]
    Command { command: String, message: String },

    /// Fallback for tmux-reported errors that fit no more specific variant.
    /// Add a real variant when a recurring pattern emerges.
    #[error("tmux error: {0}")]
    ControlMode(String),
}

impl TmuxError {
    pub fn other(msg: impl Into<String>) -> Self {
        TmuxError::ControlMode(msg.into())
    }
}
