//! The new worktree a fork lives in: made beside the repository's main one on
//! a new branch, then given the uncommitted work of the pane it forks.
//!
//! git runs through `safe_git`: nothing the repository's config names is
//! run. That includes the checkout's filters and hooks, so a repository that
//! needs them (Git LFS, a post-checkout step) gets a checkout without them,
//! and its own setup has to follow.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tmuxy_core::safe_git;

/// How long one git call may take, and the most it may print.
const TIME_LIMIT: Duration = Duration::from_secs(10);
const OUTPUT_CAP: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub path: String,
    pub branch: String,
    /// The repository's main worktree, which the new one sits beside.
    pub repository: String,
}

/// What `args` printed when git, run in `dir`, ended well.
fn read(dir: &Path, operation: &str, args: &[&str]) -> Result<String, String> {
    let failed = || format!("git {operation} failed in {}", dir.display());
    let deadline = Instant::now() + TIME_LIMIT;
    let off = safe_git::filters_off(dir, deadline).ok_or_else(failed)?;
    let said = safe_git::run(safe_git::command(dir, &off, args), deadline, OUTPUT_CAP)
        .ok_or_else(failed)?;
    if said.success && !said.cut {
        Ok(String::from_utf8_lossy(&said.stdout).into_owned())
    } else {
        Err(failed())
    }
}

/// The main worktree of the repository `path` is in.
fn main_worktree(path: &Path) -> Result<PathBuf, String> {
    let not_git = || format!("{} is not in a git worktree", path.display());
    let listing = read(
        path,
        "worktree list",
        &["worktree", "list", "--porcelain", "-z"],
    )
    .map_err(|_| not_git())?;
    let first = listing.split('\0').next().unwrap_or_default();
    first
        .strip_prefix("worktree ")
        .map(PathBuf::from)
        .ok_or_else(not_git)
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
pub fn create(path: &Path, branch: &str, base: Option<&str>) -> Result<Created, String> {
    let main = main_worktree(path)?;
    if !valid_branch(&main, branch) {
        return Err(format!("{branch:?} is not a branch name git takes"));
    }
    let name = main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tail = branch.rsplit('/').next().unwrap_or(branch);
    let target = main.with_file_name(format!("{name}-{tail}"));
    #[cfg(test)]
    assert!(
        target.starts_with(scratch_root()),
        "a test made a worktree outside the temp dir: {}",
        target.display()
    );
    if target.exists() {
        return Err(format!("{} is already there", target.display()));
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

/// Take a worktree [`create`] made back out, with whatever was copied in.
pub fn discard(created: &Created) -> Result<(), String> {
    read(
        Path::new(&created.repository),
        "worktree remove",
        &["worktree", "remove", "--force", &created.path],
    )
    .map(drop)
}

/// The commit the worktree `path` is on: what a copy of it starts from.
pub fn head(path: &Path) -> Result<String, String> {
    read(
        path,
        "rev-parse",
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )
    .map(|s| s.trim().to_string())
}

/// What [`carry`] brought over.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Carried {
    /// Tracked files with changes not committed yet, copied or deleted.
    pub changed: Vec<String>,
    /// Untracked files copied, when asked for.
    pub untracked: Vec<String>,
    /// Entries left behind: not regular files, or paths that would leave
    /// the worktree.
    pub skipped: Vec<String>,
}

/// A path git listed, as a path inside a worktree: `None` for one that
/// would leave it.
fn inside(name: &str) -> Option<&Path> {
    let relative = Path::new(name);
    relative
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
        .then_some(relative)
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Where `relative` goes in `to`, with any symlink already there removed,
/// or `None` when a directory on the way there is a symlink: writing
/// through it would land outside the worktree.
fn target_in(to: &Path, relative: &Path) -> Option<std::path::PathBuf> {
    let mut dir = to.to_path_buf();
    for part in relative.parent().into_iter().flat_map(Path::components) {
        dir.push(part);
        if is_symlink(&dir) {
            return None;
        }
    }
    let target = to.join(relative);
    if is_symlink(&target) && std::fs::remove_file(&target).is_err() {
        return None;
    }
    Some(target)
}

/// Copy `name` from `from` to `to` when it is a regular file inside the
/// worktree, never through a symlink; whether it was.
fn copy_file(from: &Path, to: &Path, name: &str) -> bool {
    let Some(relative) = inside(name) else {
        return false;
    };
    let source = from.join(relative);
    if !std::fs::symlink_metadata(&source).is_ok_and(|m| m.file_type().is_file()) {
        return false;
    }
    let Some(target) = target_in(to, relative) else {
        return false;
    };
    target
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::copy(&source, &target))
        .is_ok()
}

/// Bring `from`'s uncommitted changes to tracked files into `to`, a new
/// worktree on the same commit; with `untracked`, its untracked files too.
/// `from` may be any directory of that worktree: the whole worktree is carried.
///
/// Each changed file's content is copied as it is now, and a deleted one is
/// deleted: on the same commit that is the same state, and no `git apply`
/// runs, so no attribute or filter the repository names comes into it.
/// Only regular files inside the worktree are copied; anything else (a
/// symlink, a path that would leave it) is left behind and listed in
/// `skipped`. Nothing in `from` changes.
pub fn carry(from: &Path, to: &Path, untracked: bool) -> Result<Carried, String> {
    // The pane may sit in a subdirectory: git names the changes from the top
    // of the worktree, and `ls-files` from where it runs, so both run there.
    let top = read(from, "rev-parse", &["rev-parse", "--show-toplevel"])?;
    let from = Path::new(top.trim_end_matches('\n'));
    let mut carried = Carried::default();
    // diff-index compares by file stat and hashes nothing, so no clean
    // filter the repository names (in .gitattributes or .git/info/attributes)
    // runs. A file only touched is listed too, and copied unchanged.
    let changes = read(
        from,
        "diff-index",
        &["diff-index", "--name-status", "--no-renames", "-z", "HEAD"],
    )?;
    let mut fields = changes.split('\0').filter(|f| !f.is_empty());
    while let (Some(status), Some(name)) = (fields.next(), fields.next()) {
        let done = if status == "D" {
            inside(name)
                .and_then(|relative| target_in(to, relative))
                .is_some_and(|target| !target.exists() || std::fs::remove_file(target).is_ok())
        } else {
            copy_file(from, to, name)
        };
        if done {
            carried.changed.push(name.to_string());
        } else {
            carried.skipped.push(name.to_string());
        }
    }
    if untracked {
        let listed = read(
            from,
            "ls-files",
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?;
        for name in listed.split('\0').filter(|l| !l.is_empty()) {
            if copy_file(from, to, name) {
                carried.untracked.push(name.to_string());
            } else {
                carried.skipped.push(name.to_string());
            }
        }
    }
    Ok(carried)
}

#[cfg(test)]
fn scratch_root() -> PathBuf {
    std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir())
}

#[cfg(test)]
#[path = "checkout_tests.rs"]
mod tests;
