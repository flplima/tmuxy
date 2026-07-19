//! Typed errors for tmuxy-core.
//!
//! Previously every API in this crate returned `Result<T, String>`. That makes
//! it impossible for callers to do variant-by-variant recovery — for example
//! `monitor::run` wants to restart only on `ProcessExited`, retry on `Timeout`,
//! and surface `SessionNotFound` straight to the UI. With a string-typed error
//! the only options are substring matching (brittle) or a blanket "show the
//! message and give up" (loss of resilience).
//!
//! `TmuxError` is `#[non_exhaustive]` so adding a variant later is not a
//! breaking change for downstream matchers — they're forced to keep a `_`
//! catch-all from day one.
//!
//! Each variant carries the minimum context needed to act on it:
//!   - `ProcessExited { reason }` — control mode `%exit` was received or the
//!     PTY EOF'd. The supervisor can decide whether to reconnect.
//!   - `Timeout { operation, after }` — an operation exceeded its deadline.
//!     The retry-policy machinery inspects `operation`.
//!   - `SessionNotFound { name }` — `has-session` returned non-zero. The UI
//!     should ask the user to create the session.
//!   - `PaneNotFound { id }` — referenced pane id no longer exists. The
//!     aggregator drops queued operations on that pane.
//!   - `Io(std::io::Error)` — anything from the OS (PTY allocation, file
//!     reads, signal install). `#[from]` makes `?` propagation natural.
//!   - `ControlMode(String)` — fallback for tmux-emitted error text that
//!     doesn't fit a more specific variant. New variants should be promoted
//!     out of this bucket as their patterns become clear.

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

    /// A command referenced a pane id tmux no longer knows about.
    #[error("tmux pane '{id}' does not exist")]
    PaneNotFound { id: String },

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

    /// True when the error is plausibly transient and worth retrying.
    /// Retry policies in the retry layer consult this to decide whether to back off
    /// or surface.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            TmuxError::Timeout { .. } | TmuxError::Io(_) | TmuxError::ProcessExited { .. }
        )
    }
}

/// Bridge for legacy `Result<T, String>` call sites during the migration.
///
/// Erases the variant by funnelling into `ControlMode`. Use sparingly — the
/// goal is to eliminate the String error type altogether.
impl From<String> for TmuxError {
    fn from(s: String) -> Self {
        TmuxError::ControlMode(s)
    }
}

impl From<&str> for TmuxError {
    fn from(s: &str) -> Self {
        TmuxError::ControlMode(s.to_string())
    }
}

/// Bridge in the opposite direction for the remaining `Result<_, String>`
/// call sites (notably `tmuxy-server/src/sse.rs::handle_command`). Lets the
/// `?` operator stringify a `TmuxError` so the SSE handler can keep its
/// existing String-typed wire contract. a typed-progress channel would replace that contract if it is ever needed.
/// outright; until then, this preserves the JSON error shape the frontend
/// already understands.
impl From<TmuxError> for String {
    fn from(e: TmuxError) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn display_includes_variant_context() {
        let e = TmuxError::SessionNotFound {
            name: "foo".to_string(),
        };
        assert_eq!(e.to_string(), "tmux session 'foo' does not exist");
    }

    #[test]
    fn retryable_classifications() {
        assert!(TmuxError::Timeout {
            operation: "x".into(),
            after: std::time::Duration::from_secs(1),
        }
        .is_retryable());
        assert!(TmuxError::ProcessExited { reason: "y".into() }.is_retryable());
        assert!(!TmuxError::SessionNotFound { name: "z".into() }.is_retryable());
        assert!(!TmuxError::PaneNotFound { id: "%0".into() }.is_retryable());
        assert!(!TmuxError::other("misc").is_retryable());
    }

    #[test]
    fn string_bridge_round_trips() {
        let s: String = TmuxError::other("oops").into();
        assert_eq!(s, "tmux error: oops");
        let e: TmuxError = "fallback".to_string().into();
        assert!(matches!(e, TmuxError::ControlMode(_)));
    }

    #[test]
    fn io_error_propagates_via_from() {
        fn inner() -> Result<()> {
            std::fs::read_to_string("/nonexistent/path/for/test")?;
            Ok(())
        }
        let err = inner().unwrap_err();
        assert!(matches!(err, TmuxError::Io(_)));
    }
}
