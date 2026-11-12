//! One hunk of a diff staged, unstaged or reverted, from the widget.
//!
//! The client names the file, the hunk's place in it and the token of the
//! file's patch as it drew it; nothing it sends is handed to git. The
//! checkout is read again here, and the action is refused unless that file's
//! patch is still the one drawn: what git is given is that hunk, as git
//! itself printed it, through `git apply` run as [`super::git`] runs every
//! command (nothing the repository names runs, every content filter off).
//!
//! - **stage** (unstaged scope): the hunk into the index (`apply --cached`);
//! - **unstage** (staged scope): out of it again (`apply --cached -R`);
//! - **revert** (unstaged scope): the working tree's change thrown away
//!   (`apply -R`). The file as it was, and as the revert left it, are kept
//!   first in tmuxy's state dir, so [`undo_in`] can put it back for as long
//!   as nothing else changed the file.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use super::{checkout_root, git, read_in, DiffFile, FileStatus, Scope};
use crate::CommandError;

/// The longest an action is given, its read again included.
const ACTION_LIMIT: Duration = Duration::from_secs(10);

/// How long a revert's copy is kept.
const KEEP_REVERTS: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HunkAction {
    Stage,
    Unstage,
    Revert,
}

/// A hunk action as the client asks it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRequest {
    pub scope: Scope,
    /// The file, as the read named it.
    pub path: String,
    /// The hunk's place in the file, from 0.
    pub hunk: usize,
    /// The token of the file's patch as drawn.
    pub token: String,
    pub action: HunkAction,
}

/// What an action did: a revert's id, for its undo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkChanged {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revert: Option<String>,
}

fn changed_since(path: &str) -> CommandError {
    CommandError::invalid(format!(
        "{path} changed since the diff was drawn: nothing was done, look again"
    ))
}

/// The hunk the request names, as git printed it, with its file's header:
/// a patch of that hunk alone.
fn hunk_patch(file: &DiffFile, request: &HunkRequest) -> Result<String, CommandError> {
    if file.token != request.token {
        return Err(changed_since(&request.path));
    }
    if file.status != FileStatus::Modified || file.binary || file.mode_change.is_some() {
        return Err(CommandError::invalid(
            "only a changed text file's hunks can be staged, unstaged or reverted here",
        ));
    }
    let hunk = file
        .hunks
        .get(request.hunk)
        .ok_or_else(|| changed_since(&request.path))?;
    let mut patch = file.raw_header.join("\n");
    patch.push('\n');
    patch.push_str(&hunk.raw.join("\n"));
    patch.push('\n');
    Ok(patch)
}

/// A file only this user can read, gone when dropped.
struct PatchFile(PathBuf);

impl PatchFile {
    fn write(dir: &Path, text: &str) -> Result<Self, CommandError> {
        let failed = |e: std::io::Error| {
            CommandError::unavailable(format!("the hunk could not be written: {e}"))
        };
        private_dir(dir).map_err(failed)?;
        let path = dir.join(format!("hunk-{}-{}.patch", std::process::id(), unique()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        std::io::Write::write_all(&mut options.open(&path).map_err(failed)?, text.as_bytes())
            .map_err(failed)?;
        Ok(Self(path))
    }
}

impl Drop for PatchFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    let mut folders = std::fs::DirBuilder::new();
    folders.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut folders, 0o700);
    folders.create(dir)
}

/// A name no other call of this process has had.
fn unique() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{now}-{n}")
}

/// Where reverts are kept: tmuxy's state dir.
static REVERTS: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn reverts_dir() -> PathBuf {
    REVERTS
        .get_or_init(|| crate::paths::state_dir().join("diff-reverts"))
        .clone()
}

/// Reverts kept in a folder of this test process's own, never the
/// developer's: the folder.
#[cfg(test)]
pub(crate) fn test_reverts() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-reverts-{}", std::process::id()));
    let _ = REVERTS.set(dir.clone());
    assert_eq!(reverts_dir(), dir, "reverts were already kept elsewhere");
    dir
}

/// Do what `request` asks in the checkout `dir` is in.
pub fn change_in(dir: &Path, request: &HunkRequest) -> Result<HunkChanged, CommandError> {
    let deadline = Instant::now() + ACTION_LIMIT;
    let args: &[&str] = match (request.scope, request.action) {
        (Scope::Unstaged, HunkAction::Stage) => &["--cached"],
        (Scope::Staged, HunkAction::Unstage) => &["--cached", "-R"],
        (Scope::Unstaged, HunkAction::Revert) => &["-R"],
        _ => return Err(CommandError::invalid(
            "a hunk is staged or reverted from the unstaged changes, unstaged from the staged ones",
        )),
    };
    let root = checkout_root(dir, deadline)?;
    let read = read_in(&root, request.scope)?;
    let file = read
        .files
        .iter()
        .find(|file| file.path == request.path)
        .ok_or_else(|| changed_since(&request.path))?;
    let patch = PatchFile::write(&reverts_dir(), &hunk_patch(file, request)?)?;
    let patch_arg = patch.0.display().to_string();
    let saved = match request.action {
        HunkAction::Revert => Some(Saved::before(&root, &file.raw_path)?),
        _ => None,
    };
    let mut all = args.to_vec();
    all.push(&patch_arg);
    if !git::apply(&root, &all, deadline) {
        if let Some(saved) = saved {
            saved.discard();
        }
        return Err(changed_since(&request.path));
    }
    let revert = saved.map(|saved| saved.after()).transpose()?;
    Ok(HunkChanged { revert })
}

/// A revert's copy: the file before it, and after.
struct Saved {
    dir: PathBuf,
    file: PathBuf,
}

impl Saved {
    /// The file as it is, kept before it is reverted. Only a plain file
    /// inside the checkout: never a link, never past one.
    fn before(root: &Path, raw_path: &str) -> Result<Self, CommandError> {
        let file = root.join(raw_path);
        if !plain_inside(&file, root) {
            return Err(CommandError::invalid(format!(
                "{raw_path} is not a plain file in the checkout: it is not reverted here"
            )));
        }
        prune_old_reverts();
        let failed = |e: std::io::Error| {
            CommandError::unavailable(format!("the copy to undo with could not be kept: {e}"))
        };
        let dir = reverts_dir().join(unique());
        private_dir(&dir).map_err(failed)?;
        std::fs::copy(&file, dir.join("before")).map_err(failed)?;
        std::fs::write(dir.join("file"), file.display().to_string()).map_err(failed)?;
        Ok(Self { dir, file })
    }

    /// The file as the revert left it: kept too, and the revert's id.
    fn after(self) -> Result<String, CommandError> {
        std::fs::copy(&self.file, self.dir.join("after")).map_err(|e| {
            CommandError::unavailable(format!(
                "reverted, but the copy to undo with is incomplete: {e}"
            ))
        })?;
        Ok(self
            .dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default())
    }

    fn discard(self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// `file` is a plain file (not a link) inside `root`, by its real path.
fn plain_inside(file: &Path, root: &Path) -> bool {
    let plain = std::fs::symlink_metadata(file).is_ok_and(|meta| meta.file_type().is_file());
    let inside = std::fs::canonicalize(file)
        .ok()
        .zip(std::fs::canonicalize(root).ok())
        .is_some_and(|(file, root)| file.starts_with(root));
    plain && inside
}

/// `bytes` written over `file`, never through a link: one swapped in after
/// the checks fails to open.
fn put_back(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    std::io::Write::write_all(&mut options.open(file)?, bytes)
}

/// Copies of reverts older than [`KEEP_REVERTS`] go.
fn prune_old_reverts() {
    let Ok(entries) = std::fs::read_dir(reverts_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age > KEEP_REVERTS);
        if old && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Put back the file revert `id` changed, in the checkout `dir` is in, as
/// long as it is still as the revert left it.
pub fn undo_in(dir: &Path, id: &str) -> Result<(), CommandError> {
    let gone = || CommandError::invalid("that revert is no longer kept: nothing was undone");
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err(gone());
    }
    let saved = reverts_dir().join(id);
    let file = std::fs::read_to_string(saved.join("file"))
        .map(PathBuf::from)
        .map_err(|_| gone())?;
    let root = checkout_root(dir, Instant::now() + ACTION_LIMIT)?;
    if !file.starts_with(&root) || !plain_inside(&file, &root) {
        return Err(CommandError::forbidden(
            "that revert was made in another checkout",
        ));
    }
    let after = std::fs::read(saved.join("after")).map_err(|_| gone())?;
    if std::fs::read(&file).ok() != Some(after) {
        return Err(CommandError::invalid(
            "the file changed since the revert: nothing was undone (what the revert took out is kept in tmuxy's state folder)",
        ));
    }
    let before = std::fs::read(saved.join("before")).map_err(|_| gone())?;
    put_back(&file, &before)
        .map_err(|e| CommandError::unavailable(format!("the file could not be put back: {e}")))?;
    let _ = std::fs::remove_dir_all(&saved);
    Ok(())
}

#[cfg(test)]
mod tests;
