//! git for the diff widget, through [`crate::safe_git`]: the one way tmuxy
//! runs git in a repository it did not make, which reads only and runs
//! nothing the repository names. What is the diff's own is here: the diff
//! options (no external diff, no textconv, no submodule), file names left
//! unquoted, a deadline for a read and a cap on what it returns.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::safe_git;

pub use safe_git::EMPTY_TREE;

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

/// Where a snapshot of a checkout is kept, apart from the checkout: an index
/// and an object store of tmuxy's own, the checkout's objects read through
/// as alternates. git run with it writes there and nowhere in the checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Store {
    pub index: std::path::PathBuf,
    pub objects: std::path::PathBuf,
    /// The checkout's own object directory, read only.
    pub alternates: std::path::PathBuf,
}

/// `git <args>` in `dir`, as [`safe_git`] runs it, writing to `store` if any.
fn command(
    dir: &Path,
    settings: &[(String, String)],
    args: &[&str],
    store: Option<&Store>,
) -> std::process::Command {
    let mut command = safe_git::command(dir, settings, args);
    if let Some(store) = store {
        command
            .env("GIT_INDEX_FILE", &store.index)
            .env("GIT_OBJECT_DIRECTORY", &store.objects)
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &store.alternates);
    }
    command
}

/// What `git <args>` printed when it succeeded, as text.
pub fn text(dir: &Path, args: &[&str], deadline: Instant) -> Option<String> {
    text_in(None, dir, args, deadline)
}

/// [`text`], with a snapshot's store: a snapshot reads files in as git
/// would store them, so every content filter is switched off for it too.
pub fn text_in(
    store: Option<&Store>,
    dir: &Path,
    args: &[&str],
    deadline: Instant,
) -> Option<String> {
    let mut settings = match store {
        Some(_) => safe_git::filters_off(dir, deadline)?,
        None => Vec::new(),
    };
    settings.push(unquoted());
    let said = safe_git::run(command(dir, &settings, args, store), deadline, TEXT_CAP)?;
    said.success
        .then(|| String::from_utf8_lossy(&said.stdout).into_owned())
}

/// The patch `git <command>` prints (a `diff-files`, `diff-index` or
/// `diff-tree`), with [`DIFF_ARGS`] and every content filter switched off,
/// and whether it was cut at its cap. `None` when it failed or ran past
/// `deadline`.
pub fn patch(
    store: Option<&Store>,
    dir: &Path,
    command_args: &[&str],
    deadline: Instant,
) -> Option<(String, bool)> {
    let mut settings = safe_git::filters_off(dir, deadline)?;
    settings.push(unquoted());
    let (verb, rest) = command_args.split_first()?;
    let mut args: Vec<&str> = vec![verb];
    args.extend_from_slice(DIFF_ARGS);
    args.extend_from_slice(rest);
    let said = safe_git::run(command(dir, &settings, &args, store), deadline, PATCH_CAP)?;
    said.success
        .then(|| (String::from_utf8_lossy(&said.stdout).into_owned(), said.cut))
}
