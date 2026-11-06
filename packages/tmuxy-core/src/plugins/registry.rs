//! The plugins this machine has: the lockfile's entries, each with its
//! manifest read from its checkout (or linked directory), plus the user's own
//! `<config_dir>/tmuxy-plugin.toml`.

use std::path::{Path, PathBuf};

use super::lockfile::{Entry, EntrySource, Lockfile};
use super::manifest::{Action, CliVerb, Manifest};
use super::{PluginError, Result, RESERVED_VERBS, USER_PLUGIN};
use crate::paths::Layout;

/// How a plugin got here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Fetched from a repository, pinned to a commit.
    Repo { slug: String, sha: String },
    /// A directory linked with `--path`; edits apply without reinstalling.
    Linked,
    /// The user's own `tmuxy-plugin.toml` in the config dir.
    User,
}

/// A plugin that loaded.
#[derive(Debug, Clone)]
pub struct Installed {
    pub name: String,
    /// The directory its commands resolve in, and their working directory.
    pub root: PathBuf,
    pub kind: Kind,
    pub manifest: Manifest,
}

/// A plugin listed but not usable: its checkout is missing, or its manifest
/// no longer parses. `tmuxy plugin list` shows it; nothing else offers it.
#[derive(Debug, Clone)]
pub struct Broken {
    pub name: String,
    pub source: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct Registry {
    pub plugins: Vec<Installed>,
    pub broken: Vec<Broken>,
}

/// A plugin verb that never runs, and what runs in its place.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Shadowed {
    pub verb: String,
    /// The plugin whose verb wins (it comes first: the user's own, then the
    /// lockfile's order), or `None` for a `tmuxy plugin` command a later
    /// tmuxy added.
    pub by: Option<String>,
}

/// Where an entry's plugin lives.
pub fn entry_root(dirs: &Layout, entry: &Entry) -> Result<(PathBuf, Kind)> {
    match entry.source()? {
        EntrySource::Repo { source, sha } => {
            let mut root = dirs.checkout(&entry.name, &sha);
            if let Some(subdir) = &source.subdir {
                root = root.join(subdir);
            }
            Ok((
                root,
                Kind::Repo {
                    slug: source.slug(),
                    sha,
                },
            ))
        }
        EntrySource::Path(path) => Ok((path, Kind::Linked)),
    }
}

fn load_one(name: &str, root: PathBuf, kind: Kind) -> std::result::Result<Installed, String> {
    if !root.is_dir() {
        return Err(match kind {
            Kind::Repo { .. } => {
                "not checked out on this machine; run `tmuxy plugin install`".to_string()
            }
            _ => format!("{} does not exist", root.display()),
        });
    }
    let manifest = Manifest::load(&root).map_err(|diags| {
        diags
            .first()
            .map(|d| d.render(super::MANIFEST_FILE))
            .unwrap_or_default()
    })?;
    if manifest.name != name {
        return Err(format!(
            "its manifest now names it {:?}; reinstall it",
            manifest.name
        ));
    }
    if let Some(min) = &manifest.min_tmuxy {
        if !super::satisfies_min_tmuxy(min) {
            return Err(format!(
                "it needs tmuxy {min}; this is {}",
                super::TMUXY_VERSION
            ));
        }
    }
    Ok(Installed {
        name: name.to_string(),
        root,
        kind,
        manifest,
    })
}

impl Registry {
    /// Every plugin: the user's first, then the lockfile's in its order.
    pub fn load(dirs: &Layout) -> Result<Registry> {
        let lock = Lockfile::load(dirs)?;
        let mut registry = Registry::default();
        if dirs.user_plugin_manifest().is_file() {
            match load_one(USER_PLUGIN, dirs.config.clone(), Kind::User) {
                Ok(p) => registry.plugins.push(p),
                Err(reason) => registry.broken.push(Broken {
                    name: USER_PLUGIN.into(),
                    source: dirs.user_plugin_manifest().display().to_string(),
                    reason,
                }),
            }
        }
        for entry in &lock.plugins {
            let loaded = entry_root(dirs, entry)
                .map_err(|e| e.to_string())
                .and_then(|(root, kind)| load_one(&entry.name, root, kind));
            match loaded {
                Ok(p) => registry.plugins.push(p),
                Err(reason) => registry.broken.push(Broken {
                    name: entry.name.clone(),
                    source: entry.describe_source(),
                    reason,
                }),
            }
        }
        Ok(registry)
    }

    pub fn get(&self, name: &str) -> Option<&Installed> {
        self.plugins.iter().find(|p| p.name == name)
    }

    /// The plugin of that name, or why there is none.
    pub fn require(&self, name: &str) -> Result<&Installed> {
        if let Some(p) = self.get(name) {
            return Ok(p);
        }
        if let Some(b) = self.broken.iter().find(|b| b.name == name) {
            return Err(PluginError::Invalid(format!(
                "plugin {name:?} is broken: {}",
                b.reason
            )));
        }
        Err(PluginError::NotFound(format!(
            "no plugin named {name:?} is installed"
        )))
    }

    /// The plugin and action `plugin:action` names, on this platform.
    pub fn action(&self, plugin: &str, action: &str) -> Result<(&Installed, &Action)> {
        let p = self.require(plugin)?;
        if !p.manifest.runs_here() {
            return Err(PluginError::Invalid(format!(
                "plugin {plugin:?} does not run on {}",
                super::current_platform().as_str()
            )));
        }
        let a = p
            .manifest
            .actions_here()
            .find(|a| a.id == action)
            .ok_or_else(|| {
                PluginError::NotFound(format!("plugin {plugin:?} has no action {action:?} here"))
            })?;
        Ok((p, a))
    }

    /// The verbs of `plugin` that never run: a `tmuxy plugin` command or an
    /// earlier plugin's verb of the same name wins at dispatch. Install
    /// refuses both; the user's own plugin and an edited linked one pass no
    /// install, so this is how `tmuxy plugin list` says so.
    pub fn shadowed(&self, plugin: &Installed) -> Vec<Shadowed> {
        plugin
            .manifest
            .cli_here()
            .filter_map(|c| {
                if RESERVED_VERBS.contains(&c.verb.as_str()) {
                    return Some(Shadowed {
                        verb: c.verb.clone(),
                        by: None,
                    });
                }
                match self.verb(&c.verb) {
                    Some((owner, _)) if owner.name != plugin.name => Some(Shadowed {
                        verb: c.verb.clone(),
                        by: Some(owner.name.clone()),
                    }),
                    _ => None,
                }
            })
            .collect()
    }

    /// The plugin a CLI verb belongs to. A `tmuxy plugin` subcommand of the
    /// same name wins at dispatch, so a shadowed verb names nothing.
    pub fn verb(&self, verb: &str) -> Option<(&Installed, &CliVerb)> {
        if RESERVED_VERBS.contains(&verb) {
            return None;
        }
        self.plugins
            .iter()
            .filter(|p| p.manifest.runs_here())
            .find_map(|p| {
                p.manifest
                    .cli_here()
                    .find(|c| c.verb == verb)
                    .map(|c| (p, c))
            })
    }
}

/// `command[0]` resolved inside `root`: canonicalised, still under the
/// canonical root, a regular file. Checked at install and again at every
/// launch, since a linked plugin can change under us.
pub fn resolve_command(root: &Path, command: &[String]) -> Result<PathBuf> {
    let program = command
        .first()
        .ok_or_else(|| PluginError::Invalid("the command is empty".into()))?;
    let root = root
        .canonicalize()
        .map_err(|e| PluginError::io(format!("resolving {}", root.display()), e))?;
    let path = root.join(program);
    let resolved = path.canonicalize().map_err(|e| {
        PluginError::Invalid(format!(
            "command {program:?} is missing from the plugin ({e})"
        ))
    })?;
    if !resolved.starts_with(&root) {
        return Err(PluginError::Invalid(format!(
            "command {program:?} resolves outside the plugin, to {}",
            resolved.display()
        )));
    }
    let meta = std::fs::metadata(&resolved)
        .map_err(|e| PluginError::io(format!("reading {}", resolved.display()), e))?;
    if !meta.is_file() {
        return Err(PluginError::Invalid(format!(
            "command {program:?} is not a file"
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(PluginError::Invalid(format!(
                "command {program:?} is not executable (chmod +x it)"
            )));
        }
    }
    Ok(resolved)
}

/// Whether `name` is a command on PATH (a manifest's `requires`).
pub fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(name);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&candidate)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        {
            candidate.is_file()
        }
    })
}
