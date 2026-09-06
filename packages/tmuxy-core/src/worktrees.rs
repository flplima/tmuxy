//! Read-only Git worktree discovery for tmux pane working directories.
//!
//! The paths come from tmux's own `#{pane_current_path}` listing, gathered by
//! the host (`paths_from_pane_listing`) — never from a client, which on the web
//! would let anyone reaching the server probe the filesystem through git.
//! Discovery deliberately has no ambient filesystem fallback: an empty input
//! means there is nothing to inspect. A repository that git cannot read
//! (dubious ownership, permissions) is skipped with a warning rather than
//! taking every other repository's result down with it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use thiserror::Error;

/// Hard limit for one discovery request. tmux provides one path per pane, so
/// this is comfortably above normal use while bounding filesystem/Git work.
pub const MAX_DISCOVERY_PATHS: usize = 256;

/// The tmux listing whose output feeds discovery: one pane cwd per line.
pub const LIST_PANE_PATHS_CMD: &str = "list-panes -a -F '#{pane_current_path}'";

/// The distinct, non-empty paths in a `LIST_PANE_PATHS_CMD` listing, in
/// order, capped at `MAX_DISCOVERY_PATHS` so a runaway pane count bounds the
/// git work rather than failing it.
pub fn paths_from_pane_listing(listing: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| seen.insert(line.to_string()))
        .take(MAX_DISCOVERY_PATHS)
        .map(str::to_string)
        .collect()
}

pub type WorktreeDiscoveryResult<T> = std::result::Result<T, WorktreeDiscoveryError>;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorktreeDiscoveryError {
    #[error("worktree discovery accepts at most {max} paths (received {count})")]
    TooManyPaths { count: usize, max: usize },
    #[error("failed to execute git {operation} in {}: {message}", path.display())]
    GitProcess {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
    #[error("git {operation} failed in {}: {message}", path.display())]
    GitCommandFailed {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
    #[error("invalid git {operation} output in {}: {message}", path.display())]
    InvalidGitOutput {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    pub id: String,
    pub name: String,
    pub root: Option<String>,
    pub worktrees: Vec<GitWorktree>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ParsedWorktree {
    path: PathBuf,
    branch: Option<String>,
    head: String,
    detached: bool,
    bare: bool,
    locked: bool,
    prunable: bool,
}

/// Discover the repositories containing the supplied pane paths.
///
/// Canonical input directories are de-duplicated before the first Git
/// subprocess. Each repository is then inspected once, even when distinct
/// pane directories belong to it. SSH pane paths are remote paths, so local
/// Git discovery is skipped for an SSH-backed tmux connection.
pub fn list_git_worktrees(paths: Vec<String>) -> WorktreeDiscoveryResult<Vec<GitRepository>> {
    if paths.len() > MAX_DISCOVERY_PATHS {
        return Err(WorktreeDiscoveryError::TooManyPaths {
            count: paths.len(),
            max: MAX_DISCOVERY_PATHS,
        });
    }
    if paths.is_empty() || crate::session::ssh_target().is_some() {
        return Ok(Vec::new());
    }

    let candidates = canonical_input_directories(paths);
    let mut seen_common_dirs = HashSet::new();
    let mut repositories = Vec::new();

    for search_path in candidates {
        // One unreadable repository must not blank every other badge: skip it.
        let common_dir = match git_common_dir(&search_path) {
            Ok(Some(dir)) => dir,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(%error, "skipping pane path in worktree discovery");
                continue;
            }
        };
        if !seen_common_dirs.insert(common_dir.clone()) {
            continue;
        }
        match discover_repository(&search_path, &common_dir) {
            Ok(repository) => repositories.push(repository),
            Err(error) => tracing::warn!(%error, "skipping repository in worktree discovery"),
        }
    }

    repositories.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(repositories)
}

fn canonical_input_directories(paths: Vec<String>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut directories = Vec::new();
    for path in paths.into_iter().filter(|path| !path.trim().is_empty()) {
        let Some(directory) = existing_directory(Path::new(&path)) else {
            continue;
        };
        if seen.insert(directory.clone()) {
            directories.push(directory);
        }
    }
    directories
}

fn existing_directory(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    if canonical.is_dir() {
        Some(canonical)
    } else {
        canonical.parent().map(Path::to_path_buf)
    }
}

/// A git subprocess rooted at `path`, with the environment that would
/// redirect it elsewhere scrubbed: a `GIT_DIR` or `GIT_WORK_TREE` inherited
/// from the host process would make every pane report that one repository.
fn git(path: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(path)
        .args(args)
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR");
    command
}

fn git_common_dir(path: &Path) -> WorktreeDiscoveryResult<Option<PathBuf>> {
    let output = git(path, &["rev-parse", "--git-common-dir"])
        .output()
        .map_err(|error| WorktreeDiscoveryError::GitProcess {
            operation: "rev-parse",
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
    if !output.status.success() {
        // A pane cwd outside Git is expected. Other failures (dubious
        // ownership, permissions, transient I/O) must remain visible so the
        // UI keeps its previous repository snapshot instead of replacing it.
        if is_not_git_repository(&output.stderr) {
            return Ok(None);
        }
        return Err(WorktreeDiscoveryError::GitCommandFailed {
            operation: "rev-parse",
            path: path.to_path_buf(),
            message: git_failure_message(&output),
        });
    }

    // Git appends one record terminator. Remove only that byte so legitimate
    // leading/trailing whitespace in a repository path is preserved.
    let raw = output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout);
    if raw.is_empty() {
        return Err(WorktreeDiscoveryError::InvalidGitOutput {
            operation: "rev-parse",
            path: path.to_path_buf(),
            message: "empty common directory".to_string(),
        });
    }
    let common_dir = path_from_git_bytes(raw);
    let absolute = if common_dir.is_absolute() {
        common_dir
    } else {
        path.join(common_dir)
    };
    fs::canonicalize(&absolute).map(Some).map_err(|error| {
        WorktreeDiscoveryError::InvalidGitOutput {
            operation: "rev-parse",
            path: path.to_path_buf(),
            message: format!("cannot canonicalize {}: {error}", absolute.display()),
        }
    })
}

fn discover_repository(
    search_path: &Path,
    common_dir: &Path,
) -> WorktreeDiscoveryResult<GitRepository> {
    let records = worktree_porcelain(search_path)?;

    let mut root = None;
    let mut worktrees = Vec::new();
    for (index, parsed) in parse_worktree_porcelain(&records).into_iter().enumerate() {
        let is_main = index == 0 && !parsed.bare;
        let path = fs::canonicalize(&parsed.path)
            .unwrap_or(parsed.path)
            .to_string_lossy()
            .into_owned();
        if is_main {
            root = Some(path.clone());
        }
        let branch = if parsed.bare || parsed.detached {
            None
        } else {
            parsed.branch.as_deref().map(normalize_branch)
        };
        worktrees.push(GitWorktree {
            path,
            branch,
            head: parsed.head,
            is_main,
            detached: parsed.detached,
            bare: parsed.bare,
            locked: parsed.locked,
            prunable: parsed.prunable,
        });
    }
    if worktrees.is_empty() {
        return Err(WorktreeDiscoveryError::InvalidGitOutput {
            operation: "worktree list",
            path: search_path.to_path_buf(),
            message: "no worktree records".to_string(),
        });
    }
    worktrees.sort_by(|a, b| b.is_main.cmp(&a.is_main).then_with(|| a.path.cmp(&b.path)));

    Ok(GitRepository {
        id: common_dir.to_string_lossy().into_owned(),
        name: repository_name(root.as_deref(), common_dir),
        root,
        worktrees,
    })
}

/// `git worktree list --porcelain` output in the NUL-terminated layout the
/// parser reads: fields end in NUL and a record ends in an extra NUL. That is
/// what `-z` prints on git >= 2.36; an older git rejects the flag, so the
/// newline layout is fetched instead and mapped onto the same shape (a blank
/// line becoming the empty field that closes a record).
fn worktree_porcelain(search_path: &Path) -> WorktreeDiscoveryResult<Vec<u8>> {
    let run = |args: &[&str]| {
        git(search_path, args)
            .output()
            .map_err(|error| WorktreeDiscoveryError::GitProcess {
                operation: "worktree list",
                path: search_path.to_path_buf(),
                message: error.to_string(),
            })
    };
    let output = run(&["worktree", "list", "--porcelain", "-z"])?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    if !rejects_z_flag(&output.stderr) {
        return Err(WorktreeDiscoveryError::GitCommandFailed {
            operation: "worktree list",
            path: search_path.to_path_buf(),
            message: git_failure_message(&output),
        });
    }
    let output = run(&["worktree", "list", "--porcelain"])?;
    if !output.status.success() {
        return Err(WorktreeDiscoveryError::GitCommandFailed {
            operation: "worktree list",
            path: search_path.to_path_buf(),
            message: git_failure_message(&output),
        });
    }
    Ok(newline_porcelain_as_nul(&output.stdout))
}

/// Older git (< 2.36, e.g. Ubuntu 22.04's 2.34) has no `-z` for this command.
fn rejects_z_flag(stderr: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stderr);
    text.contains("unknown switch") || text.contains("unknown option") || text.contains("usage:")
}

fn newline_porcelain_as_nul(stdout: &[u8]) -> Vec<u8> {
    stdout
        .iter()
        .map(|byte| if *byte == b'\n' { 0 } else { *byte })
        .collect()
}

fn is_not_git_repository(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).lines().any(|line| {
        line.starts_with("fatal: not a git repository (or any of the parent directories):")
            || line.starts_with("fatal: not a git repository (or any parent up to mount point ")
    })
}

fn git_failure_message(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        output.status.to_string()
    } else {
        stderr.trim().to_string()
    }
}

#[cfg(unix)]
fn path_from_git_bytes(bytes: &[u8]) -> PathBuf {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    PathBuf::from(OsString::from_vec(bytes.to_vec()))
}

#[cfg(not(unix))]
fn path_from_git_bytes(bytes: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
}

fn repository_name(root: Option<&str>, common_dir: &Path) -> String {
    root.and_then(|path| Path::new(path).file_name())
        .or_else(|| {
            if common_dir.file_name().and_then(|name| name.to_str()) == Some(".git") {
                common_dir.parent().and_then(Path::file_name)
            } else {
                common_dir.file_name()
            }
        })
        .map(|name| {
            let name = name.to_string_lossy();
            name.strip_suffix(".git").unwrap_or(&name).to_string()
        })
        .unwrap_or_else(|| common_dir.to_string_lossy().into_owned())
}

fn parse_worktree_porcelain(input: &[u8]) -> Vec<ParsedWorktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<ParsedWorktree> = None;

    for field in input.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
        } else if let Some(path) = field.strip_prefix(b"worktree ") {
            if let Some(worktree) = current.replace(ParsedWorktree {
                path: path_from_git_bytes(path),
                ..ParsedWorktree::default()
            }) {
                worktrees.push(worktree);
            }
        } else if let Some(worktree) = current.as_mut() {
            if let Some(head) = field.strip_prefix(b"HEAD ") {
                worktree.head = String::from_utf8_lossy(head).into_owned();
            } else if let Some(branch) = field.strip_prefix(b"branch ") {
                worktree.branch = Some(String::from_utf8_lossy(branch).into_owned());
            } else if field == b"detached" {
                worktree.detached = true;
            } else if field == b"bare" {
                worktree.bare = true;
            } else if field == b"locked" || field.starts_with(b"locked ") {
                worktree.locked = true;
            } else if field == b"prunable" || field.starts_with(b"prunable ") {
                worktree.prunable = true;
            }
        }
    }
    if let Some(worktree) = current {
        worktrees.push(worktree);
    }
    worktrees
}

fn normalize_branch(branch: &str) -> String {
    branch
        .strip_prefix("refs/heads/")
        .or_else(|| branch.strip_prefix("refs/remotes/"))
        .or_else(|| branch.strip_prefix("refs/tags/"))
        .unwrap_or(branch)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_paths_never_fall_back_to_an_ambient_scan() {
        assert_eq!(list_git_worktrees(Vec::new()), Ok(Vec::new()));
    }

    #[test]
    fn rejects_requests_over_the_documented_path_limit() {
        let paths = vec!["/same/path".to_string(); MAX_DISCOVERY_PATHS + 1];

        assert_eq!(
            list_git_worktrees(paths),
            Err(WorktreeDiscoveryError::TooManyPaths {
                count: MAX_DISCOVERY_PATHS + 1,
                max: MAX_DISCOVERY_PATHS,
            })
        );
    }

    #[test]
    fn canonical_input_paths_are_deduplicated_before_git_runs() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let cargo_toml = manifest_dir.join("Cargo.toml");
        let with_parent_component = manifest_dir.join("src").join("..");
        let directories = canonical_input_directories(vec![
            manifest_dir.to_string_lossy().into_owned(),
            cargo_toml.to_string_lossy().into_owned(),
            with_parent_component.to_string_lossy().into_owned(),
        ]);
        let Ok(canonical_manifest_dir) = fs::canonicalize(manifest_dir) else {
            panic!("manifest directory should canonicalize");
        };

        assert_eq!(directories, vec![canonical_manifest_dir]);
    }

    #[test]
    fn pane_listing_paths_are_deduplicated_trimmed_and_capped() {
        let listing = "/repo\n/repo\n  /other  \n\n/third\n";
        assert_eq!(
            paths_from_pane_listing(listing),
            ["/repo", "/other", "/third"]
        );

        let many: String = (0..MAX_DISCOVERY_PATHS + 5)
            .map(|i| format!("/p{i}\n"))
            .collect();
        assert_eq!(paths_from_pane_listing(&many).len(), MAX_DISCOVERY_PATHS);
    }

    #[test]
    fn newline_porcelain_maps_onto_the_nul_layout() {
        let newline = b"worktree /repos/project\nHEAD abc\nbranch refs/heads/main\n\n";
        let parsed = parse_worktree_porcelain(&newline_porcelain_as_nul(newline));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, PathBuf::from("/repos/project"));
        assert_eq!(parsed[0].branch.as_deref(), Some("refs/heads/main"));
    }

    #[test]
    fn an_old_git_rejecting_z_is_told_apart_from_a_real_failure() {
        assert!(rejects_z_flag(
            b"error: unknown switch `z'\nusage: git worktree list"
        ));
        assert!(!rejects_z_flag(
            b"fatal: detected dubious ownership in repository at '/repo'\n"
        ));
    }

    #[test]
    fn a_path_outside_git_and_an_unreadable_one_are_skipped_not_fatal() {
        // A directory that is certainly not inside a repository, plus a path
        // that does not exist: neither may fail the whole discovery.
        let outside = std::env::temp_dir().to_string_lossy().into_owned();
        let missing = "/definitely/not/a/real/path/for/tmuxy".to_string();
        let result = list_git_worktrees(vec![outside, missing]);
        assert!(result.is_ok());
    }

    #[test]
    fn only_classifies_the_standard_non_repository_failure_as_a_skip() {
        assert!(is_not_git_repository(
            b"fatal: not a git repository (or any of the parent directories): .git\n"
        ));
        assert!(is_not_git_repository(
            b"fatal: not a git repository (or any parent up to mount point /)\n\
Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n"
        ));
        assert!(!is_not_git_repository(
            b"fatal: detected dubious ownership in repository at '/repo'\n"
        ));
        assert!(!is_not_git_repository(
            b"fatal: cannot open '.git/FETCH_HEAD': Permission denied\n"
        ));
        assert!(!is_not_git_repository(b""));
    }

    #[test]
    fn parses_worktree_porcelain_records_and_flags() {
        let parsed = parse_worktree_porcelain(
            b"worktree /repos/project\0\
HEAD 0123456789abcdef\0\
branch refs/heads/main\0\0\
worktree /repos/project-feature\0\
HEAD fedcba9876543210\0\
branch refs/heads/feature/nested\0\
locked checked out by automation\0\0\
worktree /repos/project-old\0\
HEAD aaaaaaaaaaaaaaaa\0\
detached\0\
prunable gitdir file points to non-existent location\0\0",
        );

        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, PathBuf::from("/repos/project"));
        assert_eq!(
            parsed[1].branch.as_deref(),
            Some("refs/heads/feature/nested")
        );
        assert!(parsed[1].locked);
        assert!(parsed[2].detached);
        assert!(parsed[2].prunable);
    }

    #[test]
    fn parser_flushes_a_record_without_a_blank_separator() {
        let parsed = parse_worktree_porcelain(
            b"worktree /one\0HEAD abc\0branch refs/heads/main\0\
worktree /two\0HEAD def\0detached\0",
        );

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].path, PathBuf::from("/two"));
        assert!(parsed[1].detached);
    }

    #[test]
    fn nul_parser_preserves_newlines_tabs_and_spaces_in_paths() {
        let parsed = parse_worktree_porcelain(
            b"worktree /repos/line\nwith\ttabs and spaces \0\
HEAD abc\0branch refs/heads/main\0\0",
        );

        assert_eq!(
            parsed[0].path,
            PathBuf::from("/repos/line\nwith\ttabs and spaces ")
        );
    }

    #[test]
    fn normalizes_common_branch_refs() {
        assert_eq!(normalize_branch("refs/heads/main"), "main");
        assert_eq!(
            normalize_branch("refs/heads/feature/worktree-tree"),
            "feature/worktree-tree"
        );
        assert_eq!(normalize_branch("refs/remotes/origin/main"), "origin/main");
        assert_eq!(normalize_branch("refs/tags/v1.0.0"), "v1.0.0");
    }

    #[test]
    fn serializes_the_frontend_wire_shape_in_camel_case() {
        let Ok(value) = serde_json::to_value(GitWorktree {
            path: "/repo".to_string(),
            branch: Some("main".to_string()),
            head: "abc".to_string(),
            is_main: true,
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
        }) else {
            panic!("worktree should serialize");
        };

        assert_eq!(value["isMain"], true);
        assert_eq!(value["detached"], false);
        assert_eq!(value["bare"], false);
        assert!(value.get("is_main").is_none());
    }

    #[test]
    fn omits_branch_for_detached_or_bare_worktrees() {
        let Ok(value) = serde_json::to_value(GitWorktree {
            path: "/repo".to_string(),
            branch: None,
            head: "abc".to_string(),
            is_main: false,
            detached: true,
            bare: false,
            locked: false,
            prunable: false,
        }) else {
            panic!("worktree should serialize");
        };

        assert!(value.get("branch").is_none());
        assert_eq!(value["detached"], true);
    }
}
