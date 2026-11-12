//! git for the diff widget: reads only, and runs nothing the repository
//! names. Its settings travel in the environment ([`git_with`]).
//!
//! A checkout's own config can name programs for git to run. None of them
//! may: no filesystem monitor, hook, pager, credential helper or transport
//! ([`READ_ONLY`]); no external diff and no textconv; no content filter (to
//! compare a changed file git first runs the `clean` filter its attributes
//! name, so every filter driver the config holds is switched off, the user's
//! git-lfs included, and such a file is compared as the text it is); no
//! submodule, whose own config git would read. The plumbing commands
//! (`diff-files`, `diff-index`) read the index as it is: the porcelain
//! `git diff` refreshes it and writes it back under `index.lock`, and the
//! user's own commit in that moment would fail on the lock.
//!
//! The environment that would point git elsewhere, or add config, is
//! scrubbed. Every run has a deadline, and a diff's output a cap.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The tree with nothing in it: what a checkout with no commit yet is
/// compared with.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// The longest one read of a checkout is given, every git it runs together.
const READ_LIMIT: Duration = Duration::from_secs(5);

/// The most of a diff one read returns.
const PATCH_CAP: usize = 2 * 1024 * 1024;

/// The most of anything else git prints that is read.
const TEXT_CAP: usize = 1024 * 1024;

/// What every git here runs with. Settings go in the environment
/// (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, git
/// 2.31 and later), never as `-c key=value`: a key can hold `=` (a filter
/// driver can be named `x=y`), and `-c` cuts it there and reads the rest as
/// the value, which left that driver's program in place.
const READ_ONLY: &[(&str, &str)] = &[
    ("core.fsmonitor", "false"),
    ("core.hooksPath", "/dev/null"),
    ("protocol.allow", "never"),
    ("credential.helper", ""),
    ("core.quotePath", "false"),
];

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

/// Variables of the caller's that would aim git at another repository, or
/// give it config or programs of their own.
const SCRUBBED: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_PAGER",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
];

pub fn deadline() -> Instant {
    Instant::now() + READ_LIMIT
}

fn git(dir: &Path, args: &[&str]) -> Command {
    git_with(dir, &[], args)
}

/// [`git`] with `settings` of its own on top of [`READ_ONLY`], all of them in
/// the environment.
fn git_with(dir: &Path, settings: &[(String, String)], args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    for name in SCRUBBED {
        command.env_remove(name);
    }
    let all: Vec<(&str, &str)> = READ_ONLY
        .iter()
        .copied()
        .chain(settings.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .collect();
    command.env("GIT_CONFIG_COUNT", all.len().to_string());
    for (n, (key, value)) in all.into_iter().enumerate() {
        command
            .env(format!("GIT_CONFIG_KEY_{n}"), key)
            .env(format!("GIT_CONFIG_VALUE_{n}"), value);
    }
    command
}

/// Whether this machine's git reads settings from the environment: 2.31 or
/// later. An older one would run with none of them, so no diff is read there.
pub fn takes_settings_from_the_environment() -> bool {
    static ANSWER: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ANSWER.get_or_init(|| {
        let mut version = Command::new("git");
        version.arg("version").env("LC_ALL", "C");
        run(version, Instant::now() + READ_LIMIT, TEXT_CAP)
            .and_then(|(_, out, _)| git_version(&String::from_utf8_lossy(&out)))
            .is_some_and(|version| version >= (2, 31))
    })
}

/// `git version 2.39.5 (Apple Git-154)` as `(2, 39)`.
pub(super) fn git_version(line: &str) -> Option<(u32, u32)> {
    let mut parts = line.trim().strip_prefix("git version ")?.split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    Some((major, minor.parse().ok()?))
}

/// Run `command` until it ends, `deadline` or `cap` bytes of output, reading
/// as it prints so a large output cannot fill the pipe and stall it. Whether
/// it succeeded, what it printed, and whether that was cut at `cap` (git is
/// then ended there); `None` when it could not start or ran past `deadline`.
fn run(mut command: Command, deadline: Instant, cap: usize) -> Option<(bool, Vec<u8>, bool)> {
    if Instant::now() >= deadline {
        return None;
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
        let cut = printed.as_ref().is_some_and(|(out, _)| out.len() > cap);
        match child.try_wait() {
            Ok(Some(status)) => {
                let (mut out, read) = match printed {
                    Some(done) => done,
                    // It has exited, so its end of the pipe is closed and
                    // the reader is about to finish.
                    None => received
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .ok()?,
                };
                let truncated = out.len() > cap;
                out.truncate(cap);
                return Some((status.success() && read, out, truncated));
            }
            Ok(None) if cut => {
                let _ = child.kill();
                let _ = child.wait();
                let (mut out, _) = printed?;
                out.truncate(cap);
                return Some((true, out, true));
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// What `git <args>` printed when it succeeded, as text.
pub fn text(dir: &Path, args: &[&str], deadline: Instant) -> Option<String> {
    let (ok, out, _) = run(git(dir, args), deadline, TEXT_CAP)?;
    ok.then(|| String::from_utf8_lossy(&out).into_owned())
}

/// The name of every content filter driver the checkout's config holds, from
/// any file it reads; listing them runs none. `None` when they cannot be
/// listed: the diff is then not run, since it could run one.
fn filter_drivers(dir: &Path, deadline: Instant) -> Option<Vec<String>> {
    let list = ["config", "-z", "--name-only", "--get-regexp", "^filter\\."];
    // `git config --get-regexp` exits 1 when nothing matches.
    let (_, names, _) = run(git(dir, &list), deadline, TEXT_CAP)?;
    let names = String::from_utf8_lossy(&names);
    let mut drivers: Vec<String> = names
        .split('\0')
        .filter_map(|key| key.strip_prefix("filter."))
        .filter_map(|rest| rest.rsplit_once('.'))
        .map(|(driver, _)| driver.to_string())
        .collect();
    drivers.sort();
    drivers.dedup();
    Some(drivers)
}

/// The patch `git <command>` prints (a `diff-files` or `diff-index`), with
/// [`DIFF_ARGS`] and every content filter switched off, and whether it was
/// cut at its cap. `None` when it failed or ran past `deadline`.
pub fn patch(dir: &Path, command: &[&str], deadline: Instant) -> Option<(String, bool)> {
    let mut settings: Vec<(String, String)> = Vec::new();
    for driver in filter_drivers(dir, deadline)? {
        for (key, value) in [
            ("clean", ""),
            ("smudge", ""),
            ("process", ""),
            ("required", "false"),
        ] {
            settings.push((format!("filter.{driver}.{key}"), value.to_string()));
        }
    }
    let (verb, rest) = command.split_first()?;
    let mut args: Vec<String> = vec![(*verb).to_string()];
    args.extend(DIFF_ARGS.iter().map(|arg| arg.to_string()));
    args.extend(rest.iter().map(|arg| arg.to_string()));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, out, truncated) = run(git_with(dir, &settings, &args), deadline, PATCH_CAP)?;
    ok.then(|| (String::from_utf8_lossy(&out).into_owned(), truncated))
}
