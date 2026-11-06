//! Every event a host pushes to its client, with the name it travels under.
//!
//! One enum for both transports: the web server writes an event as an SSE
//! frame (`event: <name>`, `data: {"event": <name>, "data": <payload>}`),
//! the desktop app as a Tauri event (`emit_to(label, <name>, <payload>)`).
//! The protocol fixtures serialise it once (`events.json`), and the
//! client decodes both transports with the one table that file pins
//! (`tmuxy-ui/src/infra/transport/hostEvents.ts`).

use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;

use crate::control_mode::LogKind;
use crate::theme::ThemeSettings;
use crate::transport::KeyBindings;
use crate::StateUpdate;

/// What a client is told when it connects, before anything else.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConnectionInfo {
    /// The id the client names itself by in later commands (the web's
    /// `X-Connection-Id`); the desktop window's client is always 0.
    pub connection_id: u64,
    pub default_shell: String,
    pub trace_enabled: bool,
    pub hostname: String,
}

impl ConnectionInfo {
    pub fn for_client(connection_id: u64) -> Self {
        Self {
            connection_id,
            default_shell: std::env::var("SHELL")
                .ok()
                .and_then(|s| s.rsplit('/').next().map(String::from))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "bash".to_string()),
            trace_enabled: crate::trace::is_enabled(),
            hostname: super::host_name(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum HostEvent {
    ConnectionInfo(ConnectionInfo),
    StateUpdate(Box<StateUpdate>),
    /// Something the user should read (tmux refused a command, a sync
    /// failed), never a statement about the link. Named `tmux-error`: the
    /// browser dispatches a server event called `error` to
    /// `EventSource.onerror` as well.
    Error {
        message: String,
    },
    /// The tmux connection ended or could not be made, and the host is
    /// trying again. The desktop shows the reconnect notice on it; on the web
    /// the stream itself is the link, so it is only logged.
    Reconnecting {
        message: String,
    },
    KeyBindings(KeyBindings),
    /// Pushed after the config is sourced, so option changes apply live.
    ThemeSettings(Box<ThemeSettings>),
    /// A theme file or `custom.css` under the config dir was saved: the
    /// client re-fetches its stylesheets and the themes list.
    CssChanged,
    Log {
        kind: LogKind,
        message: String,
    },
    /// The host gave up on the session; nothing follows.
    Fatal {
        message: String,
    },
    /// The control-mode connection ended with tmux's own `%exit` reason
    /// (`detached` when the client was detached deliberately), so a client
    /// can tell an intentional detach from a dropped link.
    Detached {
        reason: Option<String>,
    },
    /// An OSC 52 clipboard write (or a paste-buffer yank, `pane_id` empty).
    Clipboard {
        pane_id: String,
        text: String,
    },
    /// A message tmux showed this client (`display-message`). Named
    /// `tmux-message`: `message` is `EventSource`'s default event type, which
    /// `onmessage` would receive as well.
    Message {
        text: String,
    },
}

impl HostEvent {
    pub fn name(&self) -> &'static str {
        match self {
            Self::ConnectionInfo(_) => "connection-info",
            Self::StateUpdate(_) => "state-update",
            Self::Error { .. } => "tmux-error",
            Self::Reconnecting { .. } => "reconnecting",
            Self::KeyBindings(_) => "keybindings",
            Self::ThemeSettings(_) => "theme-settings",
            Self::CssChanged => "css-changed",
            Self::Log { .. } => "log",
            Self::Fatal { .. } => "fatal",
            Self::Detached { .. } => "detached",
            Self::Clipboard { .. } => "clipboard",
            Self::Message { .. } => "tmux-message",
        }
    }

    /// The payload, as a Tauri event carries it and an SSE frame's `data`.
    pub fn data(&self) -> EventData<'_> {
        EventData(self)
    }
}

#[derive(Clone, Copy)]
pub struct EventData<'a>(&'a HostEvent);

#[derive(Serialize)]
struct Message<'a> {
    message: &'a str,
}

impl Serialize for EventData<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            HostEvent::ConnectionInfo(info) => info.serialize(serializer),
            HostEvent::StateUpdate(update) => update.serialize(serializer),
            HostEvent::Error { message }
            | HostEvent::Reconnecting { message }
            | HostEvent::Fatal { message } => Message { message }.serialize(serializer),
            HostEvent::KeyBindings(bindings) => bindings.serialize(serializer),
            HostEvent::ThemeSettings(settings) => settings.serialize(serializer),
            HostEvent::CssChanged => serializer.serialize_unit(),
            HostEvent::Log { kind, message } => {
                let mut s = serializer.serialize_struct("Log", 2)?;
                s.serialize_field("kind", kind)?;
                s.serialize_field("message", message)?;
                s.end()
            }
            HostEvent::Detached { reason } => {
                let mut s = serializer.serialize_struct("Detached", 1)?;
                s.serialize_field("reason", reason)?;
                s.end()
            }
            HostEvent::Clipboard { pane_id, text } => {
                let mut s = serializer.serialize_struct("Clipboard", 2)?;
                s.serialize_field("pane_id", pane_id)?;
                s.serialize_field("text", text)?;
                s.end()
            }
            HostEvent::Message { text } => {
                let mut s = serializer.serialize_struct("Message", 1)?;
                s.serialize_field("text", text)?;
                s.end()
            }
        }
    }
}

/// The SSE frame body: `{ "event": <name>, "data": <payload> }`.
impl Serialize for HostEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("HostEvent", 2)?;
        s.serialize_field("event", self.name())?;
        s.serialize_field("data", &self.data())?;
        s.end()
    }
}
