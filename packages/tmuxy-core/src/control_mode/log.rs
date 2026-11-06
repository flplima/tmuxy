//! Streaming log sink for connection-time progress. Connecting runs external
//! `tmux` invocations before control mode is up; when one fails on a user's
//! machine, knowing *which* step failed and what it printed is far more
//! useful than one consolidated error string.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    /// A command about to be executed (e.g. `tmux has-session -t foo`)
    Command,
    /// Output produced by a previously-logged command (stdout/stderr/exit)
    Output,
    /// Informational progress message (no associated command)
    Info,
    /// A non-fatal error encountered mid-flow
    Error,
}

/// Receives streaming progress entries during connection setup.
///
/// Implementations should be cheap and non-blocking — entries are emitted
/// from inside the connect path and any latency directly delays the user.
pub trait LogSink: Send + Sync {
    fn log(&self, kind: LogKind, message: String) {
        let _ = (kind, message);
    }
}
