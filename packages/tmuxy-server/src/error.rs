//! Typed errors at the HTTP/SSE boundary.
//!
//! `TmuxError` (in `tmuxy-core`) covers tmux interaction failures. Server
//! handlers can also fail in ways that have nothing to do with tmux — JSON
//! decoding, missing-session lookups in `AppState`, channel send failures
//! when the monitor task has gone away. `ServerError` is the umbrella enum
//! that wraps both.
//!
//! For now most call sites still stringify errors before returning them to
//! the SSE client (the wire protocol is `{ "error": "<msg>" }`). This module
//! exists so the next refactor pass can introduce typed error responses
//! without another invasive sweep.

use thiserror::Error;
use tmuxy_core::TmuxError;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ServerError {
    /// Anything raised by `tmuxy-core`. `#[from]` enables `?` propagation
    /// from tmux helpers.
    #[error(transparent)]
    Tmux(#[from] TmuxError),

    /// The named session has no monitor and we have no way to start one
    /// (e.g. an out-of-band command was received before the SSE handshake).
    #[error("no active monitor for session '{session}'")]
    NoActiveMonitor { session: String },

    /// The monitor task's command channel is closed — the supervisor either
    /// finished cleanup or panicked. Caller should reconnect.
    #[error("monitor command channel closed for session '{session}'")]
    MonitorChannelClosed { session: String },

    /// Failed to serialize / deserialize a wire payload.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// Underlying I/O error (file reads, socket binds).
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Catch-all for messages that don't yet have a typed variant.
    #[error("{0}")]
    Other(String),
}

impl ServerError {
    pub fn other(msg: impl Into<String>) -> Self {
        ServerError::Other(msg.into())
    }
}

impl From<&str> for ServerError {
    fn from(s: &str) -> Self {
        ServerError::Other(s.to_string())
    }
}

impl From<String> for ServerError {
    fn from(s: String) -> Self {
        ServerError::Other(s)
    }
}

/// Bridge to the legacy `Result<_, String>` wire shape. Same rationale as the
/// `TmuxError -> String` bridge in `tmuxy-core::error`: lets the SSE handler
/// keep its existing JSON error format until the response side is migrated.
impl From<ServerError> for String {
    fn from(e: ServerError) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn tmux_error_propagates_via_from() {
        let inner: Result<(), TmuxError> = Err(TmuxError::SessionNotFound { name: "foo".into() });
        let outer: Result<(), ServerError> = inner.map_err(Into::into);
        let err = outer.unwrap_err();
        assert!(matches!(
            err,
            ServerError::Tmux(TmuxError::SessionNotFound { .. })
        ));
        assert_eq!(err.to_string(), "tmux session 'foo' does not exist");
    }
}
