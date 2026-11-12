//! Terminal profiles: named sets of the settings the menus manage (theme and
//! mode, cursor blink, asking before a send, transparency), one per tmux
//! session if the user wants.
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
//! `@tmuxy-profile` naming it.

use std::path::{Path, PathBuf};

use crate::constants::tmux_options;
use crate::paths::Layout;

/// The profile every session has until it is given another: no file, no
/// changes.
pub const DEFAULT_PROFILE: &str = "Default Profile";

/// The most characters a profile's name may have.
const MAX_NAME_CHARS: usize = 64;

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
    pub send_ask: Option<bool>,
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
            Self::Unreadable(why) => write!(f, "{why}"),
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
    serde_json::from_str(&text).map_err(|e| ProfileError::Unreadable(format!("{name}: {e}")))
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
        (tmux_options::SEND_ASK, profile.send_ask.map(on_off)),
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

#[cfg(test)]
#[path = "profiles_tests.rs"]
mod tests;
