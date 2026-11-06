//! Every command a client sends, and the one handler both hosts run.
//!
//! The wire shape is `{ "cmd": "run_tmux_command", "args": { "command":
//! "splitw -h" } }` on both transports: the body of the web's
//! `POST /commands`, and the request the desktop's one `dispatch` IPC
//! command carries. It is decoded once at the door, so a misspelt field or a
//! changed signature is an `invalid` failure rather than a silent `None`
//! deep in a handler. A field the client sends in camelCase (`paneId`) is
//! renamed explicitly.
//!
//! What only a host knows — which client is asking, how to switch servers,
//! how to open a link on this machine — is [`HostCtx`]. What a host cannot
//! do it answers `unavailable`, so the client can tell "not here" from "it
//! failed".

use std::future::Future;

use serde::Deserialize;
use serde_json::Value;

use super::{ClientId, HostEvent, SessionRuntime};
use crate::command_router::Route;
use crate::session::{ConnectTarget, ManagedOption};
use crate::transport::{self, to_json};
use crate::{CommandError, PaneId};

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
    /// Run a tmux command and return what it printed. The one way a client
    /// reads from tmux; rides the monitor's control-mode connection like every
    /// mutation (`RunCommandWithReply`), so nothing a client sends ever
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
    /// View menu: whether the cursor blinks (`@tmuxy-cursor-blink`).
    SetCursorBlink {
        enabled: bool,
    },
    /// View menu: whether a send into another pane asks first (`@tmuxy-send-ask`).
    SetSendAsk {
        enabled: bool,
    },
    /// View menu: whether the window is see-through (`@tmuxy-transparency`).
    SetTransparency {
        enabled: bool,
    },
    /// Git worktree context for the sidebar tree, discovered from the cwd of
    /// every pane on the socket. Takes no paths from the client: on the web
    /// that would let anyone reaching the server probe the filesystem.
    ListGitWorktrees,
    /// The sessions that have a snapshot to restore from (`session_snapshot`).
    ListSnapshots,
    /// Rebuild a session from its latest snapshot, through this session's
    /// control-mode client. Refused when the session is already running.
    RestoreSession {
        session: String,
    },
    /// Debug menu: the trace switch, level and path (docs/TRACING.md).
    GetTraceSettings,
    SetTraceEnabled {
        enabled: bool,
    },
    SetTraceLevel {
        level: String,
    },
    /// A batch of the client tracer's events, for the shared trace file.
    RecordTrace {
        events: Vec<serde_json::Map<String, Value>>,
    },
    /// Open the trace file in the OS default handler, where the file is.
    OpenTraceFile,
    /// Open a web link in the user's default browser, where a webview does
    /// not open one itself.
    OpenUrl {
        url: String,
    },
    /// The server picker.
    ListServers,
    ConnectServer {
        id: String,
        #[serde(default)]
        session: Option<String>,
    },
    DetachClient,
    /// Write the invocation token a plugin's menu action opens with,
    /// carrying the selected text (`plugins::invoke::prepare`).
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
    /// Decode a request body.
    pub fn decode(body: &[u8]) -> Result<Self, serde_json::Error> {
        Self::from_value(serde_json::from_slice(body)?)
    }

    /// Decode a request. The client always sends an `args` object, `{}` for
    /// a command that takes none; serde's adjacently-tagged form rejects a
    /// map where a unit variant is expected, so an empty `args` is dropped
    /// before a second try.
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

/// What a command needs of the host that received it.
pub trait HostCtx: Sync {
    /// The session the command is for.
    fn runtime(&self) -> &SessionRuntime;

    /// The client asking, when the host can vouch for it — the web only for
    /// a connection id whose stream is open, since a size kept for an id no
    /// stream owns would pin the session's size for every real client.
    fn client(&self) -> Option<ClientId>;

    /// Whether this host can point itself at another tmux server. The web
    /// server serves the socket it was started on.
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

    /// Hand a file to the system's default opener.
    fn open_path(&self, _path: &std::path::Path) -> Result<(), CommandError> {
        Err(not_here("opening a file"))
    }
}

/// What a host answers for something it does not do.
fn not_here(what: &str) -> CommandError {
    CommandError::unavailable(format!("{what} is not available here"))
}

/// Whether a link a pane printed may be handed to the browser: a web or mail
/// link, with none of the characters a URL must percent-encode (whitespace,
/// quotes, `<>^`{}|\`), so an opener that reads it as text finds nothing to
/// parse in it.
pub fn is_openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\'' | '<' | '>' | '^' | '`' | '{' | '}' | '|' | '\\'
                )
        })
}

/// Run a client's command for the session `ctx` serves; the answer is what
/// the client decodes.
pub async fn handle(cmd: ClientCommand, ctx: &impl HostCtx) -> Result<Value, CommandError> {
    let runtime = ctx.runtime();
    match cmd {
        ClientCommand::GetInitialState { cols, rows } => {
            // The monitor's own picture of the session — the same state its
            // `Full` broadcast carries, at the size just asked for. A client
            // that connects after that broadcast would otherwise start from a
            // baseline the deltas never correct.
            let tx = runtime.channel().await?;
            if let (Some(cols), Some(rows), Some(client)) = (cols, rows, ctx.client()) {
                runtime.set_client_size(client, cols, rows).await;
            }
            to_json(
                transport::initial_state_for_size(&tx, runtime.sent_size()).await?,
                "state",
            )
        }
        ClientCommand::SetClientSize { cols, rows } => {
            match ctx.client() {
                Some(client) => runtime.set_client_size(client, cols, rows).await,
                None => tracing::warn!(
                    cols,
                    rows,
                    "ignoring a size from a client the host cannot name"
                ),
            }
            Ok(Value::Null)
        }
        ClientCommand::RunTmuxCommand { command } => {
            if let Some(client) = ctx.client() {
                runtime.note_activity(client).await;
            }
            let tx = runtime.channel().await?;
            transport::run_client_command(
                &tx,
                &command,
                &runtime.session(),
                runtime.size(),
                || runtime.push_config(),
            )
            .await?;
            tracing::trace!(
                command = %crate::trace::redact_command(&command),
                "client sent command via control mode"
            );
            Ok(Value::Null)
        }
        ClientCommand::QueryTmux { command } => match transport::route_query(&command) {
            Route::Blocked(reason) => Err(CommandError::forbidden(reason)),
            Route::ControlMode(routed) => {
                let tx = runtime.channel().await?;
                Ok(Value::String(transport::query(&tx, &routed).await?))
            }
        },
        ClientCommand::GetScrollbackCells {
            pane_id,
            start,
            end,
        } => {
            let tx = runtime.channel().await?;
            to_json(
                transport::scrollback_cells(&tx, &pane_id, start, end).await?,
                "scrollback",
            )
        }
        ClientCommand::ReadPreview { pane_id, path } => {
            let tx = runtime.channel().await?;
            to_json(
                crate::preview::read_preview(&tx, &pane_id, path).await?,
                "preview",
            )
        }
        ClientCommand::StagePreview { pane_id, html } => {
            let tx = runtime.channel().await?;
            crate::preview::stage_page(&tx, runtime.preview_pages(), pane_id, html).await?;
            Ok(Value::Null)
        }
        ClientCommand::GetThemeSettings => to_json(runtime.theme_settings().await?, "theme"),
        // The theme is the session's, not the client's: every client
        // watching it is sent the new settings at once. Clients of other
        // monitors learn it from the pane-metadata subscription (`ThemeRev`)
        // about a second later.
        ClientCommand::SetTheme { name, mode } => {
            let tx = runtime.channel().await?;
            crate::theme::set_theme(&tx, &name, mode.as_deref()).await?;
            runtime.push_theme_settings().await;
            Ok(Value::Null)
        }
        ClientCommand::SetThemeMode { mode } => {
            let tx = runtime.channel().await?;
            crate::theme::set_theme_mode(&tx, &mode).await?;
            runtime.push_theme_settings().await;
            Ok(Value::Null)
        }
        ClientCommand::GetThemesList => to_json(crate::theme::get_themes_list(), "themes"),
        ClientCommand::SetCursorBlink { enabled } => {
            set_flag(runtime, ManagedOption::CursorBlink, enabled).await
        }
        ClientCommand::SetSendAsk { enabled } => {
            set_flag(runtime, ManagedOption::SendAsk, enabled).await
        }
        // Every surface repaints and the blur follows at once, without
        // waiting for a config reload.
        ClientCommand::SetTransparency { enabled } => {
            set_flag(runtime, ManagedOption::Transparency, enabled).await?;
            runtime.push_theme_settings().await;
            Ok(Value::Null)
        }
        ClientCommand::ListGitWorktrees => {
            let tx = runtime.channel().await?;
            to_json(transport::git_worktrees(&tx).await?, "worktrees")
        }
        ClientCommand::ListSnapshots => to_json(transport::list_snapshots().await?, "snapshots"),
        // Through THIS session's client: a new session made from inside a
        // control-mode client is how both hosts already create one.
        ClientCommand::RestoreSession { session } => {
            let tx = runtime.channel().await?;
            transport::restore_named(&session, &tx).await?;
            Ok(Value::Null)
        }
        ClientCommand::GetTraceSettings => to_json(transport::trace_settings(), "trace settings"),
        // The state actually in force: `false` for a request the kill
        // switch refuses — the client renders the answer, never its request.
        ClientCommand::SetTraceEnabled { enabled } => {
            Ok(Value::Bool(crate::trace::set_enabled(enabled)))
        }
        ClientCommand::SetTraceLevel { level } => Ok(Value::String(
            transport::set_trace_level(&level).to_string(),
        )),
        ClientCommand::RecordTrace { events } => {
            crate::trace::record_client_batch(events);
            Ok(Value::Null)
        }
        ClientCommand::OpenTraceFile => {
            let path = crate::trace::trace_path();
            if !path.exists() {
                return Err(CommandError::unavailable(format!(
                    "{} does not exist yet",
                    path.display()
                )));
            }
            ctx.open_path(&path)?;
            Ok(Value::Null)
        }
        // A pane can print any text, so `file:` and custom schemes stay out.
        ClientCommand::OpenUrl { url } => {
            let url = url.trim();
            if !is_openable_url(url) {
                return Err(CommandError::forbidden(format!(
                    "refusing to open {url:?}: only http(s) and mailto links"
                )));
            }
            ctx.open_url(url)?;
            Ok(Value::Null)
        }
        ClientCommand::ListServers => {
            if !ctx.switches_servers() {
                return Err(not_here("the server picker"));
            }
            let live = match runtime.tx_now() {
                Some(tx) => transport::query(&tx, crate::servers::LIST_SESSIONS)
                    .await
                    .ok()
                    .map(|out| crate::servers::parse_session_list(&out).len()),
                None => None,
            };
            let list = tokio::task::spawn_blocking(move || crate::servers::list(live))
                .await
                .map_err(|e| CommandError::unavailable(e.to_string()))?;
            to_json(list, "servers")
        }
        ClientCommand::ConnectServer { id, session } => {
            if !ctx.switches_servers() {
                return Err(not_here("connecting to another server"));
            }
            let target =
                tokio::task::spawn_blocking(move || crate::servers::connect_target(&id, session))
                    .await
                    .map_err(|e| CommandError::unavailable(e.to_string()))??;
            ctx.connect(target).await?;
            Ok(Value::Null)
        }
        ClientCommand::DetachClient => {
            ctx.detach().await?;
            Ok(Value::Null)
        }
        ClientCommand::PreparePluginAction {
            plugin,
            action,
            pane_id,
            selection,
        } => to_json(
            transport::prepare_plugin_action(plugin, action, pane_id, selection).await?,
            "plugin token",
        ),
        ClientCommand::OpenLink { url, pane_id } => {
            to_json(transport::open_plugin_link(url, pane_id).await?, "link")
        }
        ClientCommand::OpenText {
            pane_id,
            line,
            column,
        } => to_json(
            transport::open_plugin_text(pane_id, line, column).await?,
            "text link",
        ),
        ClientCommand::Greeting => {
            let events: Vec<HostEvent> = runtime.greeting(ctx.client().unwrap_or_default());
            to_json(events, "greeting")
        }
    }
}

async fn set_flag(
    runtime: &SessionRuntime,
    option: ManagedOption,
    enabled: bool,
) -> Result<Value, CommandError> {
    let tx = runtime.channel().await?;
    crate::theme::set_flag(&tx, option, enabled).await?;
    Ok(Value::Null)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "command_tests.rs"]
mod tests;
