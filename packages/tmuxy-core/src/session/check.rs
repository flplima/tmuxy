//! `tmuxy config check`: what is wrong with the user's config, found without
//! applying any of it.
//!
//! Three things are looked for, each with its file and line:
//!
//! - what tmux's own parser refuses (`source-file -n`: the file is parsed and
//!   nothing in it runs), asked of a tmux server started for the question on
//!   a socket of its own, which exits with it. tmux reports the first such
//!   error of a file;
//! - an option name tmux does not have (`set -g staus off`), which the parse
//!   lets through because a name is only looked up when the command runs.
//!   The verdict is tmux's too: the same throwaway server is asked for the
//!   option;
//! - a `source-file` whose target is not there ([`super::doctor`]): tmux
//!   stops reading a config at that line.
//!
//! A reload asks first ([`reload_blockers`]): sourcing a file with any of
//! these re-applies tmuxy's defaults and then none, or only part, of the
//! user's own settings over them.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::doctor::{dead_sources_in, resolve_target};
use crate::paths::{self, Layout};
use crate::tmux_command::{self, SET_OPTION, SET_WINDOW_OPTION, SOURCE_FILE};

/// What every refused reload ends with: how to see the whole list.
pub const CHECK_HINT: &str = "run: tmuxy config check";

/// One thing wrong with a config file, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigProblem {
    pub file: PathBuf,
    /// 1-based, as an editor counts; `None` when tmux named no line.
    pub line: Option<usize>,
    pub message: String,
}

impl std::fmt::Display for ConfigProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.line {
            Some(line) => write!(f, "{}:{line}: {}", self.file.display(), self.message),
            None => write!(f, "{}: {}", self.file.display(), self.message),
        }
    }
}

/// The files that were read, and what is wrong with them, in file then line
/// order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConfigReport {
    pub files: Vec<PathBuf>,
    pub problems: Vec<ConfigProblem>,
}

/// How many files one check follows `source-file` lines into: a config that
/// sources itself must end somewhere.
const MAX_FILES: usize = 64;

/// How long the throwaway tmux may take over one question.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The path words of one `source-file` command, `-q` or not: a file that may
/// be missing is still a file to check when it is there. None for `-F`,
/// whose path is a format only tmux can expand.
fn sourced_words<'a>(command: &tmux_command::Command<'a>) -> Vec<&'a str> {
    let mut args = command.args().iter().copied();
    let mut paths = Vec::new();
    while let Some(word) = args.next() {
        match word {
            "--" => {
                paths.extend(args.by_ref());
                break;
            }
            flags if flags.starts_with('-') && flags.len() > 1 => {
                if flags.contains('F') {
                    return Vec::new();
                }
                if flags.ends_with('t') {
                    args.next();
                }
            }
            path => paths.push(path),
        }
    }
    paths
}

/// The files `conf` sources by a path known before tmux runs, that exist.
fn sourced_files(conf: &str, home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for line in conf.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let list = tmux_command::parse(line);
        for command in list.top_level().filter(|c| c.runs(&SOURCE_FILE)) {
            for word in sourced_words(command) {
                if let Some((_, target)) = resolve_target(word, home) {
                    if target.is_file() {
                        files.push(target);
                    }
                }
            }
        }
    }
    files
}

/// The files a check reads: `start` and everything it sources, or, with no
/// `start`, the user's part of the chain — `tmuxy.conf`, `~/.tmux.conf` when
/// it is sourced (`use-tmux-conf`), and everything those source. tmuxy's own
/// files are not the user's to fix and are left out.
pub fn checked_files(layout: &Layout, start: Option<&Path>) -> Vec<PathBuf> {
    let mut queue: Vec<PathBuf> = match start {
        Some(file) => vec![file.to_path_buf()],
        None => {
            let mut roots = Vec::new();
            let use_tmux_conf = super::state::read_managed_state_in(layout)
                .use_tmux_conf
                .unwrap_or(false);
            let tmux_conf = layout.home.join(".tmux.conf");
            if use_tmux_conf && tmux_conf.is_file() {
                roots.push(tmux_conf);
            }
            if layout.user_conf().is_file() {
                roots.push(layout.user_conf());
            }
            roots
        }
    };
    let mut files: Vec<PathBuf> = Vec::new();
    while !queue.is_empty() && files.len() < MAX_FILES {
        let file = queue.remove(0);
        if files.contains(&file) {
            continue;
        }
        if let Ok(conf) = std::fs::read_to_string(&file) {
            queue.extend(sourced_files(&conf, &layout.home));
        }
        files.push(file);
    }
    files
}

/// The option a `set`/`set-option`/`setw` command names, read the way tmux's
/// getopt reads the flags (`-t` takes the rest of its cluster or the next
/// word). `None` for a user option (`@name`: any name is valid), and for a
/// name tmux works out when the command runs (a format, a variable).
fn option_named<'a>(command: &tmux_command::Command<'a>) -> Option<&'a str> {
    if !command.runs(&SET_OPTION) && !command.runs(&SET_WINDOW_OPTION) {
        return None;
    }
    let mut words = command.args().iter().copied();
    let name = loop {
        let word = words.next()?;
        let Some(flags) = word.strip_prefix('-').filter(|flags| !flags.is_empty()) else {
            break word;
        };
        if flags == "-" {
            break words.next()?;
        }
        if flags.ends_with('t') {
            words.next();
        }
    };
    let name = name.trim_matches(['\'', '"']);
    let name = name.split('[').next().unwrap_or(name);
    let literal = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    literal.then_some(name)
}

/// Every option `conf` sets by a literal name, with the line it is on.
fn options_set(conf: &str) -> Vec<(usize, &str)> {
    let mut set = Vec::new();
    for (index, line) in conf.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // `parse` borrows from the line, so the names it finds live as long
        // as `conf` does.
        let list = tmux_command::parse(line);
        for command in list.top_level() {
            if let Some(name) = option_named(command) {
                set.push((index + 1, name));
            }
        }
    }
    set
}

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
struct Probe {
    socket: PathBuf,
    /// Where each question's answer is written, to be read once tmux is done.
    answer: PathBuf,
    essentials: PathBuf,
}

impl Probe {
    fn new(layout: &Layout) -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let name = format!(
            "tmuxy-check-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        // A unix socket's path has ~100 bytes: a state dir deep in a tree
        // gives way to the temp dir.
        let short = layout.state.is_dir() && layout.state.as_os_str().len() < 60;
        let dir = if short {
            layout.state.clone()
        } else {
            std::env::temp_dir()
        };
        Self {
            socket: dir.join(format!("{name}.sock")),
            answer: dir.join(format!("{name}.out")),
            essentials: layout.path(&paths::ESSENTIALS_CONF),
        }
    }

    /// What tmux said to `commands`, run in a server born for them: its
    /// status, and stdout then stderr.
    /// tmux on this probe's socket, started the one reviewed way
    /// ([`super::local_tmux_on`]): the socket is a path, so `-S`.
    fn tmux(&self) -> Command {
        let mut tmux = super::local_tmux_on(&self.socket.to_string_lossy());
        tmux.env_remove("TMUX").env_remove("TMUX_PANE");
        tmux
    }

    fn ask(&self, commands: &[&str]) -> Option<(bool, String)> {
        let answer = std::fs::File::create(&self.answer).ok()?;
        let mut tmux = self.tmux();
        tmux.args(["-f", "/dev/null", "start-server", ";"])
            .args(commands)
            .stdout(answer.try_clone().ok()?)
            .stderr(answer);
        let ok = status_within(tmux, PROBE_TIMEOUT)?;
        let said = std::fs::read(&self.answer).ok()?;
        Some((ok, String::from_utf8_lossy(&said).into_owned()))
    }

    /// What tmux's parser refuses in `file`. The essentials are sourced
    /// first, so the command aliases a config may use are known, as they
    /// are when the chain sources the file; `exit-empty`, which they turn
    /// off, goes back on, or this server would outlive its question.
    fn parse(&self, file: &Path) -> Option<Vec<ConfigProblem>> {
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
            problems.push(ConfigProblem {
                file: file.to_path_buf(),
                line: None,
                message: said.trim().to_string(),
            });
        }
        Some(problems)
    }

    /// What tmux says of an option called `name`: nothing when it has one
    /// (an unambiguous prefix counts, as it does to `set`), else its words.
    fn option_error(&self, name: &str) -> Option<String> {
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
        // Belt and braces: a question cut short by an error may have left
        // its server up.
        if self.socket.exists() {
            let mut kill = self.tmux();
            kill.arg("kill-server")
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let _ = status_within(kill, PROBE_TIMEOUT);
        }
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_file(&self.answer);
    }
}

/// The `<file>:<line>: <message>` lines of what tmux printed about `file`.
fn parse_errors(said: &str, file: &Path) -> Vec<ConfigProblem> {
    let prefix = format!("{}:", file.to_string_lossy());
    said.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix(&prefix)?;
            let (number, message) = rest.split_once(':')?;
            Some(ConfigProblem {
                file: file.to_path_buf(),
                line: Some(number.trim().parse().ok()?),
                message: message.trim().to_string(),
            })
        })
        .collect()
}

/// Check `file` and everything it sources, or, with none named, the user's
/// part of the config chain ([`checked_files`]). `Err` when tmux could not
/// be asked at all.
pub fn check_config(layout: &Layout, file: Option<&Path>) -> Result<ConfigReport, String> {
    let files = checked_files(layout, file);
    let probe = Probe::new(layout);
    let mut problems = Vec::new();
    // One verdict per name: a config sets the same option in many places.
    let mut refused: std::collections::BTreeMap<String, Option<String>> = Default::default();
    for path in &files {
        let conf = match std::fs::read_to_string(path) {
            Ok(conf) => conf,
            Err(e) => {
                problems.push(ConfigProblem {
                    file: path.clone(),
                    line: None,
                    message: e.to_string(),
                });
                continue;
            }
        };
        let parsed = probe
            .parse(path)
            .ok_or_else(|| format!("could not ask tmux about {}", path.display()))?;
        let mut found: BTreeSet<(Option<usize>, String)> = parsed
            .into_iter()
            .map(|problem| (problem.line, problem.message))
            .collect();
        for (line, name) in options_set(&conf) {
            let verdict = refused
                .entry(name.to_string())
                .or_insert_with(|| probe.option_error(name));
            if let Some(message) = verdict {
                found.insert((Some(line), message.clone()));
            }
        }
        for dead in dead_sources_in(&conf, path, &layout.home) {
            found.insert((
                Some(dead.line),
                format!(
                    "source-file {}: {} does not exist",
                    dead.written,
                    dead.target.display()
                ),
            ));
        }
        problems.extend(found.into_iter().map(|(line, message)| ConfigProblem {
            file: path.clone(),
            line,
            message,
        }));
    }
    Ok(ConfigReport { files, problems })
}

/// What stops a reload: the problems of the user's part of the chain. None
/// when tmux could not be asked, since a check that cannot run must not be
/// what keeps a config from loading.
pub fn reload_blockers(layout: &Layout) -> Vec<ConfigProblem> {
    match check_config(layout, None) {
        Ok(report) => report.problems,
        Err(e) => {
            tracing::warn!(error = %e, "the config was not checked before its reload");
            Vec::new()
        }
    }
}

/// What a refused reload says: the first problem, how many more there are,
/// and how to see them all.
pub fn refusal(problems: &[ConfigProblem]) -> Option<String> {
    let first = problems.first()?;
    let more = match problems.len() - 1 {
        0 => String::new(),
        n => format!(" (and {n} more)"),
    };
    Some(format!(
        "config not reloaded, the running one is kept: {first}{more}; {CHECK_HINT}"
    ))
}
