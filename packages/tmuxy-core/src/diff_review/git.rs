//! git for the diff widget, through [`crate::safe_git`]: the one way tmuxy
//! runs git in a repository it did not make, which reads only and runs
//! nothing the repository names. What is the diff's own is here: the diff
//! options (no external diff, no textconv, no submodule), file names left
//! unquoted, a deadline for a read and a cap on what it returns.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::safe_git;

pub use safe_git::empty_tree;

/// The longest one read of a checkout is given, every git it runs together.
const READ_LIMIT: Duration = Duration::from_secs(5);

/// The most of a diff one read returns.
const PATCH_CAP: usize = 2 * 1024 * 1024;

/// The most of anything else git prints that is read.
const TEXT_CAP: usize = 1024 * 1024;

/// What every diff is asked for on top of its command.
const DIFF_ARGS: &[&str] = &[
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

/// File names as they are, quoted only for a character git will not print
/// bare (`patch::path_of` reads them back).
fn unquoted() -> (String, String) {
    ("core.quotePath".to_string(), "false".to_string())
}

pub fn deadline() -> Instant {
    Instant::now() + READ_LIMIT
}

/// Whether git can be run here as [`crate::safe_git`] needs it (2.31 or
/// later): an older one reads no diff.
pub fn available() -> bool {
    safe_git::available()
}

/// What `git <args>` printed when it succeeded, as text.
pub fn text(dir: &Path, args: &[&str], deadline: Instant) -> Option<String> {
    let said = safe_git::run(
        safe_git::command(dir, &[unquoted()], args),
        deadline,
        TEXT_CAP,
    )?;
    said.success
        .then(|| String::from_utf8_lossy(&said.stdout).into_owned())
}

/// The patch `git <command>` prints (a `diff-files` or `diff-index`), with
/// [`DIFF_ARGS`] and every content filter switched off, and whether it was
/// cut at its cap. `None` when it failed or ran past `deadline`.
pub fn patch(dir: &Path, command: &[&str], deadline: Instant) -> Option<(String, bool)> {
    let mut settings = safe_git::filters_off(dir, deadline)?;
    settings.push(unquoted());
    let (verb, rest) = command.split_first()?;
    let mut args: Vec<&str> = vec![verb];
    args.extend_from_slice(DIFF_ARGS);
    args.extend_from_slice(rest);
    let said = safe_git::run(
        safe_git::command(dir, &settings, &args),
        deadline,
        PATCH_CAP,
    )?;
    said.success
        .then(|| (String::from_utf8_lossy(&said.stdout).into_owned(), said.cut))
}
