//! The plugins in the keymap: the keys each asks for (`[[keys]]`), bound
//! where nothing else is, and the user's own plugin's actions and verbs.
//!
//! Read from the manifests, never from tmux: a plugin key is bound by the
//! running app, and which plugin gets a key is the same rule here as there —
//! a file of the chain always wins, then the plugin that asked first
//! (`tmuxy_core::plugins::keys`).

use std::path::PathBuf;

use tmuxy_core::paths::Layout;
#[cfg(feature = "native")]
use tmuxy_core::session::keymap::Binding;
use tmuxy_core::session::keymap::{Keymap, Source};

/// A key a plugin asked for that something else holds.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Skipped {
    pub plugin: String,
    pub action: String,
    pub table: String,
    pub key: String,
    #[serde(rename = "heldBy")]
    pub held_by: Source,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UserAction {
    pub id: String,
    pub title: String,
    /// The menu it is in, when it is in one.
    pub menu: Option<&'static str>,
    pub surface: &'static str,
    /// The keys that run it, as `<table> <key>`.
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UserVerb {
    pub verb: String,
    pub description: String,
}

/// The user's own plugin (`tmuxy-plugin.toml` in the config dir).
#[derive(Debug, Clone, serde::Serialize)]
pub struct UserPlugin {
    pub manifest: PathBuf,
    pub actions: Vec<UserAction>,
    pub verbs: Vec<UserVerb>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Plugins {
    pub user: Option<UserPlugin>,
    pub skipped: Vec<Skipped>,
    /// What would not load, one line each.
    pub broken: Vec<String>,
}

/// A build without plugins (the in-browser guests) has none to list.
#[cfg(not(feature = "native"))]
pub fn add(_map: &mut Keymap, _layout: &Layout) -> Plugins {
    Plugins::default()
}

/// Every installed plugin's keys into `map`, where nothing holds them, and
/// what the keymap says of the plugins.
#[cfg(feature = "native")]
pub fn add(map: &mut Keymap, layout: &Layout) -> Plugins {
    use tmuxy_core::plugins::registry::{Kind, Registry};
    let registry = match Registry::load(layout) {
        Ok(registry) => registry,
        Err(e) => {
            return Plugins {
                broken: vec![format!("the plugin list could not be read: {e}")],
                ..Plugins::default()
            }
        }
    };
    let mut out = Plugins {
        broken: registry
            .broken
            .iter()
            .map(|b| format!("{}: {}", b.name, b.reason))
            .collect(),
        ..Plugins::default()
    };
    out.skipped = add_keys(map, &registry);
    for plugin in registry.plugins.iter().filter(|p| p.manifest.runs_here()) {
        if plugin.kind == Kind::User {
            let manifest = plugin.root.join(tmuxy_core::plugins::MANIFEST_FILE);
            out.user = Some(user_plugin(&plugin.manifest, manifest));
        }
    }
    out
}

/// The plugin keys, planned by the app's own rule
/// (`tmuxy_core::plugins::keys::plan_with`) with what the keymap binds as
/// what holds a key: each bound one goes into `map` under its plugin, and
/// the ones something else holds are returned.
#[cfg(feature = "native")]
fn add_keys(map: &mut Keymap, registry: &tmuxy_core::plugins::registry::Registry) -> Vec<Skipped> {
    let held = |table: tmuxy_core::plugins::manifest::KeyTable, key: &str| {
        map.bindings
            .iter()
            .find(|binding| binding.table == table.as_str() && binding.key == key)
            .map(|binding| binding.source.to_string())
    };
    let planned = tmuxy_core::plugins::keys::plan_with(registry, held);
    let mut skipped = Vec::new();
    for key in planned {
        let table = key.table.as_str().to_string();
        let manifest = registry
            .get(&key.plugin)
            .map(|plugin| plugin.root.join(tmuxy_core::plugins::MANIFEST_FILE))
            .unwrap_or_default();
        if key.taken_by.is_none() {
            map.add_plugin_key(Binding {
                table,
                key: key.key,
                command: format!("plugin action {}:{}", key.plugin, key.action),
                repeat: false,
                source: Source::plugin(&key.plugin, &manifest),
            });
            continue;
        }
        // What holds it is in the keymap: a file's line, or a plugin that
        // asked first and was bound above.
        let held_by = map
            .bindings
            .iter()
            .find(|binding| binding.table == table && binding.key == key.key)
            .map(|binding| binding.source.clone())
            .unwrap_or_else(|| Source::plugin(&key.plugin, &manifest));
        skipped.push(Skipped {
            plugin: key.plugin,
            action: key.action,
            table,
            key: key.key,
            held_by,
        });
    }
    skipped
}

#[cfg(feature = "native")]
fn user_plugin(manifest: &tmuxy_core::plugins::manifest::Manifest, path: PathBuf) -> UserPlugin {
    UserPlugin {
        manifest: path,
        actions: manifest
            .actions_here()
            .map(|action| UserAction {
                id: action.id.clone(),
                title: action.title.clone(),
                menu: action.menu.map(|menu| menu.as_str()),
                surface: action.surface.as_str(),
                keys: manifest
                    .keys
                    .iter()
                    .filter(|key| key.action == action.id)
                    .map(|key| format!("{} {}", key.table.as_str(), key.key))
                    .collect(),
            })
            .collect(),
        verbs: manifest
            .cli_here()
            .map(|verb| UserVerb {
                verb: verb.verb.clone(),
                description: verb.description.clone(),
            })
            .collect(),
    }
}
