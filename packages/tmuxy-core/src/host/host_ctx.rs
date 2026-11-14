//! What a command needs of the host that received it ([`HostCtx`]): the one
//! seam between [`super::command::handle`] and the web server or the desktop
//! app, each answering `unavailable` for what it cannot do.

use std::future::Future;

use super::{ClientId, SessionRuntime};
use crate::session::ConnectTarget;
use crate::CommandError;

/// What a command needs of the host that received it.
pub trait HostCtx: Sync {
    fn runtime(&self) -> &SessionRuntime;

    /// The client asking, when the host can vouch for it: the web only for a
    /// connection id whose stream is open, since a size kept for an id no
    /// stream owns would pin the session's size for every real client.
    fn client(&self) -> Option<ClientId>;

    /// Whether this host can point itself at another tmux server (the web
    /// server serves only the socket it was started on).
    fn switches_servers(&self) -> bool {
        false
    }

    /// Reconnect to `target` (only called when [`Self::switches_servers`]).
    fn connect(
        &self,
        _target: ConnectTarget,
    ) -> impl Future<Output = Result<(), CommandError>> + Send {
        async { Err(not_here("connecting to another server")) }
    }

    /// Detach this client, leaving the tmux server and every session running.
    fn detach(&self) -> impl Future<Output = Result<(), CommandError>> + Send {
        async { Err(not_here("detaching")) }
    }

    /// Hand a checked link to the system browser.
    fn open_url(&self, _url: &str) -> Result<(), CommandError> {
        Err(not_here("opening a link"))
    }

    fn open_path(&self, _path: &std::path::Path) -> Result<(), CommandError> {
        Err(not_here("opening a file"))
    }
}

pub(super) fn not_here(what: &str) -> CommandError {
    CommandError::unavailable(format!("{what} is not available here"))
}
