use std::path::{Path, PathBuf};
use tracing::{info, warn};

use crate::constants::tmux_options;

/// Shipped defaults — overwritten on every app launch so users get new
/// defaults (new bindings, new options) without merge work. Users never
/// edit this file; their overrides live in `tmuxy.conf` which sources
/// this one first.
const DEFAULT_DEFAULTS_CONF: &str = include_str!("../../assets/tmuxy.defaults.conf");

/// The settings tmuxy cannot work without — command-aliases plus the handful of
/// tmux options the renderer, the scrollback and the session lifetime depend on.
/// App-owned and refreshed like the defaults.
///
/// Sourced twice: once from `tmuxy.defaults.conf`, and again immediately after
/// a user's own `~/.tmux.conf` when they have opted into it. The second pass is
/// what lets tmuxy adopt somebody's prefix, status line and plugins without
/// their config being able to take the app apart.
const DEFAULT_ESSENTIALS_CONF: &str = include_str!("../../assets/tmuxy.essentials.conf");

/// User-editable config template — written ONLY when `tmuxy.conf` does not
/// already exist. Sources `tmuxy.defaults.conf` first, then leaves space
/// for the user's customizations.
pub(super) const DEFAULT_USER_CONF: &str = include_str!("../../assets/tmuxy.conf");

/// The guide to personalizing tmuxy, written to the config dir as
/// `README.md` so a user — or an agent working in a pane — finds every
/// file, option and workflow next to the files themselves. App-owned and
/// refreshed like the defaults.
const CONFIG_README: &str = include_str!("../../assets/config-README.md");

/// Resolve the user's tmuxy config directory: $XDG_CONFIG_HOME/tmuxy
/// or $HOME/.config/tmuxy. Does not create the directory.
///
/// We deliberately do NOT use `dirs::config_dir()` because on macOS that
/// returns `~/Library/Application Support`, which surprises users who
/// expect to find their tmuxy config at `~/.config/tmuxy/tmuxy.conf`
/// (the same path as on Linux, the devcontainer, and what every doc/CI
/// path references). The mismatch silently broke first-run config
/// loading on Mac: ensure_config wrote into `~/Library/Application
/// Support/tmuxy/`, the user looked at `~/.config/tmuxy/`, found
/// nothing, and the desktop app got the default tmux prefix because
/// `tmux -f` was never given a config path either way.
pub fn config_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = std::path::PathBuf::from(xdg);
        if xdg.is_absolute() {
            return xdg.join("tmuxy");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("tmuxy")
}

/// The user's `tmuxy.conf` in [`config_dir`], if it exists. Both hosts call
/// [`ensure_config`] at startup, before any monitor connects, so it is only
/// absent when that write failed.
pub fn get_config_path() -> Option<PathBuf> {
    let path = config_dir().join("tmuxy.conf");
    path.exists().then_some(path)
}

/// The shipped user conf sources its siblings by the default
/// `~/.config/tmuxy` path; when `XDG_CONFIG_HOME` relocates the config dir,
/// point those lines at the real location instead.
pub(super) fn user_conf_template(dir: &std::path::Path) -> String {
    let default_dir = dirs::home_dir().map(|home| home.join(".config").join("tmuxy"));
    if default_dir.as_deref() == Some(dir) {
        DEFAULT_USER_CONF.to_string()
    } else {
        DEFAULT_USER_CONF.replace("~/.config/tmuxy", &dir.to_string_lossy())
    }
}

/// Write an app-owned config file, unless it is a symlink.
///
/// The symlink check is the devcontainer workflow: the config dir's files are
/// symlinked to the repo's checked-in copies so an edit there is live, and
/// writing through the link would rewrite the repo.
pub(super) fn write_app_owned_conf(path: &Path, contents: &str) {
    let is_symlink = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_symlink {
        return;
    }
    let needs_write = match std::fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if !needs_write {
        return;
    }
    if let Err(e) = std::fs::write(path, contents) {
        warn!(?path, error = %e, "could not write app-owned config file");
    } else {
        info!(?path, "refreshed app-owned config file");
    }
}

/// Generate `tmuxy.user.conf`, the one-line bridge to a user's own
/// `~/.tmux.conf`.
///
/// Generated rather than hand-editable, and sourced from the END of
/// `tmuxy.defaults.conf`, because `tmuxy.conf` is written once and never again:
/// anything that has to reach people who already installed tmuxy must live in a
/// file the app refreshes on every launch.
///
/// Opting in sources the user's config and then re-applies
/// `tmuxy.essentials.conf` on top. That order is the whole design: their
/// prefix, status line and plugins win over tmuxy's taste, and tmuxy's
/// essentials win over anything of theirs that would stop the app working.
fn write_user_conf_bridge(dir: &Path) {
    let path = dir.join("tmuxy.user.conf");
    let enabled = read_managed_state().use_tmux_conf.unwrap_or(false);

    let contents = if enabled {
        "# Generated by tmuxy — do not edit; `tmuxy config use-tmux-conf off` undoes it.\n\
         #\n\
         # Your own config, then tmuxy's essentials re-applied on top. Your prefix,\n\
         # status line and plugins survive; the settings tmuxy needs to function are\n\
         # restored afterwards whatever your config did to them.\n\
         source-file -q ~/.tmux.conf\n\
         source-file ~/.config/tmuxy/tmuxy.essentials.conf\n"
            .to_string()
    } else {
        "# Generated by tmuxy — do not edit.\n\
         #\n\
         # tmuxy is not reading your ~/.tmux.conf. It starts tmux with its own config,\n\
         # so your prefix, status line and plugins are not loaded on tmuxy's socket.\n\
         #\n\
         # To use your own config here:  tmuxy config use-tmux-conf on\n\
         #\n\
         # That sources ~/.tmux.conf and then re-applies tmuxy.essentials.conf on top,\n\
         # so your settings win except where they would stop tmuxy working. Read\n\
         # tmuxy.essentials.conf to see exactly what that covers.\n"
            .to_string()
    };

    write_app_owned_conf(&path, &contents);
}

/// Ensure the shipped defaults and user config exist at
/// ~/.config/tmuxy/. Three files participate:
///
///   - `tmuxy.defaults.conf` — shipped baseline. **Overwritten every
///     launch** so improvements (new bindings, new options) land without
///     any user merge work. The user's `tmuxy.conf` sources this first.
///   - `tmuxy.conf` — user-editable. Created from the shipped template
///     only if it doesn't already exist. Sources defaults and leaves space
///     for overrides.
///   - `tmuxy.state.json` — app-managed state (theme, etc.). Not created
///     here; written by [`write_managed_state`] when the UI changes it, and
///     re-applied to tmux by the control-mode monitor on every connect
///     (see [`managed_state_commands`]).
pub fn ensure_config() -> PathBuf {
    let dir = config_dir();
    let user_path = dir.join("tmuxy.conf");
    let defaults_path = dir.join("tmuxy.defaults.conf");

    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!(?dir, error = %e, "could not create config dir");
        return user_path;
    }

    write_app_owned_conf(&defaults_path, DEFAULT_DEFAULTS_CONF);
    write_app_owned_conf(&dir.join("tmuxy.essentials.conf"), DEFAULT_ESSENTIALS_CONF);
    write_app_owned_conf(&dir.join("README.md"), CONFIG_README);
    write_user_conf_bridge(&dir);

    // Create the user-editable conf only if it doesn't exist.
    if !user_path.exists() {
        if let Err(e) = std::fs::write(&user_path, user_conf_template(&dir)) {
            warn!(path = ?user_path, error = %e, "could not write default user config");
        } else {
            info!(path = ?user_path, "created tmuxy.conf");
        }
    }

    user_path
}

/// App-managed state persisted to `~/.config/tmuxy/tmuxy.state.json`.
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

/// The `set-option -g` commands that put every set field of `state` back into
/// tmux, so the running server's `show-options -gqv @tmuxy-theme` (etc.)
/// returns the persisted choice. The monitor sends them through the
/// control-mode connection right after sourcing the config, which is what
/// lets a UI choice win over a hand-set value in `tmuxy.conf`.
pub fn managed_state_commands(state: &ManagedState) -> Vec<String> {
    let flag = |on: Option<bool>| on.map(|on| if on { "on" } else { "off" });
    [
        (tmux_options::THEME, state.theme.as_deref()),
        (tmux_options::THEME_MODE, state.theme_mode.as_deref()),
        (tmux_options::CURSOR_BLINK, flag(state.cursor_blink)),
        (tmux_options::SEND_ASK, flag(state.send_ask)),
        (tmux_options::TRANSPARENCY, flag(state.transparency)),
    ]
    .into_iter()
    .filter_map(|(option, value)| {
        value.map(|v| format!("set-option -g {option} {}", crate::executor::tmux_quote(v)))
    })
    .collect()
}

/// Path to the JSON state file inside the user's config dir. Does not check
/// for existence — callers handle missing files.
pub fn managed_state_path() -> PathBuf {
    config_dir().join("tmuxy.state.json")
}

/// Read the managed state from disk. Returns a default (all-None) struct if
/// the file is missing or unparseable rather than erroring — losing app
/// state should never crash startup.
pub fn read_managed_state() -> ManagedState {
    let path = managed_state_path();
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
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let path = managed_state_path();

    let mut state = read_managed_state();
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
    std::fs::write(&path, format!("{}\n", body))?;
    Ok(path)
}

/// What the user can edit under the config dir to restyle or reconfigure a
/// running app, reduced to two numbers that change whenever one of those
/// files does: every `*.css` (the themes and `custom.css`) in one, the tmux
/// config in the other. A poll of these is how both hosts notice an edit,
/// with no file-watching dependency and no interest in which file it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConfigStamps {
    pub css: u128,
    pub conf: u128,
}

fn file_stamp(path: &Path) -> u128 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    modified ^ (u128::from(meta.len()) << 64)
}

pub fn config_stamps() -> ConfigStamps {
    let dir = config_dir();
    let mut css = file_stamp(&dir.join("custom.css"));
    if let Ok(entries) = std::fs::read_dir(dir.join("themes")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("css") {
                css = css.wrapping_add(file_stamp(&path));
            }
        }
    }
    ConfigStamps {
        css,
        conf: file_stamp(&dir.join("tmuxy.conf")),
    }
}
