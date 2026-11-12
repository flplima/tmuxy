//! Whether a linked worktree can go without losing work, and its removal.
//!
//! A worktree is someone's work in progress: an agent's branch, a fix half
//! done. Removing one that holds changes nobody committed, files git does not
//! track, or commits that are on no remote throws that work away, so
//! [`remove`] refuses unless it is forced. The branch is never deleted: a
//! removed worktree's commits stay where they were.
//!
//! git runs here in repositories tmuxy did not make, so it is held to what
//! it needs: no filesystem monitor, hooks, external diff, textconv, pager or
//! credential helper, no attributes (so no clean or smudge filter runs), no
//! optional locks, no prompt, and a time limit on every call.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long one git call may take before the answer is "cannot say".
const TIME_LIMIT: Duration = Duration::from_secs(10);

/// The tree with nothing in it: attributes read from it are none at all.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// What a worktree holds that removing it would lose.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Unsaved {
    /// Tracked files changed against `HEAD`, staged or not.
    pub changed: bool,
    /// Files git does not track and does not ignore.
    pub untracked: bool,
    /// Commits reachable from `HEAD` that no remote-tracking branch has.
    pub unpushed: u32,
}

impl Unsaved {
    pub fn is_empty(&self) -> bool {
        *self == Unsaved::default()
    }

    /// What would be lost, in words: "uncommitted changes, 2 unpushed commits".
    pub fn said(&self) -> String {
        let mut parts = Vec::new();
        if self.changed {
            parts.push("uncommitted changes".to_string());
        }
        if self.untracked {
            parts.push("untracked files".to_string());
        }
        match self.unpushed {
            0 => {}
            1 => parts.push("1 commit on no remote".to_string()),
            n => parts.push(format!("{n} commits on no remote")),
        }
        parts.join(", ")
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GuardError {
    #[error("{0} is not in a git worktree")]
    NotAWorktree(String),
    #[error("{0} is the repository's main worktree, which is not removed")]
    MainWorktree(String),
    #[error("{0} is locked: unlock it with `git worktree unlock` first")]
    Locked(String),
    #[error("not removed: {path} has {unsaved}. --force removes it anyway; its branch stays")]
    Unsaved { path: String, unsaved: String },
    #[error("git {operation} in {path}: {message}")]
    Git {
        operation: &'static str,
        path: String,
        message: String,
    },
}

/// A linked worktree, as git places it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Linked {
    /// Its top directory.
    pub root: PathBuf,
    /// The repository's shared git directory.
    pub common_dir: PathBuf,
    /// Its branch, when it is on one.
    pub branch: Option<String>,
}

/// The filter drivers the repository's config names (`filter.<name>.*`).
/// An attributes file can name any of them, `.git/info/attributes` included,
/// which no attribute-source setting reaches, so each is switched off by
/// name instead. Reading the config runs nothing.
///
/// To be replaced by `safe_git`'s `filters_off` once it lands.
fn filter_drivers(path: &Path) -> Vec<String> {
    let mut command = super::git(
        path,
        &["config", "--name-only", "-z", "--get-regexp", r"^filter\."],
    );
    command.stdin(Stdio::null()).stderr(Stdio::null());
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    let mut names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .split(['\0', '\n'])
        .filter_map(|key| key.strip_prefix("filter.")?.rsplit_once('.'))
        .map(|(name, _)| name.to_string())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The config pairs that leave each of `drivers` doing nothing: no clean,
/// smudge or long-running process command, and not required.
fn filters_off(drivers: &[String]) -> Vec<(String, String)> {
    drivers
        .iter()
        .flat_map(|name| {
            [
                ("clean", ""),
                ("smudge", ""),
                ("process", ""),
                ("required", "false"),
            ]
            .map(|(key, value)| (format!("filter.{name}.{key}"), value.to_string()))
        })
        .collect()
}

/// git, rooted at `path`, with everything a repository's config could make
/// it run turned off.
fn quiet_git(path: &Path, args: &[&str]) -> Command {
    let attributes = format!("attr.tree={EMPTY_TREE}");
    let mut all = vec![
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "diff.external=",
        "-c",
        "credential.helper=",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        &attributes,
    ];
    all.extend_from_slice(args);
    let mut command = super::git(path, &all);
    // Set through the environment, which git reads above every config file.
    let off = filters_off(&filter_drivers(path));
    command.env("GIT_CONFIG_COUNT", off.len().to_string());
    for (i, (key, value)) in off.iter().enumerate() {
        command
            .env(format!("GIT_CONFIG_KEY_{i}"), key)
            .env(format!("GIT_CONFIG_VALUE_{i}"), value);
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_ATTR_SOURCE", EMPTY_TREE)
        .env_remove("GIT_EXTERNAL_DIFF")
        .env_remove("GIT_PAGER")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// What a git call said: its exit code, its output and its error text.
struct Said {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Run `command`, giving up after [`TIME_LIMIT`]. Output is read as it
/// comes, so a long answer cannot stall git on a full pipe.
fn run(mut command: Command, operation: &'static str, path: &Path) -> Result<Said, GuardError> {
    let fail = |message: String| GuardError::Git {
        operation,
        path: path.display().to_string(),
        message,
    };
    let mut child = command.spawn().map_err(|e| fail(e.to_string()))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + TIME_LIMIT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail("took too long".into()));
            }
        }
    };
    Ok(Said {
        code: status.code(),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// `operation`'s output, or its error when it did not exit 0.
fn read(path: &Path, operation: &'static str, args: &[&str]) -> Result<String, GuardError> {
    let said = run(quiet_git(path, args), operation, path)?;
    if said.code == Some(0) {
        Ok(said.stdout)
    } else {
        Err(GuardError::Git {
            operation,
            path: path.display().to_string(),
            message: said.stderr.trim().to_string(),
        })
    }
}

/// The linked worktree `path` is in: an error for a directory outside git
/// and for a repository's main worktree.
pub fn linked(path: &Path) -> Result<Linked, GuardError> {
    let shown = path.display().to_string();
    let answer = read(
        path,
        "rev-parse",
        &[
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    )
    .map_err(|_| GuardError::NotAWorktree(shown.clone()))?;
    let mut lines = answer.lines();
    let (Some(root), Some(git_dir), Some(common)) = (lines.next(), lines.next(), lines.next())
    else {
        return Err(GuardError::NotAWorktree(shown));
    };
    let root = PathBuf::from(root);
    // `--git-common-dir` is relative to where git was asked, when it is.
    let common_dir = std::fs::canonicalize(path.join(common))
        .map_err(|_| GuardError::NotAWorktree(shown.clone()))?;
    let git_dir = std::fs::canonicalize(git_dir).unwrap_or_else(|_| PathBuf::from(git_dir));
    if git_dir == common_dir {
        return Err(GuardError::MainWorktree(root.display().to_string()));
    }
    if git_dir.join("locked").exists() {
        return Err(GuardError::Locked(root.display().to_string()));
    }
    let branch = read(
        path,
        "symbolic-ref",
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .ok()
    .map(|b| b.trim().to_string())
    .filter(|b| !b.is_empty());
    Ok(Linked {
        root,
        common_dir,
        branch,
    })
}

/// What the worktree at `root` holds that removing it would lose.
pub fn unsaved(root: &Path) -> Result<Unsaved, GuardError> {
    // 1 is "there are differences"; anything else but 0 is a failure.
    let diff = run(
        quiet_git(
            root,
            &[
                "diff-index",
                "--quiet",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
            ],
        ),
        "diff-index",
        root,
    )?;
    let changed = match diff.code {
        Some(0) => false,
        Some(1) => true,
        _ => {
            return Err(GuardError::Git {
                operation: "diff-index",
                path: root.display().to_string(),
                message: diff.stderr.trim().to_string(),
            })
        }
    };
    let untracked = !read(
        root,
        "ls-files",
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
        ],
    )?
    .trim()
    .is_empty();
    let unpushed = read(
        root,
        "rev-list",
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
    )?
    .trim()
    .parse()
    .unwrap_or(0);
    Ok(Unsaved {
        changed,
        untracked,
        unpushed,
    })
}

/// What a removal did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub path: String,
    /// The branch it was on, which is kept.
    pub branch: Option<String>,
    /// What was there when it was forced: empty when nothing was lost.
    pub lost: Unsaved,
}

/// Remove the linked worktree `path` is in, keeping its branch. Refused while
/// it holds [`Unsaved`] work, unless `force`.
pub fn remove(path: &Path, force: bool) -> Result<Removed, GuardError> {
    let worktree = linked(path)?;
    #[cfg(test)]
    assert!(
        std::fs::canonicalize(&worktree.root)
            .unwrap_or_else(|_| worktree.root.clone())
            .starts_with(scratch_root()),
        "a test removed a worktree outside the temp dir: {}",
        worktree.root.display()
    );
    let lost = unsaved(&worktree.root)?;
    let shown = worktree.root.display().to_string();
    if !lost.is_empty() && !force {
        return Err(GuardError::Unsaved {
            path: shown,
            unsaved: lost.said(),
        });
    }
    let root = worktree.root.to_string_lossy();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&root);
    // From the shared git directory: a worktree is not removed from inside.
    read(&worktree.common_dir, "worktree remove", &args)?;
    Ok(Removed {
        path: shown,
        branch: worktree.branch,
        lost,
    })
}

/// Where a test's repositories live: a removal outside the temp dir in a test
/// would be a developer's own worktree.
#[cfg(test)]
pub(crate) fn scratch_root() -> PathBuf {
    std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir())
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod tests;
