//! Terminal profiles: named sets of the menus' look-and-feel settings (theme
//! and mode, cursor blink, transparency), one per tmux session if the user
//! wants.
//!
//! A profile holds appearance only, never a setting that guards access:
//! asking before keys are sent to a pane, trusting a pane's claims, the
//! permission files. A profile file is plain JSON any program of the user's
//! can write, and is applied by name, so such a key in it is refused with a
//! message rather than read ([`SECURITY_KEYS`]).
//!
//! A profile holds only what it changes. The **Default Profile** is not a
//! file and changes nothing: a session with no profile, or with the default
//! one, gets exactly what it got before profiles existed, the config chain
//! and then the menus' remembered choices. A named profile lives in the
//! config dir (`profiles/<name>.json`, where the user can read and edit it);
//! which session uses which is remembered with the menus' other choices
//! (`ManagedState::session_profiles`), since tmux forgets a session's options
//! when its server exits.
//!
//! A profile applies to its session only: its values are set on the session
//! (`set-option -t <session>`), over the global ones, and the session carries
//! `@tmuxy-profile` naming it. Sessions are matched by name: a renamed
//! session loses its profile, and a new session given an old name gets it.

use std::path::{Path, PathBuf};

use crate::constants::tmux_options;
use crate::paths::Layout;

/// The profile every session has until it is given another: no file, no
/// changes.
pub const DEFAULT_PROFILE: &str = "Default Profile";

/// The most characters a profile's name may have.
const MAX_NAME_CHARS: usize = 64;

/// The keys a profile file may hold: [`Profile`]'s fields, nothing else.
pub const FIELDS: [&str; 4] = ["theme", "themeMode", "cursorBlink", "transparency"];

/// Keys that name a setting guarding access, refused by name so the user
/// learns why: a profile cannot loosen (or set) any of them.
pub const SECURITY_KEYS: [&str; 6] = [
    "sendAsk",
    "sendAskAllow",
    "trustPaneClaims",
    "permissions",
    "permissionsFile",
    "allowedHosts",
];

/// The options a profile sets on its session: what a switch unsets first.
const SESSION_OPTIONS: [&str; 5] = [
    tmux_options::PROFILE,
    tmux_options::THEME,
    tmux_options::THEME_MODE,
    tmux_options::CURSOR_BLINK,
    tmux_options::TRANSPARENCY,
];

/// The profiles there are and the one a session uses: what every profile
/// command answers, for the menu.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProfilesInfo {
    pub active: String,
    pub names: Vec<String>,
}

/// The theme modes a profile may pick.
const THEME_MODES: [&str; 3] = ["dark", "light", "auto"];

/// What a profile changes; `None` leaves the setting as the menus and the
/// config have it.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Profile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparency: Option<bool>,
}

/// What went wrong with a profile.
#[derive(Debug, PartialEq, Eq)]
pub enum ProfileError {
    BadName(String),
    Default,
    Missing(String),
    Exists(String),
    Unreadable(String),
    /// A key that is not a profile field, or a security setting.
    Refused(String),
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadName(name) => write!(
                f,
                "{name:?} is not a profile name: up to {MAX_NAME_CHARS} letters, digits, spaces, \
                 '-', '_' or '.', not starting with '.'"
            ),
            Self::Default => write!(f, "the {DEFAULT_PROFILE} has no file to change"),
            Self::Missing(name) => write!(f, "there is no profile {name:?}"),
            Self::Exists(name) => write!(f, "a profile {name:?} already exists"),
            Self::Unreadable(why) | Self::Refused(why) => write!(f, "{why}"),
        }
    }
}

/// Where the profiles live: `profiles/` in the config dir.
pub fn profiles_dir(layout: &Layout) -> PathBuf {
    layout.config.join("profiles")
}

/// Whether `name` can name a profile file: safe as a file name everywhere.
pub fn valid_name(name: &str) -> bool {
    let chars = name.chars().count();
    (1..=MAX_NAME_CHARS).contains(&chars)
        && !name.starts_with('.')
        && name.trim() == name
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
}

fn file(dir: &Path, name: &str) -> Result<PathBuf, ProfileError> {
    if name == DEFAULT_PROFILE {
        return Err(ProfileError::Default);
    }
    if !valid_name(name) {
        return Err(ProfileError::BadName(name.to_string()));
    }
    Ok(dir.join(format!("{name}.json")))
}

/// Every profile's name, the default first, then the files' in order.
pub fn list(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".json")?.to_string();
            (valid_name(&stem) && stem != DEFAULT_PROFILE).then_some(stem)
        })
        .collect();
    names.sort();
    names.insert(0, DEFAULT_PROFILE.to_string());
    names
}

/// The profile `name`; the default one changes nothing.
pub fn load(dir: &Path, name: &str) -> Result<Profile, ProfileError> {
    if name == DEFAULT_PROFILE {
        return Ok(Profile::default());
    }
    let path = file(dir, name)?;
    let text = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ProfileError::Missing(name.to_string()),
        _ => ProfileError::Unreadable(format!("{}: {e}", path.display())),
    })?;
    parse(name, &text)
}

/// A profile file's text, checked key by key before it is read: a security
/// setting or an unknown key is refused naming it, and so is a theme or mode
/// value no theme could have.
pub fn parse(name: &str, text: &str) -> Result<Profile, ProfileError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| ProfileError::Unreadable(format!("{name}: {e}")))?;
    let Some(object) = value.as_object() else {
        return Err(ProfileError::Unreadable(format!(
            "{name}: a profile is a JSON object"
        )));
    };
    for key in object.keys() {
        if SECURITY_KEYS.contains(&key.as_str()) {
            return Err(ProfileError::Refused(format!(
                "{name}: {key:?} guards access to your panes; a profile cannot change it"
            )));
        }
        if !FIELDS.contains(&key.as_str()) {
            return Err(ProfileError::Refused(format!(
                "{name}: {key:?} is not a profile setting (one of {})",
                FIELDS.join(", ")
            )));
        }
    }
    let profile: Profile = serde_json::from_value(value)
        .map_err(|e| ProfileError::Unreadable(format!("{name}: {e}")))?;
    check_values(name, &profile)?;
    Ok(profile)
}

fn check_values(name: &str, profile: &Profile) -> Result<(), ProfileError> {
    if let Some(theme) = &profile.theme {
        let stem = !theme.is_empty()
            && theme.len() <= MAX_NAME_CHARS
            && theme
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'));
        if !stem {
            return Err(ProfileError::Refused(format!(
                "{name}: {theme:?} is not a theme name (a theme file's name, like \"tokyo-night\")"
            )));
        }
    }
    if let Some(mode) = &profile.theme_mode {
        if !THEME_MODES.contains(&mode.as_str()) {
            return Err(ProfileError::Refused(format!(
                "{name}: {mode:?} is not a theme mode (one of {})",
                THEME_MODES.join(", ")
            )));
        }
    }
    Ok(())
}

/// Write `profile` as `name`, made or replaced.
pub fn save(dir: &Path, name: &str, profile: &Profile) -> Result<(), ProfileError> {
    let path = file(dir, name)?;
    let text = serde_json::to_string_pretty(profile)
        .map_err(|e| ProfileError::Unreadable(e.to_string()))?;
    crate::private_files::write(&path, format!("{text}\n"))
        .map_err(|e| ProfileError::Unreadable(format!("{}: {e}", path.display())))
}

/// A new profile `name`, a copy of `from` (the default one: changing nothing).
pub fn create(dir: &Path, name: &str, from: &str) -> Result<(), ProfileError> {
    let path = file(dir, name)?;
    if path.exists() {
        return Err(ProfileError::Exists(name.to_string()));
    }
    save(dir, name, &load(dir, from)?)
}

/// Rename the profile `from` to `to`.
pub fn rename(dir: &Path, from: &str, to: &str) -> Result<(), ProfileError> {
    let old = file(dir, from)?;
    let new = file(dir, to)?;
    if !old.exists() {
        return Err(ProfileError::Missing(from.to_string()));
    }
    if new.exists() {
        return Err(ProfileError::Exists(to.to_string()));
    }
    std::fs::rename(&old, &new).map_err(|e| ProfileError::Unreadable(e.to_string()))
}

/// Delete the profile `name`; the default one cannot be.
pub fn delete(dir: &Path, name: &str) -> Result<(), ProfileError> {
    let path = file(dir, name)?;
    std::fs::remove_file(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ProfileError::Missing(name.to_string()),
        _ => ProfileError::Unreadable(e.to_string()),
    })
}

/// The tmux commands that put `profile` (named `name`) on `session`, over
/// the global settings, less the options the user's `tmuxy.conf` pins. The
/// default profile, or one that changes nothing, adds nothing.
pub fn session_commands(
    session: &str,
    name: &str,
    profile: &Profile,
    pinned: &[&str],
) -> Vec<String> {
    if name == DEFAULT_PROFILE {
        return Vec::new();
    }
    let on_off = |on: bool| if on { "on" } else { "off" }.to_string();
    let values = [
        (tmux_options::THEME, profile.theme.clone()),
        (tmux_options::THEME_MODE, profile.theme_mode.clone()),
        (tmux_options::CURSOR_BLINK, profile.cursor_blink.map(on_off)),
        (tmux_options::TRANSPARENCY, profile.transparency.map(on_off)),
    ];
    let target = crate::tmux_quote(session);
    std::iter::once((tmux_options::PROFILE, Some(name.to_string())))
        .chain(values)
        .filter(|(option, _)| !pinned.contains(option))
        .filter_map(|(option, value)| {
            Some(format!(
                "set-option -t {target} {option} {}",
                crate::tmux_quote(&value?)
            ))
        })
        .collect()
}

/// The commands that move `session` to the profile `name`: every option a
/// profile sets is unset on the session first, so nothing of the previous
/// profile stays, then `name`'s are set ([`session_commands`]). Switching to
/// the default profile only unsets: the session follows the global settings
/// again.
pub fn switch_commands(
    session: &str,
    name: &str,
    profile: &Profile,
    pinned: &[&str],
) -> Vec<String> {
    let target = crate::tmux_quote(session);
    SESSION_OPTIONS
        .iter()
        .map(|option| format!("set-option -t {target} -u {option}"))
        .chain(session_commands(session, name, profile, pinned))
        .collect()
}

#[cfg(test)]
#[path = "profiles_tests.rs"]
mod tests;
