//! Moving an install made before the config dir was split by owner.
//!
//! An older build kept everything in `~/.config/tmuxy`: the user's files, the
//! files it mirrored on every launch, the menu choices and this machine's
//! runtime files. On the first launch of a build with the split, this moves
//! the state files to the state dir, removes the mirrored copies (the data
//! dir has this build's), and drops the blocks older builds wrote into
//! `tmuxy.conf` itself. Running it again finds nothing to do.
//!
//! The config dir is the user's, so the rules are strict: nothing is written
//! or deleted through a symlink — a linked config dir is only read, and a
//! linked file in a real one is left in place — and the user's own files are
//! never touched, except for the one rewrite of `tmuxy.conf`, which keeps the
//! original beside it as `tmuxy.conf.bak`.

use std::path::{Path, PathBuf};
use tracing::{info, warn};

use super::assets::BUNDLED_BIN_SCRIPTS;
use super::config::{legacy_defaults_source, Layout, DEFAULT_USER_CONF};

/// Files an older build wrote into the config dir that are this machine's
/// state, not the user's config.
const STATE_FILES: [&str; 4] = ["tmuxy.state.json", "launcher", "trace.json", "servers.json"];

/// The confs an older build mirrored into the config dir on every launch.
/// `tmuxy.user.conf` was the generated `~/.tmux.conf` bridge, which the chain
/// now holds itself.
const APP_CONFS: [&str; 3] = [
    "tmuxy.defaults.conf",
    "tmuxy.essentials.conf",
    "tmuxy.user.conf",
];

/// The first line of the README an older build mirrored into the config dir.
const OLD_README_FIRST_LINE: &str = "# Personalizing tmuxy";

/// The header an older build put on every built-in theme it mirrored into
/// `themes/`: the only mark that told its copy from a user's.
pub(super) const OLD_BUILT_IN_THEME_HEADER: &str =
    "/* Shipped by tmuxy and rewritten on every launch — copy this file to a new name to customize it. */\n";

/// The header of the `tmuxy.conf` template older builds wrote, line for line:
/// 0.1.x's, whose advice (edit `tmuxy.state.json` to pin a theme) no longer
/// holds, and the earlier one that named `tmuxy.state.conf`. Only these exact
/// lines go: a comment the user wrote, under the header or in place of a line
/// of it, is theirs.
const OLD_HEADERS: [&[&str]; 2] = [
    &[
        "# Tmuxy User Configuration",
        "#",
        "# This file is yours. Edit it to override defaults, add custom bindings, etc.",
        "# Tmuxy never overwrites this file once it's been created.",
        "#",
        "# Layout:",
        "#   1. tmuxy.defaults.conf is sourced first (shipped with the app, refreshed",
        "#      on every launch — never edit it directly).",
        "#   2. Your customizations below this block override the defaults.",
        "#",
        "# Note: UI selections (theme, theme mode) are stored in tmuxy.state.json",
        "# next to this file and re-applied to tmux by the app on every startup —",
        "# not via source-file. The state is applied AFTER this conf is sourced,",
        "# so a UI choice always wins over a hand-set `set -g @tmuxy-theme` here.",
        "# If you want to permanently hard-pin a value, edit tmuxy.state.json",
        "# directly (or never change it via the UI).",
    ],
    &[
        "# Tmuxy User Configuration",
        "#",
        "# This file is yours. Edit it to override defaults, add custom bindings, etc.",
        "# Tmuxy never overwrites this file once it's been created.",
        "#",
        "# Layout:",
        "#   1. tmuxy.defaults.conf is sourced first (shipped with the app, refreshed",
        "#      on every launch — never edit it directly).",
        "#   2. Your customizations below this block override the defaults.",
        "#   3. tmuxy.state.conf is sourced last (app-managed; theme selection, etc.).",
    ],
];

/// The comment the 0.0.x upgrade wrote above the Ctrl+Tab bindings it
/// appended to an existing `tmuxy.conf`.
const CTRL_TAB_COMMENT: &str =
    "# Tab navigation (Ctrl+Tab / Ctrl+Shift+Tab) — added by tmuxy upgrade";
const CTRL_TAB_BINDS: [&str; 2] = [
    "bind -n C-Tab next-window",
    "bind -n C-S-Tab previous-window",
];

/// The Ctrl+hjkl navigation a user put back while the defaults bound
/// Alt+hjkl; the defaults have shipped exactly these again since 0.1.x.
const CTRL_HJKL_BINDS: [&str; 4] = [
    "bind -n C-h tmuxy-nav-left",
    "bind -n C-j tmuxy-nav-down",
    "bind -n C-k tmuxy-nav-up",
    "bind -n C-l tmuxy-nav-right",
];

/// A block an older build (or the advice it gave) left in `tmuxy.conf` that
/// the current chain makes redundant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleBlock {
    /// The template's header, whose advice (edit `tmuxy.state.json` to pin a
    /// theme) no longer holds.
    OldHeader,
    /// `source-file ~/.config/tmuxy/tmuxy.defaults.conf`: the chain sources
    /// the defaults itself, from the data dir.
    DefaultsSourceLine,
    /// The template's commented-out examples, framed by `# ====` rules.
    ExamplesBlock,
    /// The Ctrl+Tab bindings the 0.0.x upgrade appended, which the defaults ship.
    CtrlTabUpgrade,
    /// A Ctrl+hjkl restore, which the defaults ship.
    CtrlHjklRestore,
}

/// What [`migrate`] did, for the log and the tests.
#[derive(Debug, Default, PartialEq)]
pub struct Migration {
    /// State files copied into the state dir.
    pub moved: Vec<PathBuf>,
    /// Files removed from the config dir.
    pub removed: Vec<PathBuf>,
    /// The backup of a rewritten `tmuxy.conf`.
    pub backup: Option<PathBuf>,
    /// The blocks dropped from `tmuxy.conf`.
    pub dropped: Vec<StaleBlock>,
    /// The blocks found in a `tmuxy.conf` that is not tmuxy's to rewrite (a
    /// symlink, or in a linked config dir), left in place and logged.
    pub reported: Vec<StaleBlock>,
}

impl Migration {
    pub fn log(&self) {
        for path in &self.moved {
            info!(?path, "moved a state file out of the config dir");
        }
        for path in &self.removed {
            info!(?path, "removed an app file from the config dir");
        }
        if let Some(backup) = &self.backup {
            info!(?backup, dropped = ?self.dropped, "rewrote tmuxy.conf without its stale blocks");
        }
        if !self.reported.is_empty() {
            warn!(
                blocks = ?self.reported,
                "tmuxy.conf has blocks an older tmuxy wrote and the defaults now cover; \
                 it is a symlink, so tmuxy left it alone — remove them by hand"
            );
        }
    }
}

fn is_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn remove(path: &Path, done: &mut Vec<PathBuf>) {
    match std::fs::remove_file(path) {
        Ok(()) => done.push(path.to_path_buf()),
        Err(e) => warn!(?path, error = %e, "could not remove an app file from the config dir"),
    }
}

/// Move an older install's files out of `layout.config`. Idempotent.
pub fn migrate(layout: &Layout) -> Migration {
    let mut done = Migration::default();
    let dir = &layout.config;
    if std::fs::symlink_metadata(dir).is_err() {
        return done;
    }
    // A linked config dir is the user's checkout: read from it, write nothing.
    let writable = is_real_dir(dir);

    for name in STATE_FILES {
        let src = dir.join(name);
        if std::fs::symlink_metadata(&src).is_err() {
            continue;
        }
        let dest = layout.state.join(name);
        if std::fs::symlink_metadata(&dest).is_err() {
            let copied = std::fs::read(&src).and_then(|bytes| {
                std::fs::create_dir_all(&layout.state)?;
                crate::private_files::write(&dest, bytes)
            });
            match copied {
                Ok(()) => done.moved.push(dest),
                Err(e) => {
                    warn!(path = ?src, error = %e, "could not move a state file");
                    continue;
                }
            }
        }
        if writable && is_file(&src) {
            remove(&src, &mut done.removed);
        }
    }

    if writable {
        remove_app_files(dir, &mut done.removed);
    }

    let conf = layout.user_conf();
    if let Ok(text) = std::fs::read_to_string(&conf) {
        let (cleaned, blocks) = clean_user_conf(&text);
        if !blocks.is_empty() {
            if writable && is_file(&conf) {
                match rewrite_with_backup(&conf, &text, &cleaned) {
                    Ok(backup) => {
                        done.backup = Some(backup);
                        done.dropped = blocks;
                    }
                    Err(e) => {
                        warn!(path = ?conf, error = %e, "could not rewrite tmuxy.conf");
                        done.reported = blocks;
                    }
                }
            } else {
                done.reported = blocks;
            }
        }
    }
    done
}

/// Remove what an older build mirrored into a real config dir: only regular
/// files tmuxy wrote — the app confs, its README, the scripts it bundled and
/// the built-in themes it headed — and then the directories that left empty.
fn remove_app_files(dir: &Path, removed: &mut Vec<PathBuf>) {
    for name in APP_CONFS {
        let path = dir.join(name);
        if is_file(&path) {
            remove(&path, removed);
        }
    }

    let readme = dir.join("README.md");
    let ours = std::fs::read_to_string(&readme)
        .is_ok_and(|text| text.lines().next() == Some(OLD_README_FIRST_LINE));
    if is_file(&readme) && ours {
        remove(&readme, removed);
    }

    // bin/ was the app's whole — the scripts of this build and of every older
    // one, retired names included — when it holds the dispatcher it mirrored.
    let bin = dir.join("bin");
    if is_real_dir(&bin) && is_file(&bin.join(BUNDLED_BIN_SCRIPTS[0].0)) {
        remove_files_under(&bin, removed);
    }

    let themes = dir.join("themes");
    if is_real_dir(&themes) {
        if let Ok(entries) = std::fs::read_dir(&themes) {
            for path in entries.flatten().map(|e| e.path()) {
                let built_in = is_file(&path)
                    && std::fs::read_to_string(&path)
                        .is_ok_and(|css| css.starts_with(OLD_BUILT_IN_THEME_HEADER));
                if built_in {
                    remove(&path, removed);
                }
            }
        }
        let _ = std::fs::remove_dir(&themes);
    }
}

/// Remove every regular file under `dir`, then every directory that left
/// empty. A symlink is left where it is, and so is the directory holding it.
fn remove_files_under(dir: &Path, removed: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for path in entries.flatten().map(|e| e.path()) {
            if is_real_dir(&path) {
                remove_files_under(&path, removed);
            } else if is_file(&path) {
                remove(&path, removed);
            }
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// Write `cleaned` over `conf`, after keeping `original` in the first free
/// `tmuxy.conf.bak`, `tmuxy.conf.bak.1`, … beside it. Returns the backup.
fn rewrite_with_backup(conf: &Path, original: &str, cleaned: &str) -> std::io::Result<PathBuf> {
    let backup = (0..)
        .map(|n| match n {
            0 => conf.with_file_name("tmuxy.conf.bak"),
            n => conf.with_file_name(format!("tmuxy.conf.bak.{n}")),
        })
        .find(|path| std::fs::symlink_metadata(path).is_err())
        .unwrap_or_else(|| conf.with_file_name("tmuxy.conf.bak"));
    std::fs::write(&backup, original)?;
    std::fs::write(conf, cleaned)?;
    Ok(backup)
}

fn is_comment_or_blank(line: &str) -> bool {
    let line = line.trim();
    line.is_empty() || line.starts_with('#')
}

fn is_rule(line: &str) -> bool {
    line.trim().starts_with("# ====")
}

/// Whether a command line binds or unbinds `key`.
fn touches_key(line: &str, key: &str) -> bool {
    let mut words = line.split_whitespace();
    matches!(
        words.next(),
        Some("bind" | "bind-key" | "unbind" | "unbind-key")
    ) && words.any(|w| w == key)
}

/// `text` without the blocks an older build left in it, and which blocks they
/// were. Every setting the user wrote survives: what goes is comments, the
/// line sourcing the old defaults (the chain sources them), and bindings
/// identical to ones the defaults ship — and those only when no other line
/// of the file binds or unbinds the same key, where dropping one could change
/// what the key does.
pub fn clean_user_conf(text: &str) -> (String, Vec<StaleBlock>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut keep = vec![true; lines.len()];
    let mut found = Vec::new();

    let header = OLD_HEADERS.iter().find(|header| {
        lines.len() >= header.len()
            && lines
                .iter()
                .zip(header.iter())
                .all(|(line, h)| line.trim_end() == *h)
    });
    if let Some(header) = header {
        keep[..header.len()].iter_mut().for_each(|k| *k = false);
        found.push(StaleBlock::OldHeader);
    }

    for (i, line) in lines.iter().enumerate() {
        if legacy_defaults_source(line) {
            keep[i] = false;
            if !found.contains(&StaleBlock::DefaultsSourceLine) {
                found.push(StaleBlock::DefaultsSourceLine);
            }
        }
    }

    let mut i = 0;
    while i < lines.len() {
        let opens = is_rule(lines[i])
            && lines.get(i + 1).is_some_and(|l| {
                l.trim_start_matches('#')
                    .trim()
                    .starts_with("Your customizations below")
            });
        let close = opens
            .then(|| {
                (i + 2..lines.len())
                    .take_while(|&j| lines[j].trim().starts_with('#'))
                    .find(|&j| is_rule(lines[j]))
            })
            .flatten();
        if let Some(end) = close {
            keep[i..=end].iter_mut().for_each(|k| *k = false);
            found.push(StaleBlock::ExamplesBlock);
            i = end + 1;
        } else {
            i += 1;
        }
    }

    let others_touch = |keys: &[&str], block: &[usize]| {
        lines.iter().enumerate().any(|(j, line)| {
            !block.contains(&j)
                && !is_comment_or_blank(line)
                && keys.iter().any(|key| touches_key(line, key))
        })
    };

    for (i, line) in lines.iter().enumerate() {
        if line.trim() != CTRL_TAB_COMMENT {
            continue;
        }
        let mut block = vec![i];
        block.extend(
            (i + 1..lines.len()).take_while(|&j| CTRL_TAB_BINDS.contains(&lines[j].trim())),
        );
        if !others_touch(&["C-Tab", "C-S-Tab"], &block) {
            block.iter().for_each(|&j| keep[j] = false);
            found.push(StaleBlock::CtrlTabUpgrade);
        }
    }

    let hjkl: Vec<usize> = (0..lines.len())
        .filter(|&i| CTRL_HJKL_BINDS.contains(&lines[i].trim()))
        .collect();
    if !hjkl.is_empty() && !others_touch(&["C-h", "C-j", "C-k", "C-l"], &hjkl) {
        hjkl.iter().for_each(|&j| keep[j] = false);
        found.push(StaleBlock::CtrlHjklRestore);
    }

    if found.is_empty() {
        return (text.to_string(), found);
    }

    let mut rest = String::new();
    let mut blank_run = true;
    for (line, _) in lines.iter().zip(&keep).filter(|(_, k)| **k) {
        let blank = line.trim().is_empty();
        if blank && blank_run {
            continue;
        }
        blank_run = blank;
        rest.push_str(line);
        rest.push('\n');
    }
    let rest = rest.trim_end().to_string();

    let cleaned = match (found.contains(&StaleBlock::OldHeader), rest.is_empty()) {
        (true, true) => DEFAULT_USER_CONF.to_string(),
        (true, false) => format!("{DEFAULT_USER_CONF}\n{rest}\n"),
        (false, true) => String::new(),
        (false, false) => format!("{rest}\n"),
    };
    (cleaned, found)
}
