//! The plugin index: every public GitHub repository with the topic
//! `tmuxy-plugin` whose manifests pass `tmuxy plugin check`, rebuilt every
//! six hours (`bin/plugin-index.mjs`, `.github/workflows/plugin-index.yml`)
//! and published on the `plugin-index` branch.
//!
//! It is a convenience, not a trust signal: `tmuxy plugin install <name>`
//! only turns the name into `owner/repo[/subdir]`, then installs as from a
//! repository, at the commit the gate shows, never the one the index lists.

use serde::{Deserialize, Serialize};

use super::{PluginError, Result};

pub const DEFAULT_INDEX: &str =
    "https://raw.githubusercontent.com/flplima/tmuxy/plugin-index/plugins.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Index {
    #[serde(default)]
    pub generated: String,
    #[serde(default)]
    pub plugins: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IndexEntry {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// `owner/repo[/subdir]`.
    pub source: String,
    #[serde(default)]
    pub sha: String,
    #[serde(default)]
    pub stars: u64,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    /// Another entry has the same name: install this one by its source.
    #[serde(default)]
    pub duplicate: bool,
}

/// `TMUXY_PLUGIN_INDEX` (a URL, or a file the test suites point at), else
/// the published index.
pub fn location() -> String {
    std::env::var("TMUXY_PLUGIN_INDEX")
        .ok()
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| DEFAULT_INDEX.to_string())
}

pub fn load() -> Result<Index> {
    let at = location();
    let text = if at.starts_with("https://") {
        let out = std::process::Command::new("curl")
            .args(["-fsSL", "--max-time", "20", "--proto", "=https", "--", &at])
            .output()
            .map_err(|e| PluginError::io("running curl for the plugin index", e))?;
        if !out.status.success() {
            return Err(PluginError::Invalid(format!(
                "could not read the plugin index at {at}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        let path = at.strip_prefix("file://").unwrap_or(&at);
        std::fs::read_to_string(path)
            .map_err(|e| PluginError::io(format!("reading the plugin index {path}"), e))?
    };
    serde_json::from_str(&text)
        .map_err(|e| PluginError::Invalid(format!("the plugin index at {at} is not one: {e}")))
}

/// The entries whose name, description or source contains every word of
/// `query` (any case); every entry for an empty query.
pub fn search<'a>(index: &'a Index, query: &str) -> Vec<&'a IndexEntry> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    index
        .plugins
        .iter()
        .filter(|e| {
            let hay = format!("{} {} {}", e.name, e.description, e.source).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .collect()
}

/// The one entry named `name`. Two repositories claiming a name install by
/// their source only.
pub fn by_name<'a>(index: &'a Index, name: &str) -> Result<&'a IndexEntry> {
    let found: Vec<&IndexEntry> = index.plugins.iter().filter(|e| e.name == name).collect();
    match found.as_slice() {
        [one] => Ok(one),
        [] => Err(PluginError::NotFound(format!(
            "no plugin named {name:?} in the index (`tmuxy plugin search`)"
        ))),
        many => Err(PluginError::Invalid(format!(
            "{} repositories call their plugin {name:?}; install one by its source: {}",
            many.len(),
            many.iter()
                .map(|e| e.source.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}
