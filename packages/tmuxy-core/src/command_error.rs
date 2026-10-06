//! Why a client command failed, in a form the client can act on.
//!
//! Both transports answer a failed command with the same object —
//! `{ "error": "<message>", "kind": "tmux" | "unavailable" | "invalid" |
//! "forbidden" }` — the web server as the body of a failed `POST /commands`,
//! the desktop app as the value a Tauri command rejects with. The kind is what
//! lets the client tell "tmux said no" (show it) from "try again in a moment"
//! without reading the message.

use std::fmt;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    /// tmux itself rejected the command (its reply was an `%error`).
    Tmux,
    /// No monitor, session or channel to run it on, a timeout, or a failure
    /// on this side that is not the request's fault.
    Unavailable,
    /// The request was malformed: the payload, or an argument in it.
    Invalid,
    /// Refused by policy: a read-only server, or a blocked command.
    Forbidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub error: String,
    pub kind: ErrorKind,
}

impl CommandError {
    pub fn new(kind: ErrorKind, error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            kind,
        }
    }

    pub fn tmux(error: impl Into<String>) -> Self {
        Self::new(ErrorKind::Tmux, error)
    }

    pub fn unavailable(error: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unavailable, error)
    }

    pub fn invalid(error: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, error)
    }

    pub fn forbidden(error: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, error)
    }

    /// The same failure, its message prefixed with what was being done.
    pub fn context(self, what: &str) -> Self {
        Self {
            error: format!("{what}: {}", self.error),
            kind: self.kind,
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.error)
    }
}

impl std::error::Error for CommandError {}

/// An id that does not parse is a malformed argument.
impl From<crate::IdError> for CommandError {
    fn from(e: crate::IdError) -> Self {
        Self::invalid(e.to_string())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_shape_is_error_and_kind() {
        for (err, kind) in [
            (CommandError::tmux("no such pane"), "tmux"),
            (CommandError::unavailable("x"), "unavailable"),
            (CommandError::invalid("x"), "invalid"),
            (CommandError::forbidden("x"), "forbidden"),
        ] {
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["kind"], kind);
            assert_eq!(json["error"], err.error);
            assert_eq!(json.as_object().unwrap().len(), 2);
        }
    }

    #[test]
    fn context_keeps_the_kind() {
        let err = CommandError::tmux("bad option").context("Failed to set theme");
        assert_eq!(err.error, "Failed to set theme: bad option");
        assert_eq!(err.kind, ErrorKind::Tmux);
    }

    #[test]
    fn a_bad_id_is_an_invalid_argument() {
        let err: CommandError = crate::PaneId::parse("x").unwrap_err().into();
        assert_eq!(err.kind, ErrorKind::Invalid);
    }
}
