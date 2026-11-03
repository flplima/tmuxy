//! `[[keys]]`: tmux key bindings that run a plugin's action on the pane the
//! key was pressed in.
//!
//! A plugin key is `bind-key -T <table> <key> run-shell -b "… tmuxy plugin
//! action <plugin>:<id> --pane #{pane_id} --trigger key …"`, and that
//! `--trigger key` is how a binding is known for a plugin's. **The user
//! always wins:** a key already bound to anything else is skipped, never
//! replaced, and `tmuxy plugin list` says so. Bindings are put back when a
//! server attaches and after `tmuxy config reload` (a config sourced again
//! may reset the tables), and taken away when their plugin goes.

use std::collections::BTreeMap;

use super::manifest::KeyTable;
use super::registry::Registry;
use super::{job, Dirs, Result};

/// What marks a binding as a plugin's.
pub const MARKER: &str = "--trigger key";

/// The command a plugin key runs: the CLI the config chain publishes, the
/// pane the key was pressed in, output dropped (a `run-shell -b` that
/// prints opens a view mode).
pub fn binding_command(plugin: &str, action: &str) -> String {
    format!(
        "\"$TMUXY_DATA_DIR/bin/tmuxy-cli\" plugin action {plugin}:{action} --pane #{{pane_id}} {MARKER} >/dev/null 2>&1"
    )
}

/// One declared key and what became of it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Planned {
    pub plugin: String,
    pub action: String,
    pub table: KeyTable,
    pub key: String,
    /// `None`: bound to the action. `Some`: skipped, with what holds the key.
    pub taken_by: Option<String>,
}

fn list_keys(table: KeyTable, key: Option<&str>) -> String {
    let mut argv = vec!["list-keys".to_string(), "-T".into(), table.as_str().into()];
    argv.extend(key.map(str::to_string));
    crate::session::tmux_output(&argv).unwrap_or_default()
}

/// `(table, key)` of every plugin binding in `listing` (`list-keys -T t`).
pub fn ours_in(listing: &str) -> Vec<(String, String)> {
    listing
        .lines()
        .filter(|l| l.contains(MARKER) && l.contains(" plugin action "))
        .filter_map(|l| {
            let words: Vec<&str> = l.split_whitespace().collect();
            let at = words.iter().position(|w| *w == "-T")?;
            Some((
                words.get(at + 1)?.to_string(),
                words.get(at + 2)?.to_string(),
            ))
        })
        .collect()
}

/// What a user binding on `key` is, when there is one that is not a
/// plugin's: the key a plugin may not take.
pub fn user_binding(table: KeyTable, key: &str) -> Option<String> {
    let current = list_keys(table, Some(key));
    let line = current
        .lines()
        .find(|l| !l.trim().is_empty() && !l.contains(MARKER))?;
    Some(line.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// The keys every plugin asks for, and which of them can be bound: the first
/// plugin to ask (install order) gets a key, a user binding keeps it.
pub fn plan(registry: &Registry) -> Vec<Planned> {
    let mut wanted: BTreeMap<(KeyTable, String), String> = BTreeMap::new();
    let mut out = Vec::new();
    for plugin in registry.plugins.iter().filter(|p| p.manifest.runs_here()) {
        for key in &plugin.manifest.keys {
            if !plugin.manifest.actions_here().any(|a| a.id == key.action) {
                continue;
            }
            let slot = (key.table, key.key.clone());
            let taken_by = match wanted.get(&slot) {
                Some(owner) => Some(format!("plugin {owner}")),
                None => {
                    let user = user_binding(key.table, &key.key);
                    if user.is_none() {
                        wanted.insert(slot, plugin.name.clone());
                    }
                    user
                }
            };
            out.push(Planned {
                plugin: plugin.name.clone(),
                action: key.action.clone(),
                table: key.table,
                key: key.key.clone(),
                taken_by,
            });
        }
    }
    out
}

/// Bind every plugin key that can be bound and unbind every plugin binding
/// no plugin asks for any more, in one `run-shell`. Returns the plan.
pub fn apply(dirs: &Dirs) -> Result<Vec<Planned>> {
    let registry = Registry::load(dirs)?;
    let planned = plan(&registry);
    let mut argv: Vec<String> = Vec::new();
    let mut push = |cmd: Vec<String>| {
        if !argv.is_empty() {
            argv.push(";".into());
        }
        argv.extend(cmd);
    };
    for table in [KeyTable::Prefix, KeyTable::Root] {
        for (_, key) in ours_in(&list_keys(table, None)) {
            push(vec![
                "unbind-key".into(),
                "-T".into(),
                table.as_str().into(),
                key,
            ]);
        }
    }
    for p in planned.iter().filter(|p| p.taken_by.is_none()) {
        push(vec![
            "bind-key".into(),
            "-T".into(),
            p.table.as_str().into(),
            p.key.clone(),
            "run-shell".into(),
            "-b".into(),
            binding_command(&p.plugin, &p.action),
        ]);
    }
    if !argv.is_empty() {
        job::run(dirs, &argv)?;
    }
    Ok(planned)
}
