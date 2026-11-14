//! git in a repository tmuxy did not make: the one way tmuxy runs it there.
//!
//! tmuxy runs git in directories the user merely stands in (the tree's
//! branch and changes, a worktree's state, a diff), and a repository can
//! arrive with its own `.git` whose config and attributes name programs for
//! git to run. None of them may run:
//!
//!   * no hooks, filesystem monitor, pager, external diff, credential helper
//!     or askpass, and no transport at all, so nothing is fetched and no ssh
//!     command is reached;
//!   * no attributes but the repository's private `info/attributes`: the
//!     work tree's `.gitattributes` are read from the empty tree, the
//!     user's and the system's not at all. And every content filter driver
//!     the config names is switched off ([`filters_off`]), for what
//!     `info/attributes` can still name. Reading from a tree takes git 2.41
//!     (`GIT_ATTR_SOURCE`): from 2.31 to 2.40 the work tree's
//!     `.gitattributes` are read too, and [`filters_off`] and the caller's
//!     diff options are what hold;
//!   * no optional locks: a read must not take `index.lock` from under the
//!     user's own `git commit`;
//!   * stdin closed, a deadline on every call, and a cap on what is read.
//!
//! Settings go in the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
//! `GIT_CONFIG_VALUE_<n>`), never as `-c key=value`: a key can hold `=` (a
//! driver can be named `x=y`), and `-c` cuts it there. That takes git 2.31,
//! and [`available`] says whether this machine's has it: an older git would
//! run with none of the settings, so nothing here runs it.
//!
//! What a command adds of its own (`--no-ext-diff`, `--no-textconv`,
//! `--ignore-submodules=all` for a diff) is the caller's: they are options
//! of commands, not settings.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The tree with nothing in it, in a SHA-1 repository and in a SHA-256 one:
/// attributes read from it are none at all, and a checkout with no commit
/// yet is compared with it. [`empty_tree`] says which a repository uses.
const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// The settings every call runs with.
const SETTINGS: &[(&str, &str)] = &[
    ("core.fsmonitor", "false"),
    ("core.hooksPath", "/dev/null"),
    ("core.pager", "cat"),
    ("core.askPass", ""),
    ("core.sshCommand", "false"),
    ("core.attributesFile", "/dev/null"),
    ("diff.external", ""),
    ("credential.helper", ""),
    ("protocol.allow", "never"),
    ("submodule.recurse", "false"),
    ("log.showSignature", "false"),
    ("gpg.program", ""),
    ("gpg.ssh.program", ""),
    ("gpg.x509.program", ""),
];

/// Variables of the caller's that would aim git at another repository, or
/// give it settings or programs of its own.
const SCRUBBED: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_PAGER",
    "PAGER",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
];

/// git rooted at `dir`, running `args` with every setting above, and
/// `extra` settings of the caller's on top (later ones win). Attributes come
/// from the empty tree of `dir`'s repository ([`empty_tree`]).
pub fn command(dir: &Path, extra: &[(String, String)], args: &[&str]) -> Command {
    let tree = empty_tree(dir);
    let mut command = base(dir, extra, args);
    command.env("GIT_ATTR_SOURCE", tree);
    with_setting(&mut command, "attr.tree", tree);
    command
}

/// The empty tree of the repository `dir` is in: SHA-256's in a SHA-256
/// repository, SHA-1's otherwise (and outside any repository, where nothing
/// reads attributes). A SHA-1 tree named in a SHA-256 repository is no tree
/// at all, and git then refuses every command that reads attributes. Asked
/// once a directory.
pub fn empty_tree(dir: &Path) -> &'static str {
    static FORMATS: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let formats = FORMATS.get_or_init(Default::default);
    if let Some(&sha256) = formats
        .lock()
        .ok()
        .and_then(|f| f.get(dir).copied())
        .as_ref()
    {
        return if sha256 {
            EMPTY_TREE_SHA256
        } else {
            EMPTY_TREE_SHA1
        };
    }
    let asked = base(dir, &[], &["rev-parse", "--show-object-format"]);
    let sha256 = run(asked, Instant::now() + Duration::from_secs(2), 64)
        .is_some_and(|said| said.success && said.stdout.starts_with(b"sha256"));
    if let Ok(mut f) = formats.lock() {
        f.insert(dir.to_path_buf(), sha256);
    }
    if sha256 {
        EMPTY_TREE_SHA256
    } else {
        EMPTY_TREE_SHA1
    }
}

/// One more setting on a [`base`] command, numbered after the others, so it
/// wins over any before it.
pub(crate) fn with_setting(command: &mut Command, key: &str, value: &str) {
    let count: usize = command
        .get_envs()
        .find(|(k, _)| *k == "GIT_CONFIG_COUNT")
        .and_then(|(_, v)| v?.to_str()?.parse().ok())
        .unwrap_or(0);
    command
        .env(format!("GIT_CONFIG_KEY_{count}"), key)
        .env(format!("GIT_CONFIG_VALUE_{count}"), value)
        .env("GIT_CONFIG_COUNT", (count + 1).to_string());
}

/// [`command`] without the attribute source: what asking a repository for
/// its object format runs with.
fn base(dir: &Path, extra: &[(String, String)], args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .stdin(Stdio::null());
    for name in SCRUBBED {
        command.env_remove(name);
    }
    let all: Vec<(&str, &str)> = SETTINGS
        .iter()
        .copied()
        .chain(extra.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .collect();
    command.env("GIT_CONFIG_COUNT", all.len().to_string());
    for (n, (key, value)) in all.into_iter().enumerate() {
        command
            .env(format!("GIT_CONFIG_KEY_{n}"), key)
            .env(format!("GIT_CONFIG_VALUE_{n}"), value);
    }
    command
}

/// The settings that switch off every content filter driver the
/// repository's config names, whatever its name holds.
pub fn filters_off(dir: &Path, deadline: Instant) -> Option<Vec<(String, String)>> {
    let list = ["config", "-z", "--name-only", "--get-regexp", "^filter\\."];
    // `git config --get-regexp` exits 1 when nothing matches: no drivers.
    let said = run(command(dir, &[], &list), deadline, 64 * 1024)?;
    if said.cut {
        return None;
    }
    let mut drivers: Vec<String> = String::from_utf8_lossy(&said.stdout)
        .split('\0')
        .filter_map(|key| key.strip_prefix("filter."))
        .filter_map(|rest| rest.rsplit_once('.'))
        .map(|(driver, _)| driver.to_string())
        .collect();
    drivers.sort();
    drivers.dedup();
    Some(
        drivers
            .into_iter()
            .flat_map(|driver| {
                [
                    ("clean", ""),
                    ("smudge", ""),
                    ("process", ""),
                    ("required", "false"),
                ]
                .map(|(key, value)| (format!("filter.{driver}.{key}"), value.to_string()))
            })
            .collect(),
    )
}

/// What a git call said.
#[derive(Debug)]
pub struct Said {
    pub success: bool,
    pub stdout: Vec<u8>,
    /// The output went past the cap: git was ended there, and `stdout` is
    /// its first `cap` bytes.
    pub cut: bool,
}

/// Run `command` until it ends, `deadline` or `cap` bytes of output, reading
/// as it prints so a large output cannot stall it on a full pipe. `None`
/// when git is too old for the settings ([`available`]), could not start, or
/// ran past `deadline`, where it is ended.
pub fn run(mut command: Command, deadline: Instant, cap: usize) -> Option<Said> {
    if !available() || Instant::now() >= deadline {
        return None;
    }
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let read = stdout.take(cap as u64 + 1).read_to_end(&mut out).is_ok();
        let _ = sender.send((out, read));
    });
    let mut printed: Option<(Vec<u8>, bool)> = None;
    loop {
        if printed.is_none() {
            printed = received.try_recv().ok();
        }
        let over = printed.as_ref().is_some_and(|(out, _)| out.len() > cap);
        match child.try_wait() {
            Ok(Some(status)) => {
                let (mut out, read) = match printed {
                    Some(done) => done,
                    None => received
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .ok()?,
                };
                let cut = out.len() > cap;
                out.truncate(cap);
                return Some(Said {
                    success: status.success() && read,
                    stdout: out,
                    cut,
                });
            }
            Ok(None) if over => {
                let _ = child.kill();
                let _ = child.wait();
                let (mut out, _) = printed?;
                out.truncate(cap);
                return Some(Said {
                    success: false,
                    stdout: out,
                    cut: true,
                });
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Whether this machine's git takes settings from the environment: 2.31 or
/// later. Asked once.
pub fn available() -> bool {
    static ANSWER: OnceLock<bool> = OnceLock::new();
    *ANSWER.get_or_init(|| {
        Command::new("git")
            .arg("version")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .output()
            .ok()
            .and_then(|out| version(&String::from_utf8_lossy(&out.stdout)))
            .is_some_and(|v| v >= (2, 31))
    })
}

/// `git version 2.39.5 (Apple Git-154)` as `(2, 39)`.
fn version(line: &str) -> Option<(u32, u32)> {
    let mut parts = line.trim().strip_prefix("git version ")?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    Some((major, minor.parse().ok()?))
}

#[cfg(test)]
mod tests;
