//! `update` and `remove`: moving installed plugins on, and taking them off.

use tmuxy_core::paths::Layout;
use tmuxy_core::plugins::lockfile::{Entry, EntrySource, Lockfile};
use tmuxy_core::plugins::registry::Registry;
use tmuxy_core::plugins::{fetch, gc, PluginError, USER_PLUGIN};

use super::gate::{self, Answer, Subject};
use super::graph;
use super::install::{
    admissible, commit_checkout, declined, load_manifest, stage, with_dependencies,
};
use super::{say, Failure, Outcome};

pub(super) fn update(dirs: &Layout, name: Option<String>, answer: &Answer, json: bool) -> Outcome {
    let lock = Lockfile::load(dirs)?;
    if let Some(name) = &name {
        if lock.get(name).is_none() {
            return Err(
                PluginError::NotFound(format!("no plugin named {name:?} is installed")).into(),
            );
        }
    }
    let mut updated = Vec::new();
    for entry in lock
        .plugins
        .iter()
        .filter(|e| name.as_ref().is_none_or(|n| *n == e.name))
    {
        let EntrySource::Repo {
            source,
            sha: old_sha,
        } = entry.source()?
        else {
            say(json, format!("{}: linked, so always current", entry.name));
            continue;
        };
        let new_sha = fetch::resolve_ref(&source.url(), source.git_ref.as_deref())?;
        if new_sha == old_sha {
            say(
                json,
                format!("{}: up to date at {}", entry.name, &old_sha[..12]),
            );
            continue;
        }
        let registry = Registry::load(dirs)?;
        let (staging, root) = stage(dirs, &source, &new_sha)?;
        let checked = load_manifest(&root).and_then(|m| {
            if m.name != entry.name {
                return Err(Failure {
                    code: 1,
                    message: format!(
                        "{} now names itself {:?}; remove and reinstall it",
                        source.slug(),
                        m.name
                    ),
                });
            }
            admissible(&registry, &m, &root, Some(&entry.name)).map(|()| m)
        });
        let manifest = match checked {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e);
            }
        };
        let deps = match with_dependencies(dirs, &registry, &manifest) {
            Ok(deps) => deps,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e);
            }
        };
        let previous = registry.get(&entry.name).map(|p| p.manifest.clone());
        let slug = source.slug();
        let mut subjects = vec![Subject {
            manifest: &manifest,
            source: &slug,
            sha: Some(&new_sha),
            previous: previous.as_ref().map(|m| (m, Some(old_sha.as_str()))),
        }];
        subjects.extend(deps.iter().map(graph::Staged::subject));
        let asked = gate::ask_all(&subjects, answer);
        if !matches!(asked, Ok(true)) {
            let _ = std::fs::remove_dir_all(&staging);
            graph::discard(&deps);
            return Err(asked.map_or_else(Failure::from, |_| declined()));
        }
        commit_checkout(dirs, &staging, &entry.name, &new_sha)?;
        let mut lock = Lockfile::load(dirs)?;
        graph::commit(dirs, deps, &mut lock)?;
        lock.upsert(Entry::from_repo(&entry.name, &source, &new_sha));
        lock.save(dirs)?;
        say(
            json,
            format!(
                "updated {} {} -> {}",
                entry.name,
                &old_sha[..12],
                &new_sha[..12]
            ),
        );
        updated.push(entry.name.clone());
    }
    tmuxy_core::plugins::refresh(dirs);
    report_gc(dirs, json);
    Ok(serde_json::json!({ "updated": updated }))
}

/// Remove a plugin. Refused while installed plugins depend on it, unless
/// `--force`, which removes them too, named first.
pub(super) fn remove(dirs: &Layout, name: &str, purge: bool, force: bool, json: bool) -> Outcome {
    if name == USER_PLUGIN {
        return Err(Failure {
            code: 1,
            message: "the user plugin is your own ~/.config/tmuxy/tmuxy-plugin.toml; delete that file instead".into(),
        });
    }
    let mut lock = Lockfile::load(dirs)?;
    if lock.get(name).is_none() {
        return Err(PluginError::NotFound(format!("no plugin named {name:?} is installed")).into());
    }
    let dependents = graph::dependents(&Registry::load(dirs)?, name);
    if !dependents.is_empty() && !force {
        return Err(Failure {
            code: 1,
            message: format!(
                "{} depend on {name:?}; remove them first, or pass --force to remove them too",
                dependents.join(", ")
            ),
        });
    }
    let mut removed = dependents;
    removed.push(name.to_string());
    for plugin in &removed {
        lock.remove(plugin);
    }
    lock.save(dirs)?;
    tmuxy_core::plugins::refresh(dirs);
    report_gc(dirs, json);
    for plugin in &removed {
        if purge {
            let _ = std::fs::remove_dir_all(dirs.plugin_config(plugin));
            let _ = std::fs::remove_dir_all(dirs.plugin_state(plugin));
        }
        say(json, format!("removed {plugin}"));
    }
    Ok(serde_json::json!({ "name": name, "removed": removed }))
}

fn report_gc(dirs: &Layout, json: bool) {
    for dir in gc::collect(dirs).busy {
        say(
            json,
            format!(
                "kept {}: something still runs from it; it goes once that exits",
                dir.display()
            ),
        );
    }
}
