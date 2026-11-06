//! Fetching a plugin's code without running any of it.
//!
//! A repository can carry code git runs on its own: hooks, a `.gitattributes`
//! filter (`git-lfs`'s smudge is one), an fsmonitor, submodules from anywhere,
//! and symlinks that point out of the checkout. A user's or the system's git
//! config can add more (`url.<x>.insteadOf`, a credential helper). Every git
//! call here runs with all of that switched off, so the first plugin code that
//! runs is a command the user approved at the gate:
//!
//! - no system or global config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`),
//!   no `GIT_*` from the caller's environment, no terminal prompt;
//! - HTTPS only (`protocol.allow=never`, then `https` allowed);
//! - hooks and fsmonitor pointed nowhere, LFS filters emptied and not
//!   required, symlinks checked out as plain files, no submodules;
//! - a fresh repository with no template, fetched at exactly the commit the
//!   gate shows (`fetch --depth 1 <sha>`), checked to be that commit after
//!   checkout, and its `.git` dropped.

use std::path::Path;
use std::process::{Command, Output};

use super::{is_sha, PluginError, Result};

fn git() -> Command {
    let mut cmd = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "");
    for setting in [
        "protocol.allow=never",
        "protocol.https.allow=always",
        "core.hooksPath=/dev/null",
        "core.fsmonitor=false",
        "core.symlinks=false",
        "filter.lfs.smudge=",
        "filter.lfs.process=",
        "filter.lfs.required=false",
        "submodule.recurse=false",
        "credential.helper=",
        "init.defaultBranch=main",
        "advice.detachedHead=false",
    ] {
        cmd.args(["-c", setting]);
    }
    // The test suites' local repositories (`TMUXY_PLUGIN_GIT_BASE`). Only a
    // base that is itself a local path or `file://` URL turns the file
    // protocol on.
    let base = super::source::git_base();
    if base.starts_with("file://") || base.starts_with('/') {
        cmd.args(["-c", "protocol.file.allow=always"]);
    }
    cmd
}

fn run(step: &str, cmd: &mut Command) -> Result<Output> {
    let output = cmd.output().map_err(|e| PluginError::Git {
        step: step.to_string(),
        message: if e.kind() == std::io::ErrorKind::NotFound {
            "git is not installed".to_string()
        } else {
            e.to_string()
        },
    })?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(PluginError::Git {
            step: step.to_string(),
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

/// The commit `git_ref` names on the remote, or its default branch's head.
/// A full sha is taken as it is.
pub fn resolve_ref(url: &str, git_ref: Option<&str>) -> Result<String> {
    if let Some(r) = git_ref {
        if is_sha(r) {
            return Ok(r.to_string());
        }
    }
    let mut cmd = git();
    cmd.args(["ls-remote", "--", url]);
    match git_ref {
        Some(r) => cmd.args([
            format!("refs/heads/{r}"),
            format!("refs/tags/{r}"),
            format!("refs/tags/{r}^{{}}"),
        ]),
        None => cmd.args(["HEAD".to_string()]),
    };
    let output = run("ls-remote", &mut cmd)?;
    let listing = String::from_utf8_lossy(&output.stdout);
    let refs: Vec<(&str, &str)> = listing
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .filter(|(sha, _)| is_sha(sha))
        .collect();
    let pick = |want: &str| refs.iter().find(|(_, name)| *name == want).map(|(s, _)| *s);
    let sha = match git_ref {
        // A peeled annotated tag names the commit; the tag object does not.
        Some(r) => pick(&format!("refs/tags/{r}^{{}}"))
            .or_else(|| pick(&format!("refs/tags/{r}")))
            .or_else(|| pick(&format!("refs/heads/{r}"))),
        None => pick("HEAD"),
    };
    sha.map(str::to_string).ok_or_else(|| {
        PluginError::NotFound(match git_ref {
            Some(r) => format!("{url} has no branch or tag {r:?}"),
            None => format!("{url} has no default branch"),
        })
    })
}

/// Fetch `sha` from `url` into `dest` (which must not exist), check it out
/// and drop the repository metadata. `dest` is removed again on failure.
pub fn fetch(url: &str, sha: &str, dest: &Path) -> Result<()> {
    if !is_sha(sha) {
        return Err(PluginError::Invalid(format!(
            "{sha:?} is not a 40-hex commit"
        )));
    }
    let result = fetch_into(url, sha, dest);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dest);
    }
    result
}

fn fetch_into(url: &str, sha: &str, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        super::private_dir(parent)?;
    }
    run("init", git().args(["init", "-q", "--template="]).arg(dest))?;
    run(
        "fetch",
        git().arg("-C").arg(dest).args([
            "fetch",
            "-q",
            "--depth",
            "1",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            url,
            sha,
        ]),
    )?;
    run(
        "checkout",
        git()
            .arg("-C")
            .arg(dest)
            .args(["checkout", "-q", "--detach", "FETCH_HEAD"]),
    )?;
    let head = run(
        "rev-parse",
        git().arg("-C").arg(dest).args(["rev-parse", "HEAD"]),
    )?;
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head != sha {
        return Err(PluginError::Git {
            step: "verify".into(),
            message: format!("checked out {head}, expected {sha}"),
        });
    }
    let git_dir = dest.join(".git");
    let meta = std::fs::symlink_metadata(&git_dir)
        .map_err(|e| PluginError::io(format!("reading {}", git_dir.display()), e))?;
    if !meta.is_dir() {
        return Err(PluginError::Git {
            step: "verify".into(),
            message: ".git is not a directory".into(),
        });
    }
    std::fs::remove_dir_all(&git_dir)
        .map_err(|e| PluginError::io(format!("removing {}", git_dir.display()), e))?;
    reject_symlinks(dest)
}

/// Fail on any symlink under `dir`. `core.symlinks=false` already checks
/// symlinks out as plain files; this is the check that it did.
pub fn reject_symlinks(dir: &Path) -> Result<()> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| PluginError::io(format!("reading {}", dir.display()), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| PluginError::io(format!("reading {}", dir.display()), e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| PluginError::io(format!("reading {}", entry.path().display()), e))?;
        if file_type.is_symlink() {
            return Err(PluginError::Invalid(format!(
                "{} is a symlink; plugins may not ship any",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            reject_symlinks(&entry.path())?;
        }
    }
    Ok(())
}
