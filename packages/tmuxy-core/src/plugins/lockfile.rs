//! `<config_dir>/plugins.json`: what is installed and at which commit.
//!
//! JSON rather than TOML because nobody writes it by hand: `tmuxy plugin
//! install` does, sorted by name and pretty-printed so a dotfiles repo diffs
//! cleanly. `tmuxy plugin install` with no argument installs exactly what it
//! lists, so the file synced to a fresh machine reproduces the same plugins at
//! the same commits.

use serde::{Deserialize, Serialize};

use super::source::RepoSource;
use super::{is_sha, is_valid_name, PluginError, Result};
use crate::paths::Layout;

pub const LOCKFILE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lockfile {
    pub version: u32,
    #[serde(default)]
    pub plugins: Vec<Entry>,
}

impl Default for Lockfile {
    fn default() -> Self {
        Self {
            version: LOCKFILE_VERSION,
            plugins: Vec::new(),
        }
    }
}

/// One installed plugin: a repo pinned to a commit, or a linked directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    /// `owner/repo[/subdir]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The ref `update` follows: a branch or tag, or none for the default branch.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    /// A directory linked with `--path`: used in place, never copied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntrySource {
    Repo { source: RepoSource, sha: String },
    Path(std::path::PathBuf),
}

impl Entry {
    pub fn from_repo(name: &str, source: &RepoSource, sha: &str) -> Self {
        Self {
            name: name.to_string(),
            repo: Some(source.slug()),
            git_ref: source.git_ref.clone().filter(|r| !is_sha(r)),
            sha: Some(sha.to_string()),
            path: None,
        }
    }

    pub fn from_path(name: &str, path: &std::path::Path) -> Self {
        Self {
            name: name.to_string(),
            repo: None,
            git_ref: None,
            sha: None,
            path: Some(path.to_path_buf()),
        }
    }

    /// The entry's source, refusing one a hand edit broke.
    pub fn source(&self) -> Result<EntrySource> {
        let broken =
            |why: &str| PluginError::Invalid(format!("plugins.json: entry {:?} {why}", self.name));
        if !is_valid_name(&self.name) {
            return Err(broken("has an invalid name"));
        }
        match (&self.repo, &self.path) {
            (Some(repo), None) => {
                let mut source = super::source::parse_repo(repo)?;
                if source.git_ref.is_some() {
                    return Err(broken("names its ref in `repo`; it belongs in `ref`"));
                }
                if let Some(r) = &self.git_ref {
                    if !super::source::is_ref(r) {
                        return Err(broken("has a malformed ref"));
                    }
                }
                source.git_ref = self.git_ref.clone();
                let sha = self
                    .sha
                    .clone()
                    .filter(|s| is_sha(s))
                    .ok_or_else(|| broken("has no 40-hex sha"))?;
                Ok(EntrySource::Repo { source, sha })
            }
            (None, Some(path)) if path.is_absolute() => Ok(EntrySource::Path(path.clone())),
            (None, Some(_)) => Err(broken("has a relative path")),
            _ => Err(broken("needs exactly one of `repo` and `path`")),
        }
    }

    pub fn describe_source(&self) -> String {
        match (&self.repo, &self.path) {
            (Some(repo), _) => match &self.git_ref {
                Some(r) => format!("{repo}@{r}"),
                None => repo.clone(),
            },
            (_, Some(path)) => path.display().to_string(),
            _ => "?".to_string(),
        }
    }
}

impl Lockfile {
    /// The lockfile, or an empty one when there is none yet.
    pub fn load(dirs: &Layout) -> Result<Lockfile> {
        let path = dirs.lockfile();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Lockfile::default()),
            Err(e) => return Err(PluginError::io(format!("reading {}", path.display()), e)),
        };
        let lock: Lockfile = serde_json::from_str(&text).map_err(|e| {
            PluginError::Invalid(format!("{} is not a plugin lockfile: {e}", path.display()))
        })?;
        if lock.version != LOCKFILE_VERSION {
            return Err(PluginError::Invalid(format!(
                "{} is version {}; this tmuxy reads version {LOCKFILE_VERSION}",
                path.display(),
                lock.version
            )));
        }
        Ok(lock)
    }

    /// Write it back, owner-only; a crash never leaves half a lockfile.
    pub fn save(&self, dirs: &Layout) -> Result<()> {
        let path = dirs.lockfile();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PluginError::io(format!("creating {}", parent.display()), e))?;
        }
        let mut sorted = self.clone();
        sorted.plugins.sort_by(|a, b| a.name.cmp(&b.name));
        let mut text = serde_json::to_string_pretty(&sorted)
            .map_err(|e| PluginError::Invalid(e.to_string()))?;
        text.push('\n');
        crate::private_files::replace(&path, text)
            .map_err(|e| PluginError::io(format!("writing {}", path.display()), e))
    }

    pub fn get(&self, name: &str) -> Option<&Entry> {
        self.plugins.iter().find(|e| e.name == name)
    }

    pub fn upsert(&mut self, entry: Entry) {
        self.plugins.retain(|e| e.name != entry.name);
        self.plugins.push(entry);
    }

    pub fn remove(&mut self, name: &str) -> Option<Entry> {
        let at = self.plugins.iter().position(|e| e.name == name)?;
        Some(self.plugins.remove(at))
    }
}
