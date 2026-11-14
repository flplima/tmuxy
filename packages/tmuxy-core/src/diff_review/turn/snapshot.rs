//! One snapshot of a checkout, for a turn: a tree in a store of tmuxy's own.
//!
//! It starts each time from a copy of the repository's index, so a file that
//! did not change is not read again, then takes in the tracked files as they
//! are (`add -u`) and the untracked ones it may copy. An untracked file is
//! copied into the store only when it is small (at most [`MAX_FILE`], and
//! [`MAX_TOTAL`] for all of them) and not named like a secret (`.env`, a key,
//! a credentials file): any other is left out and named, so the scope can say
//! so. The store is a folder only this user can read, and goes when no diff
//! shows its checkout.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use super::super::git;
use super::{host_dir, store_name};

/// The largest untracked file a snapshot copies.
const MAX_FILE: u64 = 1024 * 1024;

/// The most untracked content one snapshot copies, all files together.
const MAX_TOTAL: u64 = 16 * 1024 * 1024;

/// The most untracked files one snapshot copies.
const MAX_FILES: usize = 2000;

/// One snapshot at a time: they share each checkout's index.
static SNAPSHOTS: Mutex<()> = Mutex::new(());

/// A snapshot: its tree, and the untracked files it left out, each with why.
#[derive(Debug, Clone)]
pub struct Shot {
    pub tree: String,
    pub left_out: Vec<String>,
}

/// A name a secret is kept under: an environment file, a private key or
/// certificate bundle, a credentials or password file. Never copied, ignored
/// by the repository or not.
pub(crate) fn named_like_a_secret(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let exact = [
        ".env",
        ".netrc",
        ".pgpass",
        ".npmrc",
        ".pypirc",
        "credentials",
    ];
    let starts = [
        ".env.",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "credentials.",
    ];
    let ends = [
        ".env",
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".kdbx",
        ".keystore",
        ".jks",
    ];
    exact.contains(&name.as_str())
        || starts.iter().any(|start| name.starts_with(start))
        || ends.iter().any(|end| name.ends_with(end))
}

/// Whether the process `pid` is running (or runs as someone else).
pub(super) fn running(pid: i32) -> bool {
    // SAFETY: signal 0 delivers nothing; it only asks whether `pid` exists.
    let answer = unsafe { libc::kill(pid, 0) };
    answer == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The store `root`'s snapshots go to, made private to this user.
pub(super) fn store_for(root: &Path, deadline: Instant) -> Option<git::Store> {
    let alternates = git_path(root, "objects", deadline)?;
    let dir = host_dir().join(store_name(root));
    let objects = dir.join("objects");
    let mut folders = std::fs::DirBuilder::new();
    folders.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut folders, 0o700);
    folders.create(&objects).ok()?;
    Some(git::Store {
        index: dir.join("index"),
        objects,
        alternates,
    })
}

/// `git rev-parse --git-path <name>`, absolute.
fn git_path(root: &Path, name: &str, deadline: Instant) -> Option<PathBuf> {
    git::text(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
        deadline,
    )
    .map(|out| PathBuf::from(out.trim_end_matches('\n')))
    .filter(|path| path.is_absolute())
}

/// The untracked files to copy, and the ones left out with why.
fn untracked(root: &Path, deadline: Instant) -> (Vec<String>, Vec<String>) {
    let listed = git::text(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        deadline,
    )
    .unwrap_or_default();
    let (mut copy, mut left_out, mut total) = (Vec::new(), Vec::new(), 0u64);
    for name in listed.split('\0').filter(|name| !name.is_empty()) {
        let size = std::fs::symlink_metadata(root.join(name)).map_or(0, |meta| meta.len());
        let why = if named_like_a_secret(name) {
            Some("named like a secret")
        } else if size > MAX_FILE {
            Some("over 1 MB")
        } else if total + size > MAX_TOTAL || copy.len() >= MAX_FILES {
            Some("past what a turn copies")
        } else {
            None
        };
        match why {
            Some(why) => left_out.push(format!("{name} ({why})")),
            None => {
                total += size;
                copy.push(name.to_string());
            }
        }
    }
    (copy, left_out)
}

/// The checkout's files as they are now, as a tree in `store`.
pub(super) fn snapshot(root: &Path, store: &git::Store, deadline: Instant) -> Option<Shot> {
    let _one = SNAPSHOTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (copy, left_out) = untracked(root, deadline);
    let tree = tree_now(root, store, &copy, true, deadline)
        // A split index keeps its entries in another file, which the copy
        // does not hold: start from HEAD's tree instead.
        .or_else(|| tree_now(root, store, &copy, false, deadline))?;
    Some(Shot { tree, left_out })
}

fn tree_now(
    root: &Path,
    store: &git::Store,
    untracked: &[String],
    copy_index: bool,
    deadline: Instant,
) -> Option<String> {
    let _ = std::fs::remove_file(&store.index);
    if copy_index {
        std::fs::copy(git_path(root, "index", deadline)?, &store.index).ok()?;
    } else {
        // With no commit yet this fails, and the index starts empty.
        let _ = git::text_in(Some(store), root, &["read-tree", "HEAD"], deadline);
    }
    // A file that cannot be read is left out, not a reason to fail.
    let _ = git::text_in(
        Some(store),
        root,
        &["add", "-u", "--ignore-errors"],
        deadline,
    );
    if !untracked.is_empty() {
        let list = store.index.with_extension("untracked");
        std::fs::write(&list, untracked.join("\0")).ok()?;
        let from = format!("--pathspec-from-file={}", list.display());
        let added = git::text_in(
            Some(store),
            root,
            &["add", "--ignore-errors", "--pathspec-file-nul", &from],
            deadline,
        );
        let _ = std::fs::remove_file(&list);
        added?;
    }
    git::text_in(Some(store), root, &["write-tree"], deadline)
        .map(|out| out.trim().to_string())
        .filter(|tree| !tree.is_empty())
}
