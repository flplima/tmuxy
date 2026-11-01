//! The menus' remembered choices (`tmuxy.state.json` in the state dir) and the
//! options the user's `tmuxy.conf` pins against them.

use std::path::PathBuf;
use tracing::warn;

use super::config::Layout;
use crate::constants::tmux_options;

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
}

/// The options the menus can change, and so the ones [`ManagedState`] holds
/// and `tmuxy.conf` can pin.
pub const MANAGED_OPTIONS: [&str; 5] = [
    tmux_options::THEME,
    tmux_options::THEME_MODE,
    tmux_options::CURSOR_BLINK,
    tmux_options::SEND_ASK,
    tmux_options::TRANSPARENCY,
];

/// The managed options `conf` sets, in [`MANAGED_OPTIONS`] order: the ones
/// pinned by the user's `tmuxy.conf`.
///
/// Config beats menu state. A key the user's file sets is theirs on every
/// machine that shares the file, so the app neither re-applies a remembered
/// menu choice over it nor lets the menu change it. Read from the file
/// rather than asked of tmux, because tmux cannot say which layer set an
/// option: a `set` line (`set`, `set-option`, any flags but `-u`) naming the
/// option outside a comment is a pin, whatever its value.
pub fn pinned_options_in(conf: &str) -> Vec<&'static str> {
    let mut set = Vec::new();
    for command in conf
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .flat_map(|line| line.split(" ; "))
    {
        let mut words = command.split_whitespace();
        if !matches!(words.next(), Some("set" | "set-option")) {
            continue;
        }
        let mut unset = false;
        let name = words.find(|word| {
            if word.starts_with('-') {
                unset |= word.contains('u');
                return false;
            }
            true
        });
        let Some(name) = name.map(|n| n.trim_matches(['\'', '"'])) else {
            continue;
        };
        if !unset && !set.contains(&name) {
            set.push(name);
        }
    }
    MANAGED_OPTIONS
        .into_iter()
        .filter(|option| set.contains(option))
        .collect()
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
    let flag = |on: Option<bool>| on.map(|on| if on { "on" } else { "off" });
    [
        (tmux_options::THEME, state.theme.as_deref()),
        (tmux_options::THEME_MODE, state.theme_mode.as_deref()),
        (tmux_options::CURSOR_BLINK, flag(state.cursor_blink)),
        (tmux_options::SEND_ASK, flag(state.send_ask)),
        (tmux_options::TRANSPARENCY, flag(state.transparency)),
    ]
    .into_iter()
    .filter(|(option, _)| !pinned.contains(option))
    .filter_map(|(option, value)| {
        value.map(|v| format!("set-option -g {option} {}", crate::executor::tmux_quote(v)))
    })
    .collect()
}

/// [`managed_state_commands`] for what is on disk now: the state file, less
/// what the user's `tmuxy.conf` pins.
pub fn current_managed_state_commands() -> Vec<String> {
    managed_state_commands(&read_managed_state(), &pinned_options())
}

/// Path to the JSON state file in the state dir. Does not check for
/// existence — callers handle missing files.
pub fn managed_state_path() -> PathBuf {
    Layout::current().state_file()
}

/// Read the managed state from disk. Returns a default (all-None) struct if
/// the file is missing or unparseable rather than erroring — losing app
/// state should never crash startup.
pub fn read_managed_state() -> ManagedState {
    read_managed_state_in(&Layout::current())
}

pub(super) fn read_managed_state_in(layout: &Layout) -> ManagedState {
    let path = layout.state_file();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ManagedState::default();
    };
    match serde_json::from_str::<ManagedState>(&text) {
        Ok(state) => state,
        Err(e) => {
            warn!(?path, error = %e, "could not parse managed state file, using defaults");
            ManagedState::default()
        }
    }
}

/// Update the JSON state file: every field `changes` sets is written, every
/// other kept as the file has it.
pub fn write_managed_state(changes: ManagedState) -> std::io::Result<PathBuf> {
    write_managed_state_in(&Layout::current(), changes)
}

pub(super) fn write_managed_state_in(
    layout: &Layout,
    changes: ManagedState,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(&layout.state)?;
    let path = layout.state_file();

    let mut state = read_managed_state_in(layout);
    // Destructured, so a field added to the state cannot be left out here.
    let ManagedState {
        theme,
        theme_mode,
        cursor_blink,
        send_ask,
        transparency,
        use_tmux_conf,
    } = changes;
    if theme.is_some() {
        state.theme = theme;
    }
    if theme_mode.is_some() {
        state.theme_mode = theme_mode;
    }
    if cursor_blink.is_some() {
        state.cursor_blink = cursor_blink;
    }
    if send_ask.is_some() {
        state.send_ask = send_ask;
    }
    if transparency.is_some() {
        state.transparency = transparency;
    }
    if use_tmux_conf.is_some() {
        state.use_tmux_conf = use_tmux_conf;
    }

    let body = serde_json::to_string_pretty(&state).map_err(std::io::Error::other)?;
    crate::private_files::write(&path, format!("{}\n", body))?;
    Ok(path)
}
