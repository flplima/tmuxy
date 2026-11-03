//! The client commands plugins add: a menu action's selection
//! (`prepare_plugin_action`) and a clicked link (`open_link`, `open_text`).
//! Each writes the invocation token the client then names in
//! `TmuxOp.PluginAction`; the plugins and the token directory are this
//! machine's, so a server reached over SSH has neither.

use crate::CommandError;

/// Run a blocking plugin lookup off the async runtime, refusing over SSH.
async fn locally<T: Send + 'static>(
    work: impl FnOnce(&crate::plugins::Dirs) -> crate::plugins::Result<T> + Send + 'static,
) -> Result<T, CommandError> {
    if crate::session::ssh_target().is_some() {
        return Err(CommandError::unavailable(
            "plugins answer only where tmuxy runs on the tmux server's machine",
        ));
    }
    tokio::task::spawn_blocking(move || work(&crate::plugins::Dirs::current()))
        .await
        .map_err(|e| CommandError::unavailable(e.to_string()))?
        .map_err(|e| CommandError::invalid(e.to_string()))
}

/// The invocation token a plugin's menu action opens with, holding the
/// selected text, so the text reaches the plugin in a file and never on a
/// command line (`plugins::invoke`). Answers `{ token }`; the client then
/// names the token in `TmuxOp.PluginAction`. The plugins and the token
/// directory are this machine's, so a server reached over SSH has neither.
pub async fn prepare_plugin_action_json(
    plugin: String,
    action: String,
    pane_id: crate::PaneId,
    selection: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let pane = pane_id.to_string();
    let token = locally(move |dirs| {
        crate::plugins::invoke::prepare(dirs, &plugin, &action, &pane, selection)
    })
    .await?;
    Ok(serde_json::json!({ "token": token }))
}

/// A URL clicked in `pane_id`: the action of the first link handler that
/// takes it, prepared, or `null` for the browser.
pub async fn open_plugin_link_json(
    url: String,
    pane_id: crate::PaneId,
) -> Result<serde_json::Value, CommandError> {
    let pane = pane_id.to_string();
    let prepared = locally(move |dirs| {
        let registry = crate::plugins::registry::Registry::load(dirs)?;
        crate::plugins::links::prepare(
            dirs,
            crate::plugins::links::match_url(&registry, &url),
            &pane,
        )
    })
    .await?;
    Ok(serde_json::to_value(prepared).unwrap_or_default())
}

/// Text clicked in `pane_id` (the whole line and the column, in
/// characters): the action of the first text handler whose pattern covers
/// the column, prepared, or `null`.
pub async fn open_plugin_text_json(
    pane_id: crate::PaneId,
    line: String,
    column: usize,
) -> Result<serde_json::Value, CommandError> {
    let pane = pane_id.to_string();
    let prepared = locally(move |dirs| {
        let registry = crate::plugins::registry::Registry::load(dirs)?;
        crate::plugins::links::prepare(
            dirs,
            crate::plugins::links::match_text(&registry, &line, column),
            &pane,
        )
    })
    .await?;
    Ok(serde_json::to_value(prepared).unwrap_or_default())
}
