//! Streaming log sink for surfacing connection-time progress.
//!
//! Connection setup runs several external `tmux` invocations (has-session,
//! list-sessions, new-session, then a PTY spawn of `tmux -CC attach-session`).
//! When something fails on a user's machine, knowing *which* step failed
//! and what its output was is far more useful than a single consolidated
//! error string. The sink is threaded through connection.rs and monitor.rs
//! so each step can be reported as it happens.

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
