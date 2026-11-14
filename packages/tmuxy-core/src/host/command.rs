//! Every command a client sends, and the one handler both hosts run.
//!
//! The wire shape is `{ "cmd": "run_tmux_command", "args": { "command":
//! "splitw -h" } }` on both transports: the body of the web's
//! `POST /commands`, and the request the desktop's one `dispatch` IPC
//! command carries.
//!
//! What a host cannot do it answers `unavailable`, so the client can tell
//! "not here" from "it failed".

use std::future::Future;

use serde::Deserialize;
use serde_json::Value;

use super::plugins;
use super::requests::{self, to_json};
use super::{ClientId, HostEvent, SessionRuntime};
use crate::command_router::Route;
use crate::constants::{OPENABLE_URL_SCHEMES, URL_FORBIDDEN_CHARS};
use crate::session::{ConnectTarget, ManagedOption};
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

fn not_here(what: &str) -> CommandError {
    CommandError::unavailable(format!("{what} is not available here"))
}

/// Whether a link a pane printed may be handed to the browser: one of
/// [`OPENABLE_URL_SCHEMES`], with no control, whitespace or
/// [`URL_FORBIDDEN_CHARS`] character.
pub fn is_openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    OPENABLE_URL_SCHEMES
        .iter()
        .any(|scheme| lower.starts_with(scheme))
        && !url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || URL_FORBIDDEN_CHARS.contains(&c))
}

pub async fn handle(cmd: ClientCommand, ctx: &impl HostCtx) -> Result<Value, CommandError> {
    let runtime = ctx.runtime();
    match cmd {
        ClientCommand::GetInitialState { cols, rows } => {
            // The monitor's own state, as its `Full` broadcast carries it: a
            // client that connects after that broadcast would otherwise start
            // from a baseline the deltas never correct.
            let tx = runtime.channel().await?;
            if let (Some(cols), Some(rows), Some(client)) = (cols, rows, ctx.client()) {
                runtime.set_client_size(client, cols, rows).await;
            }
            to_json(
                requests::initial_state_for_size(&tx, runtime.sent_size()).await?,
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
            requests::run_client_command(&tx, &command, &runtime.session(), runtime.size(), || {
                runtime.push_config()
            })
            .await?;
            tracing::trace!(
                command = %crate::trace::redact_command(&command),
                "client sent command via control mode"
            );
            Ok(Value::Null)
        }
        ClientCommand::QueryTmux { command } => {
            match crate::command_router::route_query(&command) {
                Route::Blocked(reason) => Err(CommandError::forbidden(reason)),
                Route::ControlMode(routed) => {
                    let tx = runtime.channel().await?;
                    Ok(Value::String(
                        crate::control_mode::query(&tx, &routed).await?,
                    ))
                }
            }
        }
        ClientCommand::GetScrollbackCells {
            pane_id,
            start,
            end,
        } => {
            let tx = runtime.channel().await?;
            to_json(
                requests::scrollback_cells(&tx, &pane_id, start, end).await?,
                "scrollback",
            )
        }
        ClientCommand::GetPromptMarks { pane_id } => {
            let tx = runtime.channel().await?;
            to_json(
                super::prompt_marks::prompt_marks(&tx, &pane_id).await?,
                "prompt marks",
            )
        }
        ClientCommand::GetLastCommandOutput { pane_id } => {
            let tx = runtime.channel().await?;
            to_json(
                super::prompt_marks::last_command_output(&tx, &pane_id).await?,
                "last output",
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
        // The theme is the session's: every client watching it is sent the
        // new settings at once; clients of other monitors learn it from the
        // pane-metadata subscription (`theme_rev`) about a second later.
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
        // Pushed now so every surface repaints and the blur follows without
        // waiting for a config reload.
        ClientCommand::SetTransparency { enabled } => {
            set_flag(runtime, ManagedOption::Transparency, enabled).await?;
            runtime.push_theme_settings().await;
            Ok(Value::Null)
        }
        ClientCommand::ListGitWorktrees => {
            let tx = runtime.channel().await?;
            to_json(requests::git_worktrees(&tx).await?, "worktrees")
        }
        ClientCommand::ListPanePorts => {
            let tx = runtime.channel().await?;
            to_json(requests::pane_ports(&tx).await?, "ports")
        }
        ClientCommand::ListSnapshots => to_json(requests::list_snapshots().await?, "snapshots"),
        ClientCommand::RestoreSession { session } => {
            let tx = runtime.channel().await?;
            requests::restore_named(&session, &tx).await?;
            Ok(Value::Null)
        }
        ClientCommand::GetTraceSettings => to_json(requests::trace_settings(), "trace settings"),
        ClientCommand::GetTraceShare { last } => to_json(
            requests::trace_share(last).map_err(crate::CommandError::unavailable)?,
            "trace share",
        ),
        // The state in force: `false` when the kill switch refuses, and the
        // client renders the answer, never its request.
        ClientCommand::SetTraceEnabled { enabled } => {
            Ok(Value::Bool(crate::trace::set_enabled(enabled)))
        }
        ClientCommand::SetTraceLevel { level } => {
            Ok(Value::String(requests::set_trace_level(&level).to_string()))
        }
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
                Some(tx) => crate::control_mode::query(&tx, crate::servers::LIST_SESSIONS)
                    .await
                    .ok()
                    .map(|out| crate::servers::parse_session_list(&out).len()),
                None => None,
            };
            let list = crate::session::scoped::spawn_blocking(move || crate::servers::list(live))
                .await
                .map_err(|e| CommandError::unavailable(e.to_string()))?;
            to_json(list, "servers")
        }
        ClientCommand::ConnectServer { id, session } => {
            if !ctx.switches_servers() {
                return Err(not_here("connecting to another server"));
            }
            let target = crate::session::scoped::spawn_blocking(move || {
                crate::servers::connect_target(&id, session)
            })
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
            plugins::prepare_plugin_action(plugin, action, pane_id, selection).await?,
            "plugin token",
        ),
        ClientCommand::OpenLink { url, pane_id } => {
            to_json(plugins::open_plugin_link(url, pane_id).await?, "link")
        }
        ClientCommand::OpenText {
            pane_id,
            line,
            column,
        } => to_json(
            plugins::open_plugin_text(pane_id, line, column).await?,
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
#[path = "command_tests.rs"]
mod tests;
