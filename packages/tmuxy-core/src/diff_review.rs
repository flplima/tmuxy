//! What a `diff` widget shows: the changes in one git checkout, read for the
//! pane that shows them.
//!
//! The checkout is the pane's own `@tmuxy-pane-diff`
//! ([`crate::constants::tmux_options::PANE_DIFF`]), written by
//! `tmuxy-widget-diff` out of band and asked of tmux on every read, as the
//! preview's file is: a client names only the pane. Three scopes:
//!
//! - **unstaged**: the working tree against the index, and the files git does
//!   not track yet (names only);
//! - **staged**: the index against `HEAD`;
//! - **branch**: the working tree against where the branch left its base
//!   (the merge base with `origin/HEAD`, else `main`, else `master`), so what
//!   the branch has committed and what it has not, together;
//! - **turn**: what an agent beside the diff changed in its last turn
//!   ([`turn`]), untracked files included.
//!
//! git runs in a directory the user chose but whose content is anyone's (a
//! clone, a pull request checked out), so it runs nothing the repository
//! names ([`git`]), and its output is untrusted text: file names and lines
//! are returned as strings for the client to render as text, never markup.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::constants::tmux_options::{PANE_DIFF, PANE_WIDGET};
use crate::control_mode::{query, MonitorCommandSender};
use crate::{CommandError, PaneId};

mod git;
pub mod hunk;
mod patch;
pub mod turn;

pub use patch::{DiffFile, DiffLine, FileStatus, Hunk, LineKind};

/// The widget name `tmuxy-widget-diff` runs under.
pub const WIDGET: &str = "diff";

/// How many untracked files are listed; the rest are counted.
const MAX_UNTRACKED: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Unstaged,
    Staged,
    Branch,
    Turn,
}

/// One read of a checkout's changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRead {
    /// The checkout's folder name, for the title. Not its path: the client
    /// has no use for where the checkout is.
    pub name: String,
    pub scope: Scope,
    /// The branch checked out, when one is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// For the branch scope: the ref the branch is compared with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub files: Vec<DiffFile>,
    /// Files git does not track yet, for the unstaged and branch scopes.
    pub untracked: Vec<String>,
    /// How many untracked files were left out of the list.
    pub untracked_more: usize,
    /// The diff was larger than a read returns: what is here is its start.
    pub truncated: bool,
    /// For the turn scope: whose turn, and whether it is still going.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<turn::TurnInfo>,
}

/// The checkout a pane may read, from its options: the pane must be showing
/// the `diff` widget, and the folder must be an absolute path.
pub fn parse_authorisation(answer: &str) -> Result<PathBuf, CommandError> {
    let mut lines = answer.lines();
    let widget = lines.next().unwrap_or("").trim();
    let dir = lines.next().unwrap_or("").trim();
    if widget != WIDGET || dir.is_empty() {
        return Err(CommandError::forbidden("this pane is not showing a diff"));
    }
    let dir = PathBuf::from(dir);
    if !dir.is_absolute() {
        return Err(CommandError::forbidden("the diff's folder is not absolute"));
    }
    Ok(dir)
}

fn authorisation_query(pane: &PaneId) -> String {
    [PANE_WIDGET, PANE_DIFF]
        .map(|option| format!("display-message -p -t {pane} '#{{{option}}}'"))
        .join(" ; ")
}

/// The checkout `pane` may act on, as tmux says on this call.
async fn authorised(tx: &MonitorCommandSender, pane: &PaneId) -> Result<PathBuf, CommandError> {
    let answer = query(tx, &authorisation_query(pane))
        .await
        .map_err(|e| e.context("Failed to read the pane's diff"))?;
    parse_authorisation(&answer)
}

/// `work` off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| CommandError::unavailable(format!("diff task failed: {e}")))?
}

/// `read_diff`, as both transports answer it: authorised by tmux on every
/// call, read off the async runtime.
pub async fn read_diff(
    tx: &MonitorCommandSender,
    pane: &PaneId,
    scope: Scope,
) -> Result<DiffRead, CommandError> {
    let dir = authorised(tx, pane).await?;
    blocking(move || read_in(&dir, scope)).await
}

/// `change_hunk`: authorised as a read is, done off the async runtime.
pub async fn change_hunk(
    tx: &MonitorCommandSender,
    pane: &PaneId,
    request: hunk::HunkRequest,
) -> Result<hunk::HunkChanged, CommandError> {
    let dir = authorised(tx, pane).await?;
    blocking(move || hunk::change_in(&dir, &request)).await
}

/// `undo_revert`: only in the checkout the pane shows.
pub async fn undo_revert(
    tx: &MonitorCommandSender,
    pane: &PaneId,
    id: String,
) -> Result<(), CommandError> {
    let dir = authorised(tx, pane).await?;
    blocking(move || hunk::undo_in(&dir, &id)).await
}

/// The top folder of the checkout `dir` is in.
fn checkout_root(dir: &Path, deadline: std::time::Instant) -> Result<PathBuf, CommandError> {
    git::text(dir, &["rev-parse", "--show-toplevel"], deadline)
        .map(|out| PathBuf::from(out.trim()))
        .filter(|root| root.is_absolute())
        .ok_or_else(|| CommandError::invalid(format!("{} is not in a git checkout", dir.display())))
}

/// The changes of the checkout `dir` is in, in `scope`.
pub fn read_in(dir: &Path, scope: Scope) -> Result<DiffRead, CommandError> {
    if !git::available() {
        return Err(CommandError::unavailable(
            "the diff needs git 2.31 or later, which takes its settings from the environment",
        ));
    }
    let deadline = git::deadline();
    let root = checkout_root(dir, deadline)?;
    let head = git::text(
        &root,
        &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
        deadline,
    )
    .map(|out| out.trim().to_string())
    .filter(|sha| !sha.is_empty());
    let branch = git::text(&root, &["symbolic-ref", "-q", "--short", "HEAD"], deadline)
        .map(|out| out.trim().to_string())
        .filter(|name| !name.is_empty());
    let (args, base) = match scope {
        Scope::Unstaged => (vec!["diff-files".to_string()], None),
        Scope::Staged => (
            vec![
                "diff-index".to_string(),
                "--cached".to_string(),
                "-M".to_string(),
                head.clone()
                    .unwrap_or_else(|| git::empty_tree(&root).to_string()),
            ],
            None,
        ),
        Scope::Turn => return read_turn(&root, branch, deadline),
        Scope::Branch => {
            let (base, merge_base) = branch_base(&root, deadline)?;
            (
                vec!["diff-index".to_string(), "-M".to_string(), merge_base],
                Some(base),
            )
        }
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (patch, truncated) = git::patch(None, &root, &args, deadline)
        .ok_or_else(|| CommandError::unavailable("git could not read the changes in time"))?;
    let (untracked, untracked_more) = match scope {
        Scope::Staged | Scope::Turn => (Vec::new(), 0),
        Scope::Unstaged | Scope::Branch => untracked(&root, deadline),
    };
    Ok(DiffRead {
        name: folder_name(&root),
        scope,
        branch,
        base,
        files: patch::parse(&patch),
        untracked,
        untracked_more,
        truncated,
        turn: None,
    })
}

/// The turn scope: the agent's last turn, untracked files in its patch.
fn read_turn(
    root: &Path,
    branch: Option<String>,
    deadline: std::time::Instant,
) -> Result<DiffRead, CommandError> {
    let (patch, truncated, turn) = turn::read(root, deadline)?;
    Ok(DiffRead {
        name: folder_name(root),
        scope: Scope::Turn,
        branch,
        base: None,
        files: patch::parse(&patch),
        untracked: Vec::new(),
        untracked_more: 0,
        truncated,
        turn: Some(turn),
    })
}

/// The checkout's folder name, for the title.
fn folder_name(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The ref a branch is compared with, and the commit it left it at.
fn branch_base(
    root: &Path,
    deadline: std::time::Instant,
) -> Result<(String, String), CommandError> {
    let remote_head = git::text(
        root,
        &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
        deadline,
    )
    .map(|out| out.trim().to_string())
    .filter(|name| !name.is_empty());
    let candidates = remote_head
        .into_iter()
        .chain(["main".to_string(), "master".to_string()]);
    for base in candidates {
        let merge_base = git::text(root, &["merge-base", "HEAD", &base], deadline)
            .map(|out| out.trim().to_string())
            .filter(|sha| !sha.is_empty());
        if let Some(merge_base) = merge_base {
            return Ok((base, merge_base));
        }
    }
    Err(CommandError::invalid(
        "no base to compare the branch with: no origin/HEAD, main or master it shares a commit with",
    ))
}

/// The files git does not track and does not ignore, the first
/// [`MAX_UNTRACKED`] of them, and how many more there are.
fn untracked(root: &Path, deadline: std::time::Instant) -> (Vec<String>, usize) {
    let listed = git::text(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        deadline,
    )
    .unwrap_or_default();
    let mut names: Vec<String> = listed
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(String::from)
        .collect();
    let more = names.len().saturating_sub(MAX_UNTRACKED);
    names.truncate(MAX_UNTRACKED);
    (names, more)
}

#[cfg(test)]
mod tests;
