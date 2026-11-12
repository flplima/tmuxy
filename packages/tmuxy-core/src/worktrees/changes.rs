//! Lines added and removed in a checkout against its `HEAD`: the `+12 −3`
//! beside a pane's branch.
//!
//! This is git run on a timer in directories the user merely stands in, so
//! it runs the way tmuxy runs git in a repository it did not make
//! (`crate::safe_git`): nothing the repository names runs, and every content
//! filter driver is switched off, so a changed git-lfs file is compared as
//! the text it is. On top of that:
//!
//!   * `git diff-index`, not `git diff`: the porcelain refreshes the index
//!     and writes it back under `index.lock` (with `GIT_OPTIONAL_LOCKS=0`
//!     too), and the user's own `git commit` in that second would fail on
//!     the lock. The plumbing command reads the index as it is;
//!   * no external diff, no textconv, and no submodule, inside which git
//!     would run a status under that submodule's own config;
//!   * a time limit, per checkout and for all of them together: a checkout
//!     too large to diff in it shows no numbers.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::safe_git;

use serde::Serialize;

/// Lines changed against `HEAD`, staged or not. Untracked files are not in
/// it: git does not count a file it does not track.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct GitChanges {
    pub added: u32,
    pub removed: u32,
}

/// The longest one checkout is given.
const CHECKOUT_LIMIT: Duration = Duration::from_secs(2);

/// The longest all the checkouts of one discovery are given together: six
/// slow ones must not hold the request for twelve seconds.
pub(super) const PASS_LIMIT: Duration = Duration::from_secs(4);

const DIFF_ARGS: &[&str] = &[
    "diff-index",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "--shortstat",
    "HEAD",
];

/// The changes in the checkout at `worktree`, or `None` when git cannot say
/// by `pass_deadline` or within its own limit: no commit yet, a repository
/// it refuses to read, a diff too slow.
pub(super) fn of(worktree: &Path, pass_deadline: Instant) -> Option<GitChanges> {
    let deadline = pass_deadline.min(Instant::now() + CHECKOUT_LIMIT);
    let off = safe_git::filters_off(worktree, deadline)?;
    let said = safe_git::run(safe_git::command(worktree, &off, DIFF_ARGS), deadline, 4096)?;
    (said.success && !said.cut).then(|| parse_shortstat(&String::from_utf8_lossy(&said.stdout)))
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
