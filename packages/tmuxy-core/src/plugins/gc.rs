//! Removing checkouts nothing needs any more.
//!
//! `update` installs the new commit beside the old one rather than over it,
//! so an action still running from the old directory keeps its files. A
//! checkout is deleted only once the lockfile no longer names it **and** no
//! process has its working directory or executable inside it. Run after
//! `update` and `remove`, and when a server starts.

use std::path::{Path, PathBuf};

use super::is_sha;
use super::lockfile::{EntrySource, Lockfile};
use crate::paths::Layout;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Collected {
    pub removed: Vec<PathBuf>,
    /// Unused by the lockfile but still running; kept for the next run.
    pub busy: Vec<PathBuf>,
}

fn is_checkout_name(name: &str) -> bool {
    name.split_once('@')
        .is_some_and(|(plugin, sha)| super::is_valid_name(plugin) && is_sha(sha))
}

/// Remove every checkout the lockfile does not name and no process uses,
/// and stale staging leftovers.
pub fn collect(dirs: &Layout) -> Collected {
    let mut collected = Collected::default();
    let Ok(lock) = Lockfile::load(dirs) else {
        // An unreadable lockfile would keep nothing: remove nothing.
        return collected;
    };
    let keep: std::collections::HashSet<PathBuf> = lock
        .plugins
        .iter()
        .filter_map(|e| match e.source() {
            Ok(EntrySource::Repo { sha, .. }) => Some(dirs.checkout(&e.name, &sha)),
            _ => None,
        })
        .collect();
    let Ok(entries) = std::fs::read_dir(dirs.plugins_root()) else {
        return collected;
    };
    let candidates: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_str().is_some_and(is_checkout_name))
        .map(|e| e.path())
        .filter(|p| !keep.contains(p))
        .collect();
    if candidates.is_empty() {
        return collected;
    }
    let in_use = paths_in_use();
    for dir in candidates {
        if in_use.iter().any(|p| p.starts_with(&dir)) || lsof_says_busy(&dir) {
            collected.busy.push(dir);
        } else if std::fs::remove_dir_all(&dir).is_ok() {
            collected.removed.push(dir);
        }
    }
    collected
}

/// Clear what a crashed or abandoned launch left: staging checkouts and
/// invocation tokens.
pub fn clear_transient(dirs: &Layout) {
    let _ = std::fs::remove_dir_all(dirs.staging());
    let _ = std::fs::remove_dir_all(dirs.run_dir());
}

/// What a server or the desktop app does as it starts: a launch that never
/// ran left its token, an update its staging checkout, and a replaced
/// commit's checkout goes once nothing runs from it.
pub fn on_start() {
    let dirs = Layout::current();
    clear_transient(&dirs);
    collect(&dirs);
}

/// Every process's working directory and executable (Linux `/proc`).
fn paths_in_use() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return paths;
    };
    for entry in procs.filter_map(|e| e.ok()) {
        let pid = entry.path();
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        for link in ["cwd", "exe"] {
            if let Ok(target) = std::fs::read_link(pid.join(link)) {
                paths.push(target);
            }
        }
    }
    paths
}

/// Where there is no `/proc` (macOS), ask `lsof` whether anything has files
/// open under `dir`. Without `lsof` the answer is "busy": a checkout kept
/// too long costs disk, one removed too early breaks a running action.
fn lsof_says_busy(dir: &Path) -> bool {
    if Path::new("/proc/self").exists() {
        return false;
    }
    match std::process::Command::new("lsof")
        .args(["-t", "+D"])
        .arg(dir)
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(out) => !out.stdout.is_empty(),
        Err(_) => true,
    }
}
