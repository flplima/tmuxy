//! The menus' remembered choices (`tmuxy.state.json` in the state dir) and the
//! options the user's `tmuxy.conf` pins against them.

use std::path::PathBuf;
use tracing::warn;

use crate::constants::tmux_options;
use crate::paths::Layout;

/// App-managed state persisted to `tmuxy.state.json` in the state dir.
///
/// The control-mode monitor re-applies it on every connect (see
/// [`managed_state_commands`]), so a theme picked through the UI survives a
/// tmux server restart (fully quitting the app, last session closing, etc.).
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct ManagedState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_mode: Option<String>,
    /// Whether the cursor blinks (`@tmuxy-cursor-blink`), when the user has
    /// chosen through the app rather than in `tmuxy.conf`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    /// Whether a send into another pane asks first (`@tmuxy-send-ask`),
    /// when the user has chosen through the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_ask: Option<bool>,
    /// Whether the window is see-through (`@tmuxy-transparency`), when the
    /// user has chosen through the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparency: Option<bool>,
    /// Whether to source the user's own `~/.tmux.conf` on tmuxy's socket.
    ///
    /// Off by default, and deliberately not a tmux option: it decides what goes
    /// into the config chain, so it has to be known before that chain is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_tmux_conf: Option<bool>,
    /// The profile each session uses, by session name (`crate::profiles`).
    /// A session not listed uses the Default Profile; nothing is written
    /// here until a profile is picked.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub session_profiles: std::collections::BTreeMap<String, String>,
}

/// An option the menus can change: one [`ManagedState`] remembers and the
/// user's `tmuxy.conf` can pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedOption {
    Theme,
    ThemeMode,
    CursorBlink,
    SendAsk,
    Transparency,
}

impl ManagedOption {
    pub const ALL: [Self; 5] = [
        Self::Theme,
        Self::ThemeMode,
        Self::CursorBlink,
        Self::SendAsk,
        Self::Transparency,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Theme => tmux_options::THEME,
            Self::ThemeMode => tmux_options::THEME_MODE,
            Self::CursorBlink => tmux_options::CURSOR_BLINK,
            Self::SendAsk => tmux_options::SEND_ASK,
            Self::Transparency => tmux_options::TRANSPARENCY,
        }
    }

    fn flag(self, state: &mut ManagedState) -> Option<&mut Option<bool>> {
        match self {
            Self::Theme | Self::ThemeMode => None,
            Self::CursorBlink => Some(&mut state.cursor_blink),
            Self::SendAsk => Some(&mut state.send_ask),
            Self::Transparency => Some(&mut state.transparency),
        }
    }

    /// The value `state` remembers for it, as tmux spells it (`on`/`off` for
    /// a switch).
    pub fn remembered(self, state: &ManagedState) -> Option<String> {
        let mut state = state.clone();
        match self {
            Self::Theme => state.theme,
            Self::ThemeMode => state.theme_mode,
            _ => self
                .flag(&mut state)
                .and_then(|on| *on)
                .map(|on| if on { "on" } else { "off" }.to_string()),
        }
    }

    /// A state that remembers `value` (as tmux spells it) for this option and
    /// nothing else: the change [`write_managed_state`] merges in.
    pub fn remembering(self, value: &str) -> ManagedState {
        let mut state = ManagedState::default();
        match self {
            Self::Theme => state.theme = Some(value.to_string()),
            Self::ThemeMode => state.theme_mode = Some(value.to_string()),
            _ => {
                if let Some(flag) = self.flag(&mut state) {
                    *flag = Some(value == "on");
                }
            }
        }
        state
    }
}

/// The managed options `conf` sets, in [`ManagedOption::ALL`] order: the ones
/// pinned by the user's `tmuxy.conf`.
///
/// Config beats menu state. A key the user's file sets is theirs on every
/// machine that shares the file, so the app neither re-applies a remembered
/// menu choice over it nor lets the menu change it. Read from the file
/// rather than asked of tmux, because tmux cannot say which layer set an
/// option. The file is read as tmux reads it — comments out, continued lines
/// joined, split into commands where tmux splits a list (`;`, `\;`, newline)
/// — and in order: a `set`/`set-option` of the global option the app reads
/// (`-g`, and no `-w`, `-p` or `-s`, which name another table) pins it,
/// whatever its value, and a later `-u` of it lets it go. A command inside a
/// `{ … }` block (a binding's, say) runs later, if at all, and pins nothing.
pub fn pinned_options_in(conf: &str) -> Vec<&'static str> {
    let text = without_comments(conf);
    let mut pinned = Vec::new();
    for command in crate::tmux_command::parse(&text).top_level() {
        let Some((name, unset)) = global_option_set(command) else {
            continue;
        };
        let Some(option) = ManagedOption::ALL
            .into_iter()
            .map(ManagedOption::name)
            .find(|o| *o == name)
        else {
            continue;
        };
        pinned.retain(|o| *o != option);
        if !unset {
            pinned.push(option);
        }
    }
    ManagedOption::ALL
        .into_iter()
        .map(ManagedOption::name)
        .filter(|option| pinned.contains(option))
        .collect()
}

/// `conf` without its comments — a `#` that starts a word outside quotes runs
/// to the end of the line — and with each continued line (a `\` before the
/// newline) joined to the next.
fn without_comments(conf: &str) -> String {
    let mut out = String::with_capacity(conf.len());
    let mut quote = None;
    let mut word_start = true;
    let mut chars = conf.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (_, '\n') => quote = None,
            (None, '#') if word_start => {
                while chars.next_if(|&next| next != '\n').is_some() {}
                continue;
            }
            (None | Some('"'), '\\') => {
                match chars.next() {
                    Some('\n') => {
                        out.push(' ');
                        word_start = true;
                    }
                    Some(next) => {
                        out.push(c);
                        out.push(next);
                        word_start = false;
                    }
                    None => out.push(c),
                }
                continue;
            }
            (None, '\'' | '"') => quote = Some(c),
            (Some(open), _) if open == c => quote = None,
            _ => {}
        }
        word_start = quote.is_none() && matches!(c, ' ' | '\t' | '\n' | ';');
        out.push(c);
    }
    out
}

/// The option a `set`/`set-option` command sets or unsets (`true`) in the
/// global session table, read the way tmux's getopt reads its flags: `-t`
/// takes the rest of its cluster or the next word as a target. `None` for
/// any other command, and for one aimed at a window, pane or server table.
fn global_option_set<'a>(command: &crate::tmux_command::Command<'a>) -> Option<(&'a str, bool)> {
    if !command.runs(&crate::tmux_command::SET_OPTION) {
        return None;
    }
    let mut words = command.args().iter().copied();
    let (mut global, mut unset, mut other_table) = (false, false, false);
    let name = loop {
        let word = words.next()?;
        let Some(flags) = word.strip_prefix('-').filter(|flags| !flags.is_empty()) else {
            break word;
        };
        if flags == "-" {
            break words.next()?;
        }
        for (i, flag) in flags.char_indices() {
            match flag {
                'g' => global = true,
                'u' => unset = true,
                'w' | 'p' | 's' => other_table = true,
                't' => {
                    if flags[i + 1..].is_empty() {
                        words.next();
                    }
                    break;
                }
                _ => {}
            }
        }
    };
    (global && !other_table).then(|| (name.trim_matches(['\'', '"']), unset))
}

/// The managed options the user's `tmuxy.conf` pins ([`pinned_options_in`]).
pub fn pinned_options() -> Vec<&'static str> {
    let text = std::fs::read_to_string(Layout::current().user_conf()).unwrap_or_default();
    pinned_options_in(&text)
}

/// The `set-option -g` commands that put every set field of `state` back into
/// tmux, so the running server's `show-options -gqv @tmuxy-theme` (etc.)
/// returns the persisted choice — except an option `pinned` names, which the
/// user's `tmuxy.conf` set and which keeps that value. The monitor sends them
/// right after sourcing the chain, on every connect and every reload.
pub fn managed_state_commands(state: &ManagedState, pinned: &[&str]) -> Vec<String> {
    ManagedOption::ALL
        .into_iter()
        .filter(|option| !pinned.contains(&option.name()))
        .filter_map(|option| {
            let value = option.remembered(state)?;
            Some(format!(
                "set-option -g {} {}",
                option.name(),
                crate::tmux_quote(&value)
            ))
        })
        .collect()
}

/// The commands that put `session`'s profile on it, given the remembered
/// `state` and the profiles in `dir`: none for a session on the Default
/// Profile, or one whose profile cannot be read (it is logged, and the
/// session keeps the global settings).
pub fn profile_commands(
    state: &ManagedState,
    session: &str,
    dir: &std::path::Path,
    pinned: &[&str],
) -> Vec<String> {
    let Some(name) = state.session_profiles.get(session) else {
        return Vec::new();
    };
    match crate::profiles::load(dir, name) {
        Ok(profile) => crate::profiles::session_commands(session, name, &profile, pinned),
        Err(e) => {
            warn!(session, profile = %name, error = %e, "the session's profile is not applied");
            Vec::new()
        }
    }
}

/// [`profile_commands`] for what is on disk now.
pub fn current_profile_commands(session: &str) -> Vec<String> {
    profile_commands(
        &read_managed_state(),
        session,
        &crate::profiles::profiles_dir(&Layout::current()),
        &pinned_options(),
    )
}

/// [`managed_state_commands`] for what is on disk now: the state file, less
/// what the user's `tmuxy.conf` pins.
pub fn current_managed_state_commands() -> Vec<String> {
    managed_state_commands(&read_managed_state(), &pinned_options())
}

/// The managed state on disk, or the default when the file is missing or does
/// not parse: losing app state never stops startup.
pub fn read_managed_state() -> ManagedState {
    read_managed_state_in(&Layout::current())
}

pub(super) fn read_managed_state_in(layout: &Layout) -> ManagedState {
    read_strict(layout).unwrap_or_else(|e| {
        warn!(path = ?layout.state_file(), error = %e, "could not read the managed state file, using defaults");
        ManagedState::default()
    })
}

/// The state file as it is: empty when there is none, an error when it does
/// not parse, so a write never replaces a file it could not read.
fn read_strict(layout: &Layout) -> std::io::Result<ManagedState> {
    match std::fs::read_to_string(layout.state_file()) {
        Ok(text) => serde_json::from_str(&text).map_err(std::io::Error::other),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ManagedState::default()),
        Err(e) => Err(e),
    }
}

/// Update the JSON state file: every field `changes` sets is written, every
/// other kept as the file has it. A file that does not parse is left alone
/// and the write refused: it may hold a choice a newer build wrote.
pub fn write_managed_state(changes: ManagedState) -> std::io::Result<PathBuf> {
    write_managed_state_in(&Layout::current(), changes)
}

pub(super) fn write_managed_state_in(
    layout: &Layout,
    changes: ManagedState,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(&layout.state)?;
    let path = layout.state_file();
    let mut merged = serde_json::to_value(read_strict(layout)?)?;
    // Unset fields are not serialized, so the change's object holds exactly
    // the fields it sets.
    if let (Some(state), serde_json::Value::Object(set)) =
        (merged.as_object_mut(), serde_json::to_value(changes)?)
    {
        state.extend(set);
    }
    let body = serde_json::to_string_pretty(&merged)?;
    crate::private_files::replace(&path, format!("{body}\n"))?;
    Ok(path)
}
