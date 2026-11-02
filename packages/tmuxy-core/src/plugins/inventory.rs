//! What the UI knows about plugins: the global tmux options
//! `@tmuxy-plugins` (base64 JSON) and `@tmuxy-plugins-rev`.
//!
//! They live on the tmux server rather than in a file the web server reads
//! because the client's menus belong to whatever tmux server it shows: the web
//! UI's, a local desktop app's, and a desktop app attached over SSH to a
//! remote one alike. tmux announces no change to a user option, so only the
//! small `@tmuxy-plugins-rev` rides the pane-metadata subscription and the
//! `list-panes` rows (`tmux_formats`); a new rev makes the client read the
//! inventory itself with one `query`.
//!
//! Written by `tmuxy plugin install|update|remove`, by `tmuxy config reload`
//! (the user's own plugin), and by every monitor when it attaches, so a fresh
//! tmux server has it too.

use base64::Engine;
use serde::Serialize;

use super::registry::Registry;
use super::Dirs;
use crate::constants::tmux_options::{PLUGINS, PLUGINS_REV};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Plugin {
    pub name: String,
    pub actions: Vec<Action>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Action {
    pub id: String,
    pub title: String,
    /// `app`, `pane` or `selection`; absent for an action no menu offers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menu: Option<&'static str>,
    pub surface: &'static str,
}

/// The inventory of the plugins that run on this platform, the user's first.
pub fn build(registry: &Registry) -> Vec<Plugin> {
    registry
        .plugins
        .iter()
        .filter(|p| p.manifest.runs_here())
        .map(|p| Plugin {
            name: p.name.clone(),
            actions: p
                .manifest
                .actions_here()
                .map(|a| Action {
                    id: a.id.clone(),
                    title: a.title.clone(),
                    menu: a.menu.map(|m| m.as_str()),
                    surface: a.surface.as_str(),
                })
                .collect(),
        })
        .collect()
}

/// The option values: the base64 of the JSON, and a revision that changes
/// exactly when the JSON does (a hash of it), so publishing the same
/// inventory again sends no client to re-read it.
pub fn encode(plugins: &[Plugin]) -> (String, String) {
    let json = serde_json::to_string(plugins).unwrap_or_else(|_| "[]".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(json.as_bytes());
    (b64, format!("{:016x}", fnv1a(json.as_bytes())))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, b| {
        (hash ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// The tmux commands that publish the inventory. Both values are base64 or
/// hex, so they need no quoting on a command line.
pub fn commands(dirs: &Dirs) -> Vec<String> {
    let registry = Registry::load(dirs).unwrap_or_default();
    let (b64, rev) = encode(&build(&registry));
    vec![
        format!("set-option -g {PLUGINS} {b64}"),
        format!("set-option -g {PLUGINS_REV} {rev}"),
    ]
}

/// Publish from a CLI verb, through `tmux run-shell` so the write runs
/// inside the tmux server rather than as a client racing the control-mode
/// one (docs/TMUX.md). No server on the socket is no error: the next monitor
/// to attach publishes it.
pub fn publish(dirs: &Dirs) {
    let argv = crate::session::tmux_argv(false);
    let quoted: Vec<String> = argv.iter().map(|a| shell_word(a)).collect();
    let tmux = quoted.join(" ");
    let line = commands(dirs)
        .iter()
        .map(|c| format!("{tmux} {c}"))
        .collect::<Vec<_>>()
        .join(" && ");
    let _ = crate::session::tmux_command()
        .args(["run-shell", &line])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// One word for a shell line that run-shell format-expands first: single
/// quoted, `#` doubled.
pub fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/@%+-=:,".contains(&b));
    if plain {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', r"'\''")).replace('#', "##")
}
