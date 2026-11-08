//! The config doctor: the `source-file` lines of the user's `tmuxy.conf`
//! whose file is not there. tmux stops reading a config at the first such
//! line, so one dead `source-file` silently drops every setting after it
//! and fails the chain at startup. The host reports them when it builds the
//! chain ([`config_warnings`]), and `tmuxy config doctor` lists or comments
//! them out ([`fix`]).

use std::path::{Path, PathBuf};

use crate::paths::Layout;
use crate::tmux_command::{self, SOURCE_FILE};

/// What every warning ends with: how to make it go away.
pub const DOCTOR_HINT: &str = "run: tmuxy config doctor --fix";

/// What [`fix`] puts in front of a dead line, so the file says who commented
/// it out and why.
pub const FIX_MARK: &str = "# tmuxy config doctor: ";

/// A `source-file` whose target does not exist, and where it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeadSource {
    pub file: PathBuf,
    /// 1-based, as an editor counts.
    pub line: usize,
    /// The path as the config spells it (`~/x.conf`, quotes dropped).
    pub written: String,
    /// The path it names on this machine.
    pub target: PathBuf,
}

impl std::fmt::Display for DeadSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}:{}: source-file {}: {} does not exist",
            self.file.display(),
            self.line,
            self.written,
            self.target.display()
        )
    }
}

/// A `source-file` path word, resolved: the file it names on this machine
/// and how it was written. tmux expands a leading `~` and `$HOME` itself;
/// `None` when it works the rest out at run time (another `$VARIABLE`, a
/// glob, a `~user`, a relative path against a cwd this process does not
/// know) — never reported, since a guess there would be a false alarm.
fn resolve_target(word: &str, home: &Path) -> Option<(String, PathBuf)> {
    let written = match tmux_command::unquote(word) {
        Some(literal) => literal,
        None if word.starts_with('~') => format!("~{}", tmux_command::unquote(&word[1..])?),
        None => {
            let rest = word
                .strip_prefix("${HOME}")
                .or_else(|| word.strip_prefix("$HOME"))?;
            format!("$HOME{}", tmux_command::unquote(rest)?)
        }
    };
    let target = match written.split_once('/') {
        Some(("~" | "$HOME", rest)) => home.join(rest),
        None if written == "~" || written == "$HOME" => home.to_path_buf(),
        _ => PathBuf::from(&written),
    };
    if written.contains(['*', '?', '[']) || !target.is_absolute() {
        return None;
    }
    Some((written, target))
}

/// The paths one `source-file` command would read as tmux reads its flags:
/// `-q` makes a missing file no error, `-F` makes the path a format, `-t`
/// takes a target; a command carrying either answers nothing.
fn sourced_paths<'a>(command: &tmux_command::Command<'a>) -> Vec<&'a str> {
    let mut args = command.args().iter().copied();
    let mut paths = Vec::new();
    while let Some(word) = args.next() {
        match word {
            "--" => {
                paths.extend(args.by_ref());
                break;
            }
            "-t" => {
                args.next();
            }
            flags if flags.starts_with('-') && flags.len() > 1 => {
                if flags.contains(['q', 'F']) {
                    return Vec::new();
                }
                if flags.contains('t') && !flags.ends_with('t') {
                    continue;
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

/// Every `source-file` in `conf` whose target is missing, with `file` as the
/// name the report gives the config, and `~` standing for `home`. Only a
/// top-level command counts: one inside a `{ … }` block runs later, if ever.
pub fn dead_sources_in(conf: &str, file: &Path, home: &Path) -> Vec<DeadSource> {
    let mut dead = Vec::new();
    for (index, line) in conf.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let list = tmux_command::parse(line);
        for command in list.top_level().filter(|c| c.runs(&SOURCE_FILE)) {
            for word in sourced_paths(command) {
                let Some((written, target)) = resolve_target(word, home) else {
                    continue;
                };
                if !target.exists() {
                    dead.push(DeadSource {
                        file: file.to_path_buf(),
                        line: index + 1,
                        written,
                        target,
                    });
                }
            }
        }
    }
    dead
}

/// The dead sources of the layout's `tmuxy.conf`; none when there is no file.
pub fn dead_sources(layout: &Layout) -> Vec<DeadSource> {
    let file = layout.user_conf();
    match std::fs::read_to_string(&file) {
        Ok(conf) => dead_sources_in(&conf, &file, &layout.home),
        Err(_) => Vec::new(),
    }
}

/// What the host warns with as it builds the chain: one line per dead
/// source and the hint, or nothing when the file is clean.
pub fn config_warnings(layout: &Layout) -> Vec<String> {
    let dead = dead_sources(layout);
    if dead.is_empty() {
        return Vec::new();
    }
    dead.iter()
        .map(ToString::to_string)
        .chain(std::iter::once(DOCTOR_HINT.to_string()))
        .collect()
}

/// What [`fix`] did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Fixed {
    pub file: PathBuf,
    /// The copy of the file as it was, beside it; `None` when nothing needed
    /// fixing and nothing was written.
    pub backup: Option<PathBuf>,
    pub fixed: Vec<DeadSource>,
}

/// `conf` with every line a dead source is on commented out, each behind
/// [`FIX_MARK`] and the targets it lost. Line numbers stay what the report
/// said.
pub(super) fn commented_out(conf: &str, dead: &[DeadSource]) -> String {
    let mut out = String::with_capacity(conf.len() + dead.len() * 64);
    for (index, line) in conf.lines().enumerate() {
        let lost: Vec<String> = dead
            .iter()
            .filter(|d| d.line == index + 1)
            .map(|d| d.target.display().to_string())
            .collect();
        if !lost.is_empty() {
            let verb = if lost.len() == 1 { "does" } else { "do" };
            out.push_str(&format!(
                "{FIX_MARK}{} {verb} not exist: {line}\n",
                lost.join(", ")
            ));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !conf.ends_with('\n') {
        out.pop();
    }
    out
}

/// `tmuxy config doctor --fix`: comment every dead line of the layout's
/// `tmuxy.conf` out in place, keeping the file as it was beside it as
/// `tmuxy.conf.bak-<UTC stamp>`. A file that is a symlink is edited through
/// the link — the user's real file is the one tmux reads. A clean file is
/// not touched.
pub fn fix(layout: &Layout) -> std::io::Result<Fixed> {
    let file = layout.user_conf();
    let conf = match std::fs::read_to_string(&file) {
        Ok(conf) => conf,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Fixed {
                file,
                ..Fixed::default()
            })
        }
        Err(e) => return Err(e),
    };
    let dead = dead_sources_in(&conf, &file, &layout.home);
    if dead.is_empty() {
        return Ok(Fixed {
            file,
            ..Fixed::default()
        });
    }
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let backup = PathBuf::from(format!(
        "{}.bak-{}",
        file.display(),
        crate::stamp::stamp(unix)
    ));
    std::fs::copy(&file, &backup)?;
    std::fs::write(&file, commented_out(&conf, &dead))?;
    Ok(Fixed {
        file,
        backup: Some(backup),
        fixed: dead,
    })
}
