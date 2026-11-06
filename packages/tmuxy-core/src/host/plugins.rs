//! The client commands plugins add. Each writes the invocation token the
//! client then names in `TmuxOp.PluginAction`; the plugins and the token
//! directory are this machine's, so a server reached over SSH has neither.

use crate::plugins::links::Prepared;
use crate::CommandError;

async fn locally<T: Send + 'static>(
    work: impl FnOnce(&crate::paths::Layout) -> crate::plugins::Result<T> + Send + 'static,
) -> Result<T, CommandError> {
    if crate::session::ssh_target().is_some() {
        return Err(CommandError::unavailable(
            "plugins answer only where tmuxy runs on the tmux server's machine",
        ));
    }
    tokio::task::spawn_blocking(move || work(&crate::paths::Layout::current()))
        .await
        .map_err(|e| CommandError::unavailable(e.to_string()))?
        .map_err(|e| CommandError::invalid(e.to_string()))
}

/// The invocation token a plugin's menu action opens with, holding the
/// selected text, so the text reaches the plugin in a file and never on a
/// command line (`plugins::invoke`).
pub async fn prepare_plugin_action(
    plugin: String,
    action: String,
    pane_id: crate::PaneId,
    selection: Option<String>,
) -> Result<PluginToken, CommandError> {
    let pane = pane_id.to_string();
    let token = locally(move |dirs| {
        crate::plugins::invoke::prepare(dirs, &plugin, &action, &pane, selection)
    })
    .await?;
    Ok(PluginToken { token })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PluginToken {
    pub token: String,
}

/// A URL clicked in `pane_id`: the action of the first link handler that
/// takes it, prepared, or `null` for the browser.
pub async fn open_plugin_link(
    url: String,
    pane_id: crate::PaneId,
) -> Result<Option<Prepared>, CommandError> {
    let pane = pane_id.to_string();
    locally(move |dirs| {
        let registry = crate::plugins::registry::Registry::load(dirs)?;
        crate::plugins::links::prepare(
            dirs,
            crate::plugins::links::match_url(&registry, &url),
            &pane,
        )
    })
    .await
}

/// Text clicked in `pane_id` (the whole line and the column, in
/// characters): the action of the first text handler whose pattern covers
/// the column, prepared, or `null`.
pub async fn open_plugin_text(
    pane_id: crate::PaneId,
    line: String,
    column: usize,
) -> Result<Option<Prepared>, CommandError> {
    let pane = pane_id.to_string();
    locally(move |dirs| {
        let registry = crate::plugins::registry::Registry::load(dirs)?;
        crate::plugins::links::prepare(
            dirs,
            crate::plugins::links::match_text(&registry, &line, column),
            &pane,
        )
    })
    .await
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
    let commands = crate::plugins::inventory::commands(&crate::paths::Layout::current())
        .map_err(|e| CommandError::invalid(e.to_string()))?;
    for cmd in commands {
        crate::control_mode::run(tx, &cmd).await?;
    }
    apply_plugin_keys(tx).await
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
    // A lockfile that does not load binds nothing and unbinds nothing: an
    // empty registry would take every plugin key away.
    let registry = Registry::load(&crate::paths::Layout::current())
        .map_err(|e| CommandError::invalid(e.to_string()))?;
    let mut listings = Vec::new();
    for table in [KeyTable::Prefix, KeyTable::Root] {
        let listing =
            crate::list_keys::listing(crate::control_mode::query(tx, &keys::list_command(table)).await)?;
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
        .map(|argv| crate::argv::control_line(argv))
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
        crate::control_mode::run(tx, &line).await?;
    }
    Ok(())
}
