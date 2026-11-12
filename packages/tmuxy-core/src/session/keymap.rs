//! `tmuxy keymap`: every key the config chain binds, and the file and line
//! each binding comes from.
//!
//! tmux can list what is bound (`list-keys`) but not who bound it, and the
//! chain has four writers: tmuxy's essentials and defaults, the user's
//! `~/.tmux.conf` when it is sourced, and their `tmuxy.conf`. So the files
//! are read here, in the order the chain sources them, the way tmux would
//! apply their `bind-key`, `unbind-key` and `set -g prefix` lines: a later
//! binding of a key replaces an earlier one, and the replaced one is kept as
//! a [`Shadow`], which is what a user looking for "why does this key not do
//! what my file says" needs to see.
//!
//! Nothing is asked of tmux. A caller that has read a server's bindings
//! adds what tmux binds by itself ([`Keymap::add_unattributed`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::doctor::resolve_target;
use crate::paths::{self, Layout};
use crate::tmux_command::{self, TmuxCommand, SET_OPTION, SOURCE_FILE};

const BIND_KEY: TmuxCommand = TmuxCommand {
    name: "bind-key",
    alias: "bind",
    unique_prefix: "bind",
};
const UNBIND_KEY: TmuxCommand = TmuxCommand {
    name: "unbind-key",
    alias: "unbind",
    unique_prefix: "unb",
};

/// The table a binding with no `-T` and no `-n` goes in.
pub const PREFIX_TABLE: &str = "prefix";
/// The table `bind -n` writes: keys that need no prefix.
pub const ROOT_TABLE: &str = "root";

/// How many files one layer follows `source-file` lines into.
const MAX_FILES: usize = 64;

/// Who wrote a binding, in the order the chain applies them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Layer {
    /// tmux itself, or something that bound the key on the running server:
    /// in tmux's listing, in none of the files.
    Tmux,
    /// On the running server, and neither in a file of the chain nor one of
    /// tmux's own: bound while it ran (a plugin manager's keys, a
    /// `run-shell` in a config, a `bind` typed at the prompt).
    Running,
    Essentials,
    Defaults,
    TmuxConf,
    UserConf,
}

impl Layer {
    /// The name a user knows the layer by.
    pub fn label(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Running => "set while running",
            Self::Essentials => "tmuxy.essentials.conf",
            Self::Defaults => "tmuxy.defaults.conf",
            Self::TmuxConf => "~/.tmux.conf",
            Self::UserConf => "tmuxy.conf",
        }
    }

    /// Whether the file is the user's to edit.
    pub fn is_users(self) -> bool {
        matches!(self, Self::TmuxConf | Self::UserConf)
    }
}

/// Where a line of the chain is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Source {
    pub layer: Layer,
    /// `None` for [`Layer::Tmux`] and [`Layer::Running`].
    pub file: Option<PathBuf>,
    /// 1-based, as an editor counts.
    pub line: Option<usize>,
}

impl Source {
    /// One of tmux's own bindings, made by no file.
    pub fn tmux() -> Self {
        Self {
            layer: Layer::Tmux,
            file: None,
            line: None,
        }
    }

    /// A binding made on the running server by something no file says.
    pub fn running() -> Self {
        Self {
            layer: Layer::Running,
            file: None,
            line: None,
        }
    }
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.file, self.line) {
            (Some(file), Some(line)) => write!(f, "{}:{line}", file.display()),
            (Some(file), None) => write!(f, "{}", file.display()),
            _ => f.write_str(self.layer.label()),
        }
    }
}

/// One key of one table, what it runs and who bound it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Binding {
    pub table: String,
    pub key: String,
    pub command: String,
    /// The `-r` flag.
    pub repeat: bool,
    pub source: Source,
}

/// A binding a later line of the chain replaced or removed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Shadow {
    pub lost: Binding,
    /// The `bind-key` or `unbind-key` that did it.
    pub by: Source,
    /// Whether the key was rebound (`false`: it was unbound).
    pub rebound: bool,
}

/// The prefix key a `set -g prefix` line sets.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Prefix {
    pub key: String,
    pub source: Source,
}

/// What the chain binds.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct Keymap {
    /// The last `set -g prefix` of the chain; `None` when no file sets one
    /// (tmux's own is `C-b`).
    pub prefix: Option<Prefix>,
    /// In table then key order.
    pub bindings: Vec<Binding>,
    /// In the order the chain made them.
    pub shadows: Vec<Shadow>,
    pub warnings: Vec<String>,
}

/// The commands of `conf`, each with the line it starts on: a line that ends
/// in a backslash runs on into the next, and a line that opens a `{` block
/// runs on until the block closes. Comment and blank lines start nothing.
pub(super) fn statements(conf: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut open: i32 = 0;
    let mut pending: Option<(usize, String)> = None;
    for (index, raw) in conf.lines().enumerate() {
        let line = raw.trim_end();
        if pending.is_none() {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
        }
        let trailing = line.len() - line.trim_end_matches('\\').len();
        let continued = trailing % 2 == 1;
        let text = if continued {
            &line[..line.len() - 1]
        } else {
            line
        };
        open += brace_delta(text);
        let (_, buffer) = pending.get_or_insert_with(|| (index + 1, String::new()));
        if !buffer.is_empty() {
            buffer.push(' ');
        }
        buffer.push_str(text.trim());
        if !continued && open <= 0 {
            open = 0;
            out.extend(pending.take());
        }
    }
    out.extend(pending);
    out
}

/// How many `{` blocks `line` opens, less how many it closes. A brace counts
/// when it is a word of its own outside quotes, as tmux reads it: the braces
/// of a format (`#{pane_id}`) are glued to their word and are text.
fn brace_delta(line: &str) -> i32 {
    let mut delta = 0;
    let mut quote: Option<char> = None;
    let mut previous = ' ';
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
            }
            Some(_) => match c {
                '\\' => {
                    chars.next();
                }
                '"' => quote = None,
                _ => {}
            },
            None => {
                let alone = previous.is_whitespace()
                    && chars.peek().is_none_or(|next| next.is_whitespace());
                match c {
                    '\\' => {
                        chars.next();
                    }
                    '\'' | '"' => quote = Some(c),
                    '#' if previous.is_whitespace() => break,
                    '{' if alone => delta += 1,
                    '}' if alone => delta -= 1,
                    _ => {}
                }
            }
        }
        previous = c;
    }
    delta
}

/// A key as written in a config, as tmux names it: quotes and the backslash
/// that makes a character literal taken off (`'"'` and `\"` are `"`).
fn key_named(word: &str) -> String {
    tmux_command::unquote(word).unwrap_or_else(|| match word.strip_prefix('\\') {
        Some(rest) if rest.chars().count() == 1 => rest.to_string(),
        _ => word.to_string(),
    })
}

/// A `bind-key` or `unbind-key` read the way tmux's getopt reads it.
struct KeyLine {
    table: String,
    repeat: bool,
    /// `unbind-key -a`: every key of the table.
    all: bool,
    key: Option<String>,
    command: String,
}

fn key_line(command: &tmux_command::Command<'_>) -> KeyLine {
    let args = command.args();
    let mut line = KeyLine {
        table: PREFIX_TABLE.to_string(),
        repeat: false,
        all: false,
        key: None,
        command: String::new(),
    };
    let mut index = 0;
    while index < args.len() {
        let word = args[index];
        index += 1;
        if word == "--" {
            break;
        }
        // A lone `-` is the key `-`, not a flag.
        let Some(flags) = word.strip_prefix('-').filter(|flags| !flags.is_empty()) else {
            index -= 1;
            break;
        };
        for (at, flag) in flags.char_indices() {
            match flag {
                'n' => line.table = ROOT_TABLE.to_string(),
                'r' => line.repeat = true,
                'a' => line.all = true,
                'T' | 'N' => {
                    // The value is the rest of the cluster, or the next word.
                    let glued = &flags[at + 1..];
                    let value = if glued.is_empty() {
                        let next = args.get(index).copied().unwrap_or("");
                        index += 1;
                        next
                    } else {
                        glued
                    };
                    if flag == 'T' {
                        line.table = key_named(value);
                    }
                    break;
                }
                _ => {}
            }
        }
    }
    if let Some(key) = args.get(index) {
        line.key = Some(key_named(key));
        line.command = args[index + 1..].join(" ");
    }
    line
}

/// The value a `set -g prefix <key>` gives the prefix, when `command` is one.
fn prefix_set<'a>(command: &tmux_command::Command<'a>) -> Option<&'a str> {
    if !command.runs(&SET_OPTION) {
        return None;
    }
    let mut words = command
        .args()
        .iter()
        .copied()
        .skip_while(|word| word.starts_with('-') && word.len() > 1);
    (words.next()? == "prefix").then(|| words.next()).flatten()
}

/// The files a `source-file` in `command` reads, that exist.
fn sourced<'a>(command: &tmux_command::Command<'a>, home: &Path) -> Vec<PathBuf> {
    if !command.runs(&SOURCE_FILE) {
        return Vec::new();
    }
    command
        .args()
        .iter()
        .filter(|word| !word.starts_with('-'))
        .filter_map(|word| resolve_target(word, home))
        .map(|(_, target)| target)
        .filter(|target| target.is_file())
        .collect()
}

#[derive(Default)]
struct Chain {
    bound: BTreeMap<(String, String), Binding>,
    prefix: Option<Prefix>,
    shadows: Vec<Shadow>,
    read: Vec<PathBuf>,
}

impl Chain {
    /// Apply `conf`, the text of `file`, as `layer`; a file it sources is
    /// applied where the `source-file` stands, as the same layer.
    fn apply(&mut self, layer: Layer, file: &Path, conf: &str, home: &Path) {
        self.read.push(file.to_path_buf());
        for (line, statement) in statements(conf) {
            let source = Source {
                layer,
                file: Some(file.to_path_buf()),
                line: Some(line),
            };
            let list = tmux_command::parse(&statement);
            for command in list.top_level() {
                if command.runs(&BIND_KEY) {
                    self.bind(key_line(command), &source);
                } else if command.runs(&UNBIND_KEY) {
                    self.unbind(&key_line(command), &source);
                } else if let Some(key) = prefix_set(command) {
                    self.prefix = Some(Prefix {
                        key: key_named(key),
                        source: source.clone(),
                    });
                }
                for target in sourced(command, home) {
                    if self.read.len() >= MAX_FILES || self.read.contains(&target) {
                        continue;
                    }
                    if let Ok(text) = std::fs::read_to_string(&target) {
                        self.apply(layer, &target, &text, home);
                    }
                }
            }
        }
    }

    fn bind(&mut self, line: KeyLine, source: &Source) {
        let Some(key) = line.key else {
            return;
        };
        let binding = Binding {
            table: line.table.clone(),
            key: key.clone(),
            command: line.command,
            repeat: line.repeat,
            source: source.clone(),
        };
        if let Some(lost) = self.bound.insert((line.table, key), binding) {
            self.shadows.push(Shadow {
                lost,
                by: source.clone(),
                rebound: true,
            });
        }
    }

    fn unbind(&mut self, line: &KeyLine, source: &Source) {
        let gone: Vec<(String, String)> = self
            .bound
            .keys()
            .filter(|(table, key)| {
                *table == line.table && (line.all || line.key.as_deref() == Some(key.as_str()))
            })
            .cloned()
            .collect();
        for at in gone {
            if let Some(lost) = self.bound.remove(&at) {
                self.shadows.push(Shadow {
                    lost,
                    by: source.clone(),
                    rebound: false,
                });
            }
        }
    }
}

/// The text of one of tmuxy's own files: the copy mirrored into the data
/// dir, or the one this build carries when tmuxy has not run here yet.
fn own_file(layout: &Layout, file: &paths::File, embedded: &str) -> (PathBuf, String) {
    let path = layout.path(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| embedded.to_string());
    (path, text)
}

/// What cannot work as written: a key bound in the root table that is also
/// the prefix. tmux looks for the prefix first, so the binding never runs.
fn prefix_collisions(prefix: Option<&Prefix>, bindings: &[Binding]) -> Vec<String> {
    let Some(prefix) = prefix else {
        return Vec::new();
    };
    bindings
        .iter()
        .filter(|binding| binding.table == ROOT_TABLE && binding.key == prefix.key)
        .map(|binding| {
            format!(
                "{} is the prefix ({}) and is also bound without it ({}): tmux reads the prefix first, so `{}` never runs",
                prefix.key, prefix.source, binding.source, binding.command
            )
        })
        .collect()
}

/// The keymap the chain makes for `layout`, read from its files in the order
/// tmux is given them (`session::config`'s `entry_conf`): the essentials, the
/// defaults, `~/.tmux.conf` when it is sourced, the user's `tmuxy.conf`, the
/// essentials again.
pub fn keymap(layout: &Layout) -> Keymap {
    let mut chain = Chain::default();
    let home = layout.home.clone();
    let essentials = own_file(
        layout,
        &paths::ESSENTIALS_CONF,
        super::config::DEFAULT_ESSENTIALS_CONF,
    );
    let defaults = own_file(
        layout,
        &paths::DEFAULTS_CONF,
        super::config::DEFAULT_DEFAULTS_CONF,
    );
    chain.apply(Layer::Essentials, &essentials.0, &essentials.1, &home);
    chain.apply(Layer::Defaults, &defaults.0, &defaults.1, &home);
    let use_tmux_conf = super::state::read_managed_state_in(layout)
        .use_tmux_conf
        .unwrap_or(false);
    let users = [
        (Layer::TmuxConf, home.join(".tmux.conf"), use_tmux_conf),
        (Layer::UserConf, layout.user_conf(), true),
    ];
    for (layer, file, sourced) in users {
        if let Some(text) = sourced
            .then(|| std::fs::read_to_string(&file).ok())
            .flatten()
        {
            chain.apply(layer, &file, &text, &home);
        }
    }
    // The second pass of the essentials: what it binds wins over everything.
    chain.read.retain(|read| read != &essentials.0);
    chain.apply(Layer::Essentials, &essentials.0, &essentials.1, &home);

    let bindings: Vec<Binding> = chain.bound.into_values().collect();
    let warnings = prefix_collisions(chain.prefix.as_ref(), &bindings);
    Keymap {
        prefix: chain.prefix,
        bindings,
        shadows: chain.shadows,
        warnings,
    }
}

impl Keymap {
    /// Add what a server lists and no file of the chain binds: tmux's own
    /// bindings ([`Source::tmux`]) and any made on the running server
    /// ([`Source::running`]). The caller reads the server and tells them
    /// apart.
    pub fn add_unattributed(&mut self, listed: impl IntoIterator<Item = Binding>) {
        for binding in listed {
            let known = self
                .bindings
                .iter()
                .any(|known| known.table == binding.table && known.key == binding.key);
            if !known {
                self.bindings.push(binding);
            }
        }
        self.bindings
            .sort_by(|a, b| (&a.table, &a.key).cmp(&(&b.table, &b.key)));
    }

    /// Only `table`'s bindings and shadows.
    pub fn only_table(&mut self, table: &str) {
        self.bindings.retain(|binding| binding.table == table);
        self.shadows.retain(|shadow| shadow.lost.table == table);
    }

    /// The shadows a user wants to hear about: one of their own bindings
    /// lost, or one of their lines taking a key from another file. tmuxy's
    /// defaults clearing the way for themselves (`unbind C-b`) are not news.
    pub fn notable_shadows(&self) -> impl Iterator<Item = &Shadow> {
        self.shadows.iter().filter(|shadow| {
            (shadow.lost.source.layer.is_users() || shadow.by.layer.is_users())
                && (shadow.lost.source.file != shadow.by.file
                    || shadow.lost.source.line != shadow.by.line)
        })
    }
}
