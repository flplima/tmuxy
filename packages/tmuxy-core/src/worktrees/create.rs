//! A new linked worktree for a task: its branch named after the task, its
//! directory beside the repository's main one.
//!
//! git runs as it does for a removal ([`super::guard`]): nothing the
//! repository's config names is run. That includes the checkout's filters
//! and hooks, so a repository that needs them (Git LFS, a post-checkout
//! step) gets a checkout without them, and its own setup has to follow.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::guard::{read, GuardError};

/// The most characters of a task taken into a branch name.
const SLUG_CHARS: usize = 40;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub path: String,
    pub branch: String,
    /// The repository's main worktree, which the new one sits beside.
    pub repository: String,
}

/// A branch name's last part from a task in words: lowercase letters and
/// digits (accented ones too: `navegação` stays whole), the rest one `-`, at
/// most [`SLUG_CHARS`] characters and cut at a word. "Fix the login
/// redirect!" is `fix-the-login-redirect`.
pub fn slug(task: &str) -> String {
    let mut slug = String::new();
    for c in task.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let Some((limit, _)) = slug.char_indices().nth(SLUG_CHARS) else {
        return slug.to_string();
    };
    let cut = slug[..limit].rfind('-').unwrap_or(limit);
    slug[..cut].to_string()
}

/// The main worktree of the repository `path` is in.
fn main_worktree(path: &Path) -> Result<PathBuf, GuardError> {
    let listing = read(
        path,
        "worktree list",
        &["worktree", "list", "--porcelain", "-z"],
    )
    .map_err(|_| GuardError::NotAWorktree(path.display().to_string()))?;
    let first = listing.split('\0').next().unwrap_or_default();
    first
        .strip_prefix("worktree ")
        .map(PathBuf::from)
        .ok_or_else(|| GuardError::NotAWorktree(path.display().to_string()))
}

/// Whether `branch` is a name git takes for a new branch.
fn valid_branch(path: &Path, branch: &str) -> bool {
    read(
        path,
        "check-ref-format",
        &["check-ref-format", "--branch", branch],
    )
    .is_ok()
}

/// A new worktree of the repository `path` is in, on a new branch `branch`
/// started from `base` (the repository's `HEAD` when not given), in
/// `<main>-<last part of the branch>` beside the main worktree. Refused when
/// that directory or that branch already exists.
pub fn create(path: &Path, branch: &str, base: Option<&str>) -> Result<Created, GuardError> {
    let main = main_worktree(path)?;
    if !valid_branch(&main, branch) {
        return Err(GuardError::Git {
            operation: "check-ref-format",
            path: main.display().to_string(),
            message: format!("{branch:?} is not a branch name git takes"),
        });
    }
    let name = main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tail = slug(branch.rsplit('/').next().unwrap_or(branch));
    let target = main.with_file_name(format!("{name}-{tail}"));
    #[cfg(test)]
    assert!(
        target.starts_with(super::guard::scratch_root()),
        "a test made a worktree outside the temp dir: {}",
        target.display()
    );
    if target.exists() {
        return Err(GuardError::Git {
            operation: "worktree add",
            path: main.display().to_string(),
            message: format!("{} is already there", target.display()),
        });
    }
    let target_arg = target.to_string_lossy();
    // After `--`, a base like `-x` is a commit to start from, not an option.
    let mut args = vec!["worktree", "add", "-q", "-b", branch, "--", &target_arg];
    if let Some(base) = base {
        args.push(base);
    }
    read(&main, "worktree add", &args)?;
    Ok(Created {
        path: target.display().to_string(),
        branch: branch.to_string(),
        repository: main.display().to_string(),
    })
}

#[cfg(test)]
#[path = "create_tests.rs"]
mod tests;
