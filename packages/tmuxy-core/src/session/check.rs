//! `tmuxy config check`: what is wrong with the user's config, found without
//! applying any of it.
//!
//! Three things are looked for, each with its file and line:
//!
//! - what tmux's own parser refuses ([`ProblemKind::Parse`]), from
//!   `source-file -n` (the file is parsed and nothing in it runs), asked of
//!   a tmux server started for the question on a socket of its own, which
//!   exits with it. tmux reports the first such error of a file, and applies
//!   nothing of a file it cannot parse;
//! - an option name tmux does not have ([`ProblemKind::Option`],
//!   `set -g staus off`), which the parse lets through because a name is
//!   only looked up when the command runs. The verdict is tmux's too: the
//!   same throwaway server is asked for the option;
//! - a `source-file` whose target is not there ([`ProblemKind::Source`],
//!   [`super::doctor`]).
//!
//! The last two are read line by line, which cannot tell whether a line
//! inside a `%if` runs on this machine (a guard for a newer tmux's option, a
//! file sourced on another host), so lines inside a conditional are left to
//! tmux's parse alone.
//!
//! A reload asks first, and only the first kind stops it
//! ([`reload_blockers`]): the chain starts by putting tmuxy's defaults back,
//! and a file tmux then cannot parse leaves none of the user's own settings
//! over them. tmux reports the other two when it runs the file and carries
//! on, as it always has.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::doctor::{dead_sources_in, resolve_target};
use crate::paths::Layout;
use crate::tmux_command::{self, SET_OPTION, SET_WINDOW_OPTION, SOURCE_FILE};

mod probe;
#[cfg(test)]
pub(super) use probe::parse_errors;
use probe::Probe;

/// What every refused reload ends with: how to see the whole list.
pub const CHECK_HINT: &str = "run: tmuxy config check";

/// What kind of thing is wrong; see the module's opening.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProblemKind {
    Parse,
    Option,
    Source,
}

impl ProblemKind {
    /// The word `--json` gives it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parse => "parse",
            Self::Option => "option",
            Self::Source => "source",
        }
    }
}

/// One thing wrong with a config file, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigProblem {
    pub file: PathBuf,
    /// 1-based, as an editor counts; `None` when tmux named no line.
    pub line: Option<usize>,
    pub kind: ProblemKind,
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

/// The lines of `conf` that are a `%if` … `%endif` block, the directives
/// included: what a line-by-line reading cannot judge, since only tmux knows
/// which branch runs here.
pub(super) fn conditional_lines(conf: &str) -> BTreeSet<usize> {
    let mut inside = BTreeSet::new();
    let mut depth = 0usize;
    for (index, line) in conf.lines().enumerate() {
        let word = line.split_whitespace().next().unwrap_or("");
        if word == "%if" {
            depth += 1;
        }
        if depth > 0 {
            inside.insert(index + 1);
        }
        if word == "%endif" {
            depth = depth.saturating_sub(1);
        }
    }
    inside
}

/// The numbered lines of `conf` a line-by-line check reads: not blank, not a
/// comment, not inside a conditional.
fn judged_lines(conf: &str) -> impl Iterator<Item = (usize, &str)> {
    let conditional = conditional_lines(conf);
    conf.lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .filter(move |(number, line)| {
            let trimmed = line.trim_start();
            !trimmed.is_empty() && !trimmed.starts_with('#') && !conditional.contains(number)
        })
}

/// The files `conf` sources by a path known before tmux runs, that exist. A
/// `source-file` inside a conditional counts here: when the file is there it
/// is worth reading, whichever machine runs the line.
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

/// Every option `conf` sets by a literal name outside a conditional, with
/// the line it is on.
pub(super) fn options_set(conf: &str) -> Vec<(usize, &str)> {
    let mut set = Vec::new();
    for (number, line) in judged_lines(conf) {
        let list = tmux_command::parse(line);
        for command in list.top_level() {
            if let Some(name) = option_named(command) {
                set.push((number, name));
            }
        }
    }
    set
}

fn cannot_ask(what: impl std::fmt::Display) -> String {
    format!("could not ask tmux about {what}")
}

/// What tmux's parser refuses in `files`, each asked of `probe`.
fn parse_problems(probe: &Probe, files: &[PathBuf]) -> Result<Vec<ConfigProblem>, String> {
    let mut problems = Vec::new();
    for path in files.iter().filter(|path| path.is_file()) {
        problems.extend(
            probe
                .parse(path)
                .ok_or_else(|| cannot_ask(path.display()))?,
        );
    }
    Ok(problems)
}

/// Check `file` and everything it sources, or, with none named, the user's
/// part of the config chain ([`checked_files`]). `Err` when tmux could not
/// be asked at all.
pub fn check_config(layout: &Layout, file: Option<&Path>) -> Result<ConfigReport, String> {
    let files = checked_files(layout, file);
    let probe = Probe::new(layout).map_err(|e| cannot_ask(format!("the config: {e}")))?;
    let parsed = parse_problems(&probe, &files)?;
    let mut problems = Vec::new();
    // One verdict per name: a config sets the same option in many places.
    let mut refused: std::collections::BTreeMap<String, Option<String>> = Default::default();
    for path in &files {
        let mut found: BTreeSet<(Option<usize>, ProblemKind, String)> = parsed
            .iter()
            .filter(|problem| &problem.file == path)
            .map(|problem| (problem.line, problem.kind, problem.message.clone()))
            .collect();
        match std::fs::read_to_string(path) {
            Ok(conf) => {
                for (line, name) in options_set(&conf) {
                    let verdict = refused
                        .entry(name.to_string())
                        .or_insert_with(|| probe.option_error(name));
                    if let Some(message) = verdict {
                        found.insert((Some(line), ProblemKind::Option, message.clone()));
                    }
                }
                let conditional = conditional_lines(&conf);
                for dead in dead_sources_in(&conf, path, &layout.home) {
                    if conditional.contains(&dead.line) {
                        continue;
                    }
                    found.insert((
                        Some(dead.line),
                        ProblemKind::Source,
                        format!(
                            "source-file {}: {} does not exist",
                            dead.written,
                            dead.target.display()
                        ),
                    ));
                }
            }
            Err(e) => {
                found.insert((None, ProblemKind::Source, e.to_string()));
            }
        }
        problems.extend(
            found
                .into_iter()
                .map(|(line, kind, message)| ConfigProblem {
                    file: path.clone(),
                    line,
                    kind,
                    message,
                }),
        );
    }
    Ok(ConfigReport { files, problems })
}

/// What stops a reload: what tmux's parser refuses in the user's part of the
/// chain, and nothing else (see the module's opening). None when tmux could
/// not be asked, since a check that cannot run must not be what keeps a
/// config from loading.
pub fn reload_blockers(layout: &Layout) -> Vec<ConfigProblem> {
    let files = checked_files(layout, None);
    if files.is_empty() {
        return Vec::new();
    }
    let asked = Probe::new(layout)
        .map_err(|e| e.to_string())
        .and_then(|probe| parse_problems(&probe, &files));
    match asked {
        Ok(problems) => problems,
        Err(e) => {
            tracing::warn!(error = %e, "the config was not checked before its reload");
            Vec::new()
        }
    }
}

/// [`reload_blockers`] for the layout in use.
pub fn current_reload_blockers() -> Vec<ConfigProblem> {
    reload_blockers(&Layout::current())
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
