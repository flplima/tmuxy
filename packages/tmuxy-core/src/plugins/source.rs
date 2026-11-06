//! Where a plugin comes from: `owner/repo[/subdir][@ref]` on GitHub, or a
//! local directory linked with `--path`.
//!
//! Every part is checked against a narrow alphabet before it reaches git:
//! an owner or a ref starting with `-` would be read as an option, and a
//! subdir with `..` would point outside the checkout.

use std::path::PathBuf;

use super::{PluginError, Result};

/// A GitHub repository, optionally a plugin in one of its subdirectories,
/// optionally at a branch, tag or commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSource {
    pub owner: String,
    pub repo: String,
    pub subdir: Option<String>,
    pub git_ref: Option<String>,
}

impl RepoSource {
    /// `owner/repo[/subdir]`, without the ref: the source as the lockfile
    /// records it.
    pub fn slug(&self) -> String {
        match &self.subdir {
            Some(subdir) => format!("{}/{}/{}", self.owner, self.repo, subdir),
            None => format!("{}/{}", self.owner, self.repo),
        }
    }

    pub fn url(&self) -> String {
        format!("{}/{}/{}.git", git_base(), self.owner, self.repo)
    }
}

/// `https://github.com`, unless `TMUXY_PLUGIN_GIT_BASE` names another base
/// (the test suites' local `file://` repositories).
pub fn git_base() -> String {
    std::env::var("TMUXY_PLUGIN_GIT_BASE")
        .ok()
        .filter(|b| !b.is_empty())
        .map(|b| b.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://github.com".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallSource {
    Repo(RepoSource),
    /// A bare plugin name, for the marketplace index.
    Name(String),
    /// `--path <dir>`, linked live.
    Path(PathBuf),
}

fn is_owner(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 39
        && !s.starts_with('-')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn is_path_word(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// A branch, tag or commit: git's own ref alphabet, narrowed.
pub fn is_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with('-')
        && !s.starts_with('/')
        && !s.ends_with('/')
        && !s.ends_with(".lock")
        && !s.contains("..")
        && !s.contains("//")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
}

pub fn parse_repo(spec: &str) -> Result<RepoSource> {
    let invalid = |why: &str| {
        PluginError::Invalid(format!(
            "{spec:?} is not a plugin source: {why} (expected owner/repo[/subdir][@ref])"
        ))
    };
    let (path, git_ref) = match spec.split_once('@') {
        Some((path, r)) => (path, Some(r)),
        None => (spec, None),
    };
    if let Some(r) = git_ref {
        if !is_ref(r) {
            return Err(invalid("the @ref has characters git refs do not"));
        }
    }
    let mut parts = path.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if !is_owner(owner) {
        return Err(invalid(
            "the owner is not a GitHub user or organisation name",
        ));
    }
    if !is_path_word(repo) {
        return Err(invalid("the repository name is missing or malformed"));
    }
    let rest: Vec<&str> = parts.collect();
    if rest.iter().any(|p| !is_path_word(p)) {
        return Err(invalid(
            "the subdirectory has an empty, `.`, `..` or malformed part",
        ));
    }
    Ok(RepoSource {
        owner: owner.to_string(),
        repo: repo.trim_end_matches(".git").to_string(),
        subdir: (!rest.is_empty()).then(|| rest.join("/")),
        git_ref: git_ref.map(str::to_string),
    })
}

/// Parse an install argument: a repo source when it has a `/`, a bare name
/// otherwise.
pub fn parse_install(spec: &str) -> Result<InstallSource> {
    if spec.contains('/') {
        return parse_repo(spec).map(InstallSource::Repo);
    }
    if super::is_valid_name(spec) {
        return Ok(InstallSource::Name(spec.to_string()));
    }
    Err(PluginError::Invalid(format!(
        "{spec:?} is neither owner/repo[/subdir][@ref] nor a plugin name"
    )))
}
