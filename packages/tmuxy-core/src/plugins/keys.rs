//! `[[keys]]`: tmux key bindings that run a plugin's action on the pane the
//! key was pressed in.
//!
//! A plugin key is `bind-key -T <table> <key> run-shell -b "… tmuxy plugin
//! action <plugin>:<id> --pane #{pane_id} --trigger key …"`, and that
//! `--trigger key` is how a binding is known for a plugin's. **The user
//! always wins:** a key already bound to anything else is skipped, never
//! replaced, and `tmuxy plugin list` says so. Bindings are put back when a
//! server attaches and after every config reload (a config sourced again
//! may reset the tables), and taken away when their plugin goes. The server
//! reads and binds over its control-mode connection, so the reads come after
//! a `source-file` it queued; a CLI verb, which has none, inside one
//! `run-shell` (`job`).

use std::collections::BTreeMap;

use super::manifest::KeyTable;
use super::registry::Registry;
use super::{job, Result};
use crate::paths::Layout;

/// What marks a binding as a plugin's.
pub const MARKER: &str = "--trigger key";

/// The command a plugin key runs: the CLI the config chain publishes, the
/// pane the key was pressed in, output dropped (a `run-shell -b` that
/// prints opens a view mode).
///
/// The client does not press a key into tmux: it reads the bindings back
/// from `list-keys` and runs each command as tmux printed it. So the command
/// holds no `$`, quote or backslash, the characters tmux escapes when it
/// prints. tmux before 3.5 escaped a `$` there in a form that parsed back to
/// another command, and the key ran nothing. The CLI is named by the option
/// the chain sets (`session::CLI_OPTION`), which `run-shell` expands and
/// shell-quotes (`#{q:…}`) when the key is pressed.
pub fn binding_command(plugin: &str, action: &str) -> String {
    let cli = crate::session::CLI_OPTION;
    format!(
        "#{{q:{cli}}} plugin action {plugin}:{action} --pane #{{pane_id}} {MARKER} >/dev/null 2>&1"
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

/// `list-keys -T <table>`, the whole table, as an external read for a CLI
/// verb (no control-mode connection of its own). The server reads the same
/// over its connection (`transport::apply_plugin_keys`). Always the whole
/// table: before 3.8, `list-keys -T <table> <key>` answers nothing at all.
fn list_keys(table: KeyTable) -> String {
    let argv = ["list-keys".to_string(), "-T".into(), table.as_str().into()];
    crate::session::tmux_output(&argv).unwrap_or_default()
}

/// The `list-keys` that lists one whole table.
pub fn list_command(table: KeyTable) -> String {
    format!("list-keys -T {}", table.as_str())
}

/// `(table, key, line)` of every binding in `listing` (`list-keys -T t`).
fn bindings_in(listing: &str) -> impl Iterator<Item = (&str, &str, &str)> {
    listing.lines().filter_map(|l| {
        let words: Vec<&str> = l.split_whitespace().collect();
        let at = words.iter().position(|w| *w == "-T")?;
        Some((*words.get(at + 1)?, *words.get(at + 2)?, l))
    })
}

fn is_ours(line: &str) -> bool {
    line.contains(MARKER) && line.contains(" plugin action ")
}

/// `(table, key)` of every plugin binding in `listing` (`list-keys -T t`).
pub fn ours_in(listing: &str) -> Vec<(String, String)> {
    bindings_in(listing)
        .filter(|(_, _, line)| is_ours(line))
        .map(|(table, key, _)| (table.to_string(), key.to_string()))
        .collect()
}

/// The binding of `key` in `listing` that is not a plugin's, as one line.
/// Declared keys are normalized (`manifest::normalize_key`) to names tmux
/// prints unquoted, so a word compare finds them.
fn user_binding_in(listing: &str, key: &str) -> Option<String> {
    bindings_in(listing)
        .find(|(_, k, line)| *k == key && !line.contains(MARKER))
        .map(|(_, _, line)| line.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// What a user binding on `key` is, when there is one that is not a
/// plugin's: the key a plugin may not take.
pub fn user_binding(table: KeyTable, key: &str) -> Option<String> {
    user_binding_in(&list_keys(table), key)
}

/// The keys every plugin asks for, and which of them can be bound: the first
/// plugin to ask (install order) gets a key, a user binding keeps it.
/// `taken` is what holds a key now, from a user binding.
fn plan_with(
    registry: &Registry,
    taken: impl Fn(KeyTable, &str) -> Option<String>,
) -> Vec<Planned> {
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
                    let user = taken(key.table, &key.key);
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

/// [`plan_with`] against the tmux server as it is now (`tmuxy plugin list`).
pub fn plan(registry: &Registry) -> Vec<Planned> {
    plan_with(registry, user_binding)
}

/// The plan, and the commands that carry it out — unbind every plugin
/// binding, then bind every key that can be bound — as argv, from each
/// table's whole listing (`listing(table)`, a [`list_command`]'s output).
pub fn commands(
    registry: &Registry,
    listing: impl Fn(KeyTable) -> String,
) -> (Vec<Planned>, Vec<Vec<String>>) {
    let tables = [KeyTable::Prefix, KeyTable::Root].map(|t| (t, listing(t)));
    let of = |table: KeyTable| {
        tables
            .iter()
            .find(|(t, _)| *t == table)
            .map(|(_, l)| l.as_str())
            .unwrap_or_default()
    };
    let planned = plan_with(registry, |table, key| user_binding_in(of(table), key));
    let mut out = Vec::new();
    for (table, listing) in &tables {
        for (_, key) in ours_in(listing) {
            out.push(vec![
                "unbind-key".into(),
                "-T".into(),
                table.as_str().into(),
                key,
            ]);
        }
    }
    for p in planned.iter().filter(|p| p.taken_by.is_none()) {
        out.push(vec![
            "bind-key".into(),
            "-T".into(),
            p.table.as_str().into(),
            p.key.clone(),
            "run-shell".into(),
            "-b".into(),
            binding_command(&p.plugin, &p.action),
        ]);
    }
    (planned, out)
}

/// [`commands`] from a CLI verb: read and run inside one `run-shell`.
/// Returns the plan.
pub fn apply(dirs: &Layout) -> Result<Vec<Planned>> {
    let registry = Registry::load(dirs)?;
    let (planned, cmds) = commands(&registry, list_keys);
    let argv: Vec<String> = cmds.join(&[";".to_string()][..]);
    if !argv.is_empty() {
        job::run(dirs, &argv)?;
    }
    Ok(planned)
}
