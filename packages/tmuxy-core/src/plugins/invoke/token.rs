//! Invocation tokens: what an action's command should know, in an
//! owner-only file named by a random id, read once.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::super::registry::Registry;
use super::super::{private_dir, random_hex, PluginError, Result};
use crate::paths::Layout;

/// A token older than this is refused: it belongs to a launch that failed.
const TOKEN_TTL_SECS: u64 = 600;

/// The most selected text an action receives.
pub const MAX_SELECTION_BYTES: usize = 1024 * 1024;

/// What started an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    /// A menu item in the UI.
    Menu,
    /// `tmuxy plugin action` from a shell or script.
    Action,
    /// A `[[cli]]` verb.
    Cli,
    /// A `[[keys]]` binding.
    Key,
    /// A `[[link_handlers]]` match on a click.
    Link,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Menu => "menu",
            Trigger::Action => "action",
            Trigger::Cli => "cli",
            Trigger::Key => "key",
            Trigger::Link => "link",
        }
    }
}

/// The pane an action is about, as tmux described it when the action opened.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneInfo {
    pub cwd: String,
    pub command: String,
    pub tab: String,
    pub session: String,
}

/// An invocation token's file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Token {
    pub plugin: String,
    pub action: String,
    pub trigger: Trigger,
    /// The target pane (`%N`).
    pub pane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    /// Extra arguments (`tmuxy plugin action p:a -- args…`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<PaneInfo>,
    /// The link a click matched (`[[link_handlers]]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<super::super::links::LinkInfo>,
    /// Someone waits on the command (`tmuxy plugin action --wait`): it
    /// leaves its exit status behind for them, and only then.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wait: bool,
    pub created: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// A pane id as tmux names one.
pub fn is_pane_id(pane: &str) -> bool {
    pane.strip_prefix('%')
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub(super) fn is_token_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub(super) fn token_path(dirs: &Layout, id: &str) -> PathBuf {
    dirs.run_dir().join(format!("{id}.json"))
}

/// Where `exec` leaves the command's exit status, for `action --wait`.
pub fn status_path(dirs: &Layout, id: &str) -> PathBuf {
    dirs.run_dir().join(format!("{id}.status"))
}

pub(super) fn selection_path(dirs: &Layout, id: &str) -> PathBuf {
    dirs.run_dir().join(format!("{id}.selection"))
}

impl Token {
    pub fn new(plugin: &str, action: &str, trigger: Trigger, pane: &str) -> Self {
        Token {
            plugin: plugin.to_string(),
            action: action.to_string(),
            trigger,
            pane: pane.to_string(),
            selection: None,
            args: Vec::new(),
            info: None,
            link: None,
            wait: false,
            created: now(),
        }
    }

    /// Write it under a fresh id, owner-only.
    pub fn create(&self, dirs: &Layout) -> Result<String> {
        let id = random_hex()?;
        self.write(dirs, &id)?;
        Ok(id)
    }

    pub(super) fn write(&self, dirs: &Layout, id: &str) -> Result<()> {
        private_dir(&dirs.run_dir())?;
        let json = serde_json::to_vec(self).map_err(|e| PluginError::Invalid(e.to_string()))?;
        let path = token_path(dirs, id);
        crate::private_files::write(&path, json)
            .map_err(|e| PluginError::io(format!("writing {}", path.display()), e))
    }

    /// Read a token without consuming it.
    pub fn read(dirs: &Layout, id: &str) -> Result<Token> {
        if !is_token_id(id) {
            return Err(PluginError::Invalid(format!(
                "{id:?} is not an invocation token"
            )));
        }
        let path = token_path(dirs, id);
        let bytes = std::fs::read(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                PluginError::NotFound(
                    "the invocation token is gone (already used, or expired)".into(),
                )
            } else {
                PluginError::io(format!("reading {}", path.display()), e)
            }
        })?;
        let token: Token = serde_json::from_slice(&bytes)
            .map_err(|e| PluginError::Invalid(format!("invocation token: {e}")))?;
        if now().saturating_sub(token.created) > TOKEN_TTL_SECS {
            let _ = std::fs::remove_file(&path);
            return Err(PluginError::Invalid("the invocation token expired".into()));
        }
        Ok(token)
    }

    /// Read a token and delete it: each one launches one command.
    pub fn take(dirs: &Layout, id: &str) -> Result<Token> {
        let token = Token::read(dirs, id)?;
        let _ = std::fs::remove_file(token_path(dirs, id));
        Ok(token)
    }
}

/// The token a menu action with selected text opens with: the server writes
/// it (the selection never touches a command line) and the client names it in
/// `TmuxOp.PluginAction`.
pub fn prepare(
    dirs: &Layout,
    plugin: &str,
    action: &str,
    pane: &str,
    selection: Option<String>,
) -> Result<String> {
    if !is_pane_id(pane) {
        return Err(PluginError::Invalid(format!("{pane:?} is not a pane id")));
    }
    if selection
        .as_ref()
        .is_some_and(|s| s.len() > MAX_SELECTION_BYTES)
    {
        return Err(PluginError::Invalid(format!(
            "the selection is larger than {MAX_SELECTION_BYTES} bytes"
        )));
    }
    let registry = Registry::load(dirs)?;
    registry.action(plugin, action)?;
    let mut token = Token::new(plugin, action, Trigger::Menu, pane);
    token.selection = selection;
    token.create(dirs)
}
