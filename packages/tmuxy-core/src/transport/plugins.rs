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

/// What a config reload re-reads of the plugins: the inventory (the user's
/// own `tmuxy-plugin.toml` with it) and the plugin keys. Every command rides
/// the connection a `source-file` was just queued on, so it runs after it.
pub async fn reload_plugins(
    tx: &crate::control_mode::MonitorCommandSender,
) -> Result<(), CommandError> {
    if crate::session::ssh_target().is_some() {
        return Ok(());
    }
    for cmd in crate::plugins::inventory::commands(&crate::plugins::Dirs::current()) {
        super::run(tx, &cmd).await?;
    }
    apply_plugin_keys(tx).await
}

/// One word of a command line sent over control mode: a key name or a
/// command name as it is, anything else quoted.
fn tmux_word(word: &str) -> String {
    if !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        word.to_string()
    } else {
        crate::executor::tmux_quote(word)
    }
}

/// Bind the plugin keys (`plugins::keys`) over the control-mode connection:
/// the tables are read with `query`, which tmux answers after everything
/// queued before it (a `source-file` and what it binds), so a user binding
/// the config just made is seen and kept.
pub async fn apply_plugin_keys(
    tx: &crate::control_mode::MonitorCommandSender,
) -> Result<(), CommandError> {
    use crate::plugins::{keys, manifest::KeyTable, registry::Registry};
    if crate::session::ssh_target().is_some() {
        return Ok(());
    }
    let registry = Registry::load(&crate::plugins::Dirs::current()).unwrap_or_default();
    let mut listings = Vec::new();
    for table in [KeyTable::Prefix, KeyTable::Root] {
        let listing = match super::query(tx, &keys::list_command(table)).await {
            Ok(listing) => listing,
            // tmux refuses to list a table with no bindings: nothing in it.
            Err(e) if e.kind == crate::ErrorKind::Tmux => String::new(),
            // Unread is not empty: binding blind could take a user's key.
            Err(e) => return Err(e),
        };
        listings.push((table, listing));
    }
    let (planned, cmds) = keys::commands(&registry, |table| {
        listings
            .iter()
            .find(|(t, _)| *t == table)
            .map(|(_, l)| l.clone())
            .unwrap_or_default()
    });
    let lines: Vec<String> = cmds
        .iter()
        .map(|argv| {
            argv.iter()
                .map(|w| tmux_word(w))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    tracing::debug!(
        target: "tmuxy_core::plugins",
        kept = ?planned
            .iter()
            .filter_map(|p| p.taken_by.as_ref().map(|by| format!("{} {}: {by}", p.table.as_str(), p.key)))
            .collect::<Vec<_>>(),
        commands = ?lines.iter().map(|l| l.split(" run-shell").next().unwrap_or(l)).collect::<Vec<_>>(),
        "plugin keys"
    );
    for line in lines {
        super::run(tx, &line).await?;
    }
    Ok(())
}
