//! `install`, `update` and `remove`, and the checks every install path
//! shares: what refuses a plugin outright, before the gate asks.

use std::path::{Path, PathBuf};

use tmuxy_core::plugins::lockfile::{Entry, EntrySource, Lockfile};
use tmuxy_core::plugins::manifest::Manifest;
use tmuxy_core::plugins::registry::{self, Kind, Registry};
use tmuxy_core::plugins::source::{self, InstallSource, RepoSource};
use tmuxy_core::plugins::{
    fetch, gc, inventory, satisfies_min_tmuxy, Dirs, PluginError, RESERVED_VERBS, USER_PLUGIN,
};

use super::gate::{self, Answer, Subject};
use super::{say, Failure, Outcome};

/// Load a manifest from a fresh checkout or a linked directory, with every
/// problem it has rendered as `tmuxy plugin check` would.
fn load_manifest(root: &Path) -> Result<Manifest, Failure> {
    Manifest::load(root).map_err(|diags| Failure {
        code: 1,
        message: diags
            .iter()
            .map(|d| {
                d.render(
                    &root
                        .join(tmuxy_core::plugins::MANIFEST_FILE)
                        .display()
                        .to_string(),
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
    })
}

/// What refuses an install outright, before the gate: a platform or tmuxy it
/// does not run on, a name or verb taken, a command outside the plugin.
/// `replacing` is the plugin an update replaces, whose own name and verbs are
/// no collision.
pub(super) fn admissible(
    registry: &Registry,
    m: &Manifest,
    root: &Path,
    replacing: Option<&str>,
) -> Result<(), Failure> {
    let refuse = |message: String| Failure { code: 1, message };
    if m.name == USER_PLUGIN {
        return Err(refuse(format!(
            "{USER_PLUGIN:?} is your own plugin's name (~/.config/tmuxy/tmuxy-plugin.toml); a plugin cannot take it"
        )));
    }
    if !m.runs_here() {
        return Err(refuse(format!(
            "{} does not run on {}",
            m.name,
            tmuxy_core::plugins::current_platform().as_str()
        )));
    }
    if let Some(min) = &m.min_tmuxy {
        if !satisfies_min_tmuxy(min) {
            return Err(refuse(format!(
                "{} needs tmuxy {min} or later; this is {}",
                m.name,
                tmuxy_core::plugins::TMUXY_VERSION
            )));
        }
    }
    if replacing != Some(m.name.as_str())
        && (registry.get(&m.name).is_some() || registry.broken.iter().any(|b| b.name == m.name))
    {
        return Err(refuse(format!(
            "a plugin named {:?} is already installed; `tmuxy plugin update {}` moves it on, `remove` takes it off",
            m.name, m.name
        )));
    }
    for c in &m.cli {
        if RESERVED_VERBS.contains(&c.verb.as_str()) {
            return Err(refuse(format!("verb {:?} is tmuxy's own command", c.verb)));
        }
        let taken = registry
            .plugins
            .iter()
            .filter(|p| Some(p.name.as_str()) != replacing)
            .find(|p| p.manifest.cli.iter().any(|o| o.verb == c.verb));
        if let Some(other) = taken {
            return Err(refuse(format!(
                "verb {:?} is already plugin {:?}'s",
                c.verb, other.name
            )));
        }
    }
    let commands = m
        .actions
        .iter()
        .map(|a| &a.command)
        .chain(m.cli.iter().map(|c| &c.command));
    for command in commands {
        registry::resolve_command(root, command)?;
    }
    Ok(())
}

/// A fresh checkout of `source` at `sha` in a staging directory, and the
/// plugin root inside it.
fn stage(dirs: &Dirs, source: &RepoSource, sha: &str) -> Result<(PathBuf, PathBuf), Failure> {
    let staging = dirs.staging().join(format!(
        "{}-{}-{}",
        source.repo,
        &sha[..12],
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    fetch::fetch(&source.url(), sha, &staging)?;
    let root = match &source.subdir {
        Some(subdir) => staging.join(subdir),
        None => staging.clone(),
    };
    if !root.is_dir() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(Failure {
            code: 3,
            message: format!(
                "{} has no directory {}",
                source.slug(),
                source.subdir.as_deref().unwrap_or_default()
            ),
        });
    }
    if !root.join(tmuxy_core::plugins::MANIFEST_FILE).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(Failure {
            code: 1,
            message: format!(
                "{} has no {} at {}",
                source.slug(),
                tmuxy_core::plugins::MANIFEST_FILE,
                source.subdir.as_deref().unwrap_or("its root")
            ),
        });
    }
    Ok((staging, root))
}

/// Move a staged checkout to its permanent place.
fn commit_checkout(dirs: &Dirs, staging: &Path, name: &str, sha: &str) -> Result<(), Failure> {
    let dest = dirs.checkout(name, sha);
    if dest.exists() {
        // The same commit is already here (a reinstall): keep it.
        let _ = std::fs::remove_dir_all(staging);
        return Ok(());
    }
    std::fs::rename(staging, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(staging);
        Failure::from(PluginError::io(
            format!("moving the checkout to {}", dest.display()),
            e,
        ))
    })
}

fn declined() -> Failure {
    Failure {
        code: 1,
        message: "declined; nothing installed".into(),
    }
}

// ── install ─────────────────────────────────────────────────────────────

pub(super) fn install(
    dirs: &Dirs,
    spec: Option<String>,
    path: Option<PathBuf>,
    answer: &Answer,
    json: bool,
) -> Outcome {
    if let Some(path) = path {
        return install_path(dirs, &path, answer, json);
    }
    let Some(spec) = spec else {
        return install_lockfile(dirs, answer, json);
    };
    let source = match source::parse_install(&spec)? {
        InstallSource::Repo(source) => source,
        InstallSource::Name(name) => {
            return Err(Failure {
                code: 1,
                message: format!(
                    "installing by name ({name:?}) needs the plugin index, which this tmuxy does not have yet; use owner/repo"
                ),
            })
        }
        InstallSource::Path(path) => return install_path(dirs, &path, answer, json),
    };
    let registry = Registry::load(dirs)?;
    let sha = fetch::resolve_ref(&source.url(), source.git_ref.as_deref())?;
    let (staging, root) = stage(dirs, &source, &sha)?;
    let manifest = match load_manifest(&root)
        .and_then(|m| admissible(&registry, &m, &root, None).map(|()| m))
    {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let slug = source.slug();
    let subject = Subject {
        manifest: &manifest,
        source: &slug,
        sha: Some(&sha),
        previous: None,
    };
    match gate::ask(&subject, answer) {
        Ok(true) => {}
        Ok(false) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(declined());
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e.into());
        }
    }
    commit_checkout(dirs, &staging, &manifest.name, &sha)?;
    let mut lock = Lockfile::load(dirs)?;
    lock.upsert(Entry::from_repo(&manifest.name, &source, &sha));
    lock.save(dirs)?;
    inventory::publish(dirs);
    say(
        json,
        format!(
            "installed {} {} at {}",
            manifest.name,
            manifest.version,
            &sha[..12]
        ),
    );
    Ok(serde_json::json!({ "name": manifest.name, "sha": sha }))
}

fn install_path(dirs: &Dirs, path: &Path, answer: &Answer, json: bool) -> Outcome {
    let root = path.canonicalize().map_err(|e| Failure {
        code: 3,
        message: format!("{}: {e}", path.display()),
    })?;
    let registry = Registry::load(dirs)?;
    let manifest = load_manifest(&root)?;
    if let Some(existing) = registry.get(&manifest.name) {
        if existing.kind == Kind::Linked && existing.root == root {
            say(
                json,
                format!(
                    "{} is already linked from {}",
                    manifest.name,
                    root.display()
                ),
            );
            return Ok(serde_json::json!({ "name": manifest.name, "path": root }));
        }
    }
    admissible(&registry, &manifest, &root, None)?;
    let shown = root.display().to_string();
    let subject = Subject {
        manifest: &manifest,
        source: &shown,
        sha: None,
        previous: None,
    };
    if !gate::ask(&subject, answer)? {
        return Err(declined());
    }
    let mut lock = Lockfile::load(dirs)?;
    lock.upsert(Entry::from_path(&manifest.name, &root));
    lock.save(dirs)?;
    inventory::publish(dirs);
    say(
        json,
        format!("linked {} from {}", manifest.name, root.display()),
    );
    Ok(serde_json::json!({ "name": manifest.name, "path": root }))
}

/// Install what the lockfile lists, at its commits: a synced plugins.json
/// on a fresh machine.
fn install_lockfile(dirs: &Dirs, answer: &Answer, json: bool) -> Outcome {
    let lock = Lockfile::load(dirs)?;
    let mut installed = Vec::new();
    for entry in &lock.plugins {
        match entry.source()? {
            EntrySource::Path(path) => {
                if !path.is_dir() {
                    say(
                        json,
                        format!(
                            "{}: linked directory {} is missing",
                            entry.name,
                            path.display()
                        ),
                    );
                }
            }
            EntrySource::Repo { source, sha } => {
                if dirs.checkout(&entry.name, &sha).is_dir() {
                    continue;
                }
                let (staging, root) = stage(dirs, &source, &sha)?;
                let checked = load_manifest(&root).and_then(|m| {
                    if m.name != entry.name {
                        return Err(Failure {
                            code: 1,
                            message: format!(
                                "{} at {sha} names itself {:?}, not {:?}",
                                source.slug(),
                                m.name,
                                entry.name
                            ),
                        });
                    }
                    let others = Registry::load(dirs).unwrap_or_default();
                    admissible(&others, &m, &root, Some(&entry.name)).map(|()| m)
                });
                let manifest = match checked {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = std::fs::remove_dir_all(&staging);
                        return Err(e);
                    }
                };
                let slug = source.slug();
                let subject = Subject {
                    manifest: &manifest,
                    source: &slug,
                    sha: Some(&sha),
                    previous: None,
                };
                // The lockfile names the commit: `--yes` alone is its review.
                let pinned = Answer {
                    yes: answer.yes,
                    sha: Some(sha.clone()),
                };
                if !gate::ask(&subject, &pinned)? {
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(declined());
                }
                commit_checkout(dirs, &staging, &entry.name, &sha)?;
                say(json, format!("installed {} at {}", entry.name, &sha[..12]));
                installed.push(entry.name.clone());
            }
        }
    }
    inventory::publish(dirs);
    if installed.is_empty() {
        say(json, "every plugin in plugins.json is installed");
    }
    Ok(serde_json::json!({ "installed": installed }))
}

// ── update / remove ─────────────────────────────────────────────────────

pub(super) fn update(dirs: &Dirs, name: Option<String>, answer: &Answer, json: bool) -> Outcome {
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
        let previous = registry.get(&entry.name).map(|p| p.manifest.clone());
        let slug = source.slug();
        let subject = Subject {
            manifest: &manifest,
            source: &slug,
            sha: Some(&new_sha),
            previous: previous.as_ref().map(|m| (m, Some(old_sha.as_str()))),
        };
        if !gate::ask(&subject, answer)? {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(declined());
        }
        commit_checkout(dirs, &staging, &entry.name, &new_sha)?;
        let mut lock = Lockfile::load(dirs)?;
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
    inventory::publish(dirs);
    report_gc(dirs, json);
    Ok(serde_json::json!({ "updated": updated }))
}

pub(super) fn remove(dirs: &Dirs, name: &str, purge: bool, json: bool) -> Outcome {
    if name == USER_PLUGIN {
        return Err(Failure {
            code: 1,
            message: "the user plugin is your own ~/.config/tmuxy/tmuxy-plugin.toml; delete that file instead".into(),
        });
    }
    let mut lock = Lockfile::load(dirs)?;
    if lock.remove(name).is_none() {
        return Err(PluginError::NotFound(format!("no plugin named {name:?} is installed")).into());
    }
    lock.save(dirs)?;
    inventory::publish(dirs);
    report_gc(dirs, json);
    if purge {
        let _ = std::fs::remove_dir_all(dirs.plugin_config(name));
        let _ = std::fs::remove_dir_all(dirs.plugin_state(name));
    }
    say(json, format!("removed {name}"));
    Ok(serde_json::json!({ "name": name }))
}

fn report_gc(dirs: &Dirs, json: bool) {
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
