//! Every command a client sends, and the one handler both hosts run.
//!
//! The wire shape is `{ "cmd": "run_tmux_command", "args": { "command":
//! "splitw -h" } }` on both transports: the body of the web's
//! `POST /commands`, and the request the desktop's one `dispatch` IPC
//! command carries.
//!
//! What a host cannot do it answers `unavailable`, so the client can tell
//! "not here" from "it failed".

use serde_json::Value;

use super::host_ctx::{not_here, HostCtx};
use super::plugins;
use super::profiles::{self, ProfileCall};
use super::requests::{self, to_json};
use super::{HostEvent, SessionRuntime};
use crate::command_router::Route;
use crate::constants::{OPENABLE_URL_SCHEMES, URL_FORBIDDEN_CHARS};
use crate::session::ManagedOption;
use crate::CommandError;

mod wire;
pub use wire::ClientCommand;

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
        ClientCommand::ReadDiff { pane_id, scope } => {
            let tx = runtime.channel().await?;
            to_json(
                crate::diff_review::read_diff(&tx, &pane_id, scope).await?,
                "diff",
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
            let mut changes = vec![(ManagedOption::Theme.name(), name.as_str())];
            changes.extend(
                mode.as_deref()
                    .map(|m| (ManagedOption::ThemeMode.name(), m)),
            );
            if profiles::into_profile(runtime, &changes).await? {
                return Ok(Value::Null);
            }
            let tx = runtime.channel().await?;
            crate::theme::set_theme(&tx, &name, mode.as_deref()).await?;
            runtime.push_theme_settings().await;
            Ok(Value::Null)
        }
        ClientCommand::SetThemeMode { mode } => {
            let change = [(ManagedOption::ThemeMode.name(), mode.as_str())];
            if profiles::into_profile(runtime, &change).await? {
                return Ok(Value::Null);
            }
            let tx = runtime.channel().await?;
            crate::theme::set_theme_mode(&tx, &mode).await?;
            runtime.push_theme_settings().await;
            Ok(Value::Null)
        }
        ClientCommand::GetThemesList => to_json(crate::theme::get_themes_list(), "themes"),
        ClientCommand::ListProfiles => profiles::run(runtime, ProfileCall::List).await,
        ClientCommand::UseProfile { name } => profiles::run(runtime, ProfileCall::Use(name)).await,
        ClientCommand::CreateProfile { name, from } => {
            profiles::run(runtime, ProfileCall::Create { name, from }).await
        }
        ClientCommand::RenameProfile { from, to } => {
            profiles::run(runtime, ProfileCall::Rename { from, to }).await
        }
        ClientCommand::DeleteProfile { name } => {
            profiles::run(runtime, ProfileCall::Delete(name)).await
        }
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
        ClientCommand::OwnTmuxOffer => {
            let can_switch = ctx.switches_servers();
            let offer = crate::session::scoped::spawn_blocking(move || {
                crate::servers::own_tmux_offer(can_switch)
            })
            .await
            .map_err(|e| CommandError::unavailable(e.to_string()))?;
            to_json(offer, "own tmux offer")
        }
        ClientCommand::CloseOwnTmuxOffer => {
            let can_switch = ctx.switches_servers();
            tokio::task::spawn_blocking(move || crate::servers::close_own_tmux_offer(can_switch))
                .await
                .map_err(|e| CommandError::unavailable(e.to_string()))?
                .map_err(|e| CommandError::unavailable(e.to_string()))?;
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
    // Asking before a send guards access: a profile never holds it.
    let value = if enabled { "on" } else { "off" };
    if !matches!(option, ManagedOption::SendAsk)
        && profiles::into_profile(runtime, &[(option.name(), value)]).await?
    {
        return Ok(Value::Null);
    }
    let tx = runtime.channel().await?;
    crate::theme::set_flag(&tx, option, enabled).await?;
    Ok(Value::Null)
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
