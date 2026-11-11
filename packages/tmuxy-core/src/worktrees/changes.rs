//! Lines added and removed in a checkout against its `HEAD`: the `+12 −3`
//! beside a pane's branch.
//!
//! This is git run on a timer in directories the user merely stands in, so
//! it is held to reading:
//!
//!   * `git diff-index`, not `git diff`: the porcelain refreshes the index
//!     and writes it back under `index.lock` (with `GIT_OPTIONAL_LOCKS=0`
//!     too), and the user's own `git commit` in that second would fail on
//!     the lock. The plumbing command reads the index as it is;
//!   * no filesystem monitor, external diff or textconv: each is a program
//!     the repository's config names, and counting lines must not run it;
//!   * a time limit: a checkout too large to diff in it shows no numbers
//!     rather than holding the whole discovery.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Lines changed against `HEAD`, staged or not. Untracked files are not in
/// it: git does not count a file it does not track.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct GitChanges {
    pub added: u32,
    pub removed: u32,
}

const TIME_LIMIT: Duration = Duration::from_secs(2);

const DIFF_ARGS: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "diff-index",
    "--no-ext-diff",
    "--no-textconv",
    "--shortstat",
    "HEAD",
];

/// The changes in the checkout at `worktree`, or `None` when git cannot say
/// in time: no commit yet, a repository it refuses to read, a diff too slow.
pub(super) fn of(worktree: &Path) -> Option<GitChanges> {
    of_within(worktree, TIME_LIMIT)
}

fn of_within(worktree: &Path, limit: Duration) -> Option<GitChanges> {
    let mut command = super::git(worktree, DIFF_ARGS);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    // One line at most, so it was never waiting on a full pipe.
    let mut stat = String::new();
    child.stdout.take()?.read_to_string(&mut stat).ok()?;
    Some(parse_shortstat(&stat))
}

/// ` 3 files changed, 12 insertions(+), 3 deletions(-)`, either count left
/// out when it is zero, and nothing at all for a clean checkout.
fn parse_shortstat(stat: &str) -> GitChanges {
    let count = |what: &str| {
        stat.split(',')
            .map(str::trim)
            .find(|part| part.contains(what))
            .and_then(|part| part.split_whitespace().next())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    };
    GitChanges {
        added: count("insertion"),
        removed: count("deletion"),
    }
}

#[cfg(test)]
pub(super) mod tests;
