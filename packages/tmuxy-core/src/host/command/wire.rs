//! [`ClientCommand`]: every command a client can send, as it arrives on the
//! wire (`{ "cmd": …, "args": { … } }`), and how a body is read into one.
//! What each does is [`super::handle`].

use serde::Deserialize;
use serde_json::Value;

use crate::PaneId;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum ClientCommand {
    /// The session's state at the client's viewport, which it reports here
    /// too (a zero size is no report).
    GetInitialState {
        #[serde(default)]
        cols: Option<u32>,
        #[serde(default)]
        rows: Option<u32>,
    },
    SetClientSize {
        cols: u32,
        rows: u32,
    },
    RunTmuxCommand {
        command: String,
    },
    /// Run a tmux command and return what it printed, over the monitor's
    /// control-mode connection like every mutation, so nothing a client sends
    /// reaches a shell.
    QueryTmux {
        command: String,
    },
    GetScrollbackCells {
        #[serde(rename = "paneId")]
        pane_id: PaneId,
        #[serde(default = "default_scrollback_start")]
        start: i64,
        #[serde(default = "default_scrollback_end")]
        end: i64,
    },
    /// The rows a pane's shell prompts start on (OSC 133), for the scrollback
    /// view's marks and the jump between prompts.
    GetPromptMarks {
        #[serde(rename = "paneId")]
        pane_id: PaneId,
    },
    /// What the pane's newest command printed, as text.
    GetLastCommandOutput {
        #[serde(rename = "paneId")]
        pane_id: PaneId,
    },
    /// A `preview` pane's document (`path` absent) or a resource it links
    /// (`path` relative to it). The pane names nothing on disk: what it may
    /// read is the pane's own `@tmuxy-pane-preview`, asked of tmux on every
    /// call (`crate::preview`).
    ReadPreview {
        #[serde(rename = "paneId")]
        pane_id: PaneId,
        #[serde(default)]
        path: Option<String>,
    },
    /// Stage a `preview` pane's composed page for its frame (the desktop's
    /// `tmuxypreview:` scheme serves it; the web stages over
    /// `POST /api/preview/{pane}`).
    StagePreview {
        #[serde(rename = "paneId")]
        pane_id: PaneId,
        html: String,
    },
    GetThemeSettings,
    SetTheme {
        name: String,
        #[serde(default)]
        mode: Option<String>,
    },
    SetThemeMode {
        mode: String,
    },
    GetThemesList,
    /// The profiles, and the one the caller's session uses
    /// (`crate::profiles`). Every profile command answers the same.
    ListProfiles,
    /// Move the caller's session to a profile, live.
    UseProfile {
        name: String,
    },
    /// A new profile, a copy of `from` (the default: one that changes
    /// nothing), which the caller's session then uses.
    CreateProfile {
        name: String,
        #[serde(default)]
        from: Option<String>,
    },
    RenameProfile {
        from: String,
        to: String,
    },
    DeleteProfile {
        name: String,
    },
    SetCursorBlink {
        enabled: bool,
    },
    SetSendAsk {
        enabled: bool,
    },
    SetTransparency {
        enabled: bool,
    },
    /// Git worktrees found from the cwd of every pane on the socket. Takes no
    /// paths from the client: on the web that would let anyone reaching the
    /// server probe the filesystem.
    ListGitWorktrees,
    /// The TCP ports each pane's programs listen on. Takes nothing from the
    /// client: the panes and their processes come from tmux.
    ListPanePorts,
    ListSnapshots,
    /// Rebuild a session from its latest snapshot. Refused when the session
    /// is already running.
    RestoreSession {
        session: String,
    },
    GetTraceSettings,
    /// The last `last` actions of the trace, redacted for sharing: what the
    /// Debug menu's Copy Trace previews and copies.
    GetTraceShare {
        last: u32,
    },
    SetTraceEnabled {
        enabled: bool,
    },
    SetTraceLevel {
        level: String,
    },
    RecordTrace {
        events: Vec<serde_json::Map<String, Value>>,
    },
    OpenTraceFile,
    /// Open a web link in the user's default browser, where a webview does
    /// not open one itself.
    OpenUrl {
        url: String,
    },
    ListServers,
    ConnectServer {
        id: String,
        #[serde(default)]
        session: Option<String>,
    },
    DetachClient,
    /// What a launch tells a tmux user about their own server
    /// (`servers::OwnTmuxOffer`), or `null` when there is nothing to tell.
    OwnTmuxOffer,
    /// The user closed that notice: this host does not show it again.
    CloseOwnTmuxOffer,
    /// Write the invocation token a plugin's menu action opens with,
    /// carrying the selected text.
    PreparePluginAction {
        plugin: String,
        action: String,
        #[serde(rename = "paneId")]
        pane_id: PaneId,
        #[serde(default)]
        selection: Option<String>,
    },
    /// A URL clicked in a pane that a plugin's link handler may take
    /// (`plugins::links`): answers the prepared action, or `null`.
    OpenLink {
        url: String,
        #[serde(rename = "paneId")]
        pane_id: PaneId,
    },
    /// Text clicked in a pane: the line and the column (in characters).
    OpenText {
        #[serde(rename = "paneId")]
        pane_id: PaneId,
        line: String,
        column: usize,
    },
    /// What a client is told when it connects (`connection-info`, and the
    /// bindings when they are known), as events. The web sends them as the
    /// stream's first frames; a desktop webview, which may start listening
    /// after the first events went out, asks.
    Greeting,
}

fn default_scrollback_start() -> i64 {
    -200
}

fn default_scrollback_end() -> i64 {
    -1
}

impl ClientCommand {
    pub fn decode(body: &[u8]) -> Result<Self, serde_json::Error> {
        Self::from_value(serde_json::from_slice(body)?)
    }

    /// The client always sends an `args` object, `{}` for a command that
    /// takes none; serde's adjacently-tagged form rejects a map where a unit
    /// variant is expected, so an empty `args` is dropped before a second try.
    pub fn from_value(mut value: Value) -> Result<Self, serde_json::Error> {
        match Self::deserialize(&value) {
            Ok(cmd) => Ok(cmd),
            Err(first_err) => {
                let stripped = value
                    .as_object_mut()
                    .and_then(|obj| match obj.get("args") {
                        Some(Value::Object(map)) if map.is_empty() => obj.remove("args"),
                        _ => None,
                    })
                    .is_some();
                if stripped {
                    Self::deserialize(&value)
                } else {
                    Err(first_err)
                }
            }
        }
    }
}
