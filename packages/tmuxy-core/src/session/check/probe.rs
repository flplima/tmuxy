//! The tmux a config check asks: started for each question, on a socket of
//! its own, and gone when the question is answered.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{ConfigProblem, ProblemKind};
use crate::paths::{self, Layout};

/// How long the throwaway tmux may take over one question.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether `command` succeeded, or `None` when it could not be run or has not
/// ended within `limit`; it is killed then. What it prints goes wherever the
/// caller pointed it: never down a pipe read here, which a process the
/// command leaves behind (a tmux server) would hold open.
fn status_within(mut command: Command, limit: Duration) -> Option<bool> {
    let mut child = command.stdin(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
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

/// A tmux server for questions about a config: started by each question on a
/// socket of its own, with no config (`-f /dev/null`), and gone when the
/// question is answered — a server with no session exits with its client,
/// and the probe kills whatever is left on the socket when it is dropped.
/// Nothing the user runs tmux on is asked, so a check can neither disturb a
/// session nor be skewed by one.
///
/// The socket and the file each answer is written to are in a directory the
/// probe makes for itself, readable by this user alone, so a name another
/// user could guess in a shared temp dir is never opened.
pub(super) struct Probe {
    dir: PathBuf,
    essentials: PathBuf,
}

impl Probe {
    pub(super) fn new(layout: &Layout) -> std::io::Result<Self> {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        // A unix socket's path has ~100 bytes: a state dir deep in a tree
        // gives way to the temp dir.
        let short = layout.state.is_dir() && layout.state.as_os_str().len() < 60;
        let parent = if short {
            layout.state.clone()
        } else {
            std::env::temp_dir()
        };
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        // `create`, not `create_all`: a directory that is already there is
        // somebody else's, and the next name is tried.
        for _ in 0..16 {
            let dir = parent.join(format!(
                "tmuxy-check-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            match builder.create(&dir) {
                Ok(()) => {
                    return Ok(Self {
                        dir,
                        essentials: layout.path(&paths::ESSENTIALS_CONF),
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other(
            "no free name for the check's directory",
        ))
    }

    fn socket(&self) -> PathBuf {
        self.dir.join("s")
    }

    /// tmux on this probe's socket, started the one reviewed way
    /// ([`super::super::local_tmux_on`]): the socket is a path, so `-S`.
    fn tmux(&self) -> Command {
        let mut tmux = super::super::local_tmux_on(&self.socket().to_string_lossy());
        tmux.env_remove("TMUX").env_remove("TMUX_PANE");
        tmux
    }

    /// What tmux said to `commands`, run in a server born for them: whether
    /// it succeeded, and what it printed.
    fn ask(&self, commands: &[&str]) -> Option<(bool, String)> {
        let answer_file = self.dir.join("out");
        let answer = std::fs::File::create(&answer_file).ok()?;
        let mut tmux = self.tmux();
        tmux.args(["-f", "/dev/null", "start-server", ";"])
            .args(commands)
            .stdout(answer.try_clone().ok()?)
            .stderr(answer);
        let ok = status_within(tmux, PROBE_TIMEOUT)?;
        let said = std::fs::read(&answer_file).ok()?;
        Some((ok, String::from_utf8_lossy(&said).into_owned()))
    }

    /// What tmux's parser refuses in `file`. The essentials are sourced
    /// first, so the command aliases a config may use are known, as they
    /// are when the chain sources the file; `exit-empty`, which they turn
    /// off, goes back on, or this server would outlive its question.
    pub(super) fn parse(&self, file: &Path) -> Option<Vec<ConfigProblem>> {
        let essentials = self.essentials.to_string_lossy();
        let path = file.to_string_lossy();
        let (ok, said) = self.ask(&[
            "source-file",
            "-q",
            &essentials,
            ";",
            "set-option",
            "-s",
            "exit-empty",
            "on",
            ";",
            "source-file",
            "-n",
            &path,
        ])?;
        let mut problems = parse_errors(&said, file);
        if !ok && problems.is_empty() {
            // tmux failed and named no line of this file: the failure may
            // not be the file's at all, and it is said as tmux's.
            problems.push(ConfigProblem {
                file: file.to_path_buf(),
                line: None,
                kind: ProblemKind::Parse,
                message: format!("tmux could not check this file: {}", said.trim()),
            });
        }
        Some(problems)
    }

    /// What tmux says of an option called `name`: nothing when it has one
    /// (an unambiguous prefix counts, as it does to `set`), else its words.
    pub(super) fn option_error(&self, name: &str) -> Option<String> {
        let (ok, said) = self.ask(&["show-options", "-g", name])?;
        let said = said.trim();
        let refused = ["invalid option", "unknown option", "ambiguous option"]
            .iter()
            .any(|refusal| said.contains(refusal));
        (!ok && refused).then(|| said.to_string())
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        // Belt and braces: a question cut short may have left its server up.
        if self.socket().exists() {
            let mut kill = self.tmux();
            kill.arg("kill-server")
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let _ = status_within(kill, PROBE_TIMEOUT);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The `<file>:<line>: <message>` lines of what tmux printed about `file`.
pub(in crate::session) fn parse_errors(said: &str, file: &Path) -> Vec<ConfigProblem> {
    let prefix = format!("{}:", file.to_string_lossy());
    said.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix(&prefix)?;
            let (number, message) = rest.split_once(':')?;
            Some(ConfigProblem {
                file: file.to_path_buf(),
                line: Some(number.trim().parse().ok()?),
                kind: ProblemKind::Parse,
                message: message.trim().to_string(),
            })
        })
        .collect()
}
