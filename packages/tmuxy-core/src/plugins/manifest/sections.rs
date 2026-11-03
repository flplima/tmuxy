//! The manifest sections that point at an action or extend the app:
//! `[[link_handlers]]`, `[[keys]]`, `[[settings]]`, `depends` and
//! `[[themes]]`, as plain types, and the limits their validation
//! (`super::validate`) holds them to.

use std::collections::BTreeMap;

use serde::Serialize;

// ── Validated ───────────────────────────────────────────────────────────

/// A `[[link_handlers]]` entry: links in pane output that open an action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkHandler {
    pub id: String,
    pub matcher: LinkMatch,
    /// The `[[actions]]` id it opens.
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkMatch {
    /// A URL on one of `hosts` (lowercase, punycode), whose path matches
    /// `path_regex` whole when there is one.
    Url {
        hosts: Vec<String>,
        path_regex: Option<String>,
        /// `https`, plus `http` for a localhost host only.
        schemes: Vec<String>,
        /// Explicit ports allowed (localhost only); none means the default.
        ports: Vec<u16>,
    },
    /// Plain text a pattern matches (`src/main.rs:42`), named captures and all.
    Text { pattern: String },
}

/// A `[[keys]]` entry: a tmux key that opens an action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    /// As tmux prints it (`M-a`, `C-x`, `F5`, `PPage`).
    pub key: String,
    pub table: KeyTable,
    pub action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyTable {
    Prefix,
    Root,
}

impl KeyTable {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyTable::Prefix => "prefix",
            KeyTable::Root => "root",
        }
    }
}

/// A `[[settings]]` entry: a value the user sets with `tmuxy plugin config`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setting {
    pub key: String,
    pub kind: SettingType,
    pub default: Option<SettingValue>,
    pub description: String,
    /// Kept out of the context JSON, the log and every listing; the plugin
    /// reads it from `settings.toml` itself.
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingType {
    String,
    Bool,
    Int,
    Enum(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SettingValue {
    String(String),
    Bool(bool),
    Int(i64),
}

impl SettingType {
    pub fn describe(&self) -> String {
        match self {
            SettingType::String => "string".into(),
            SettingType::Bool => "bool".into(),
            SettingType::Int => "int".into(),
            SettingType::Enum(values) => format!("one of {}", values.join(", ")),
        }
    }

    /// A value from the command line, or why it is not one of this type.
    pub fn parse(&self, text: &str) -> Result<SettingValue, String> {
        match self {
            SettingType::String => Ok(SettingValue::String(text.to_string())),
            SettingType::Bool => match text {
                "true" | "yes" | "on" | "1" => Ok(SettingValue::Bool(true)),
                "false" | "no" | "off" | "0" => Ok(SettingValue::Bool(false)),
                _ => Err(format!("{text:?} is not true or false")),
            },
            SettingType::Int => text
                .trim()
                .parse()
                .map(SettingValue::Int)
                .map_err(|_| format!("{text:?} is not a whole number")),
            SettingType::Enum(values) if values.iter().any(|v| v == text) => {
                Ok(SettingValue::String(text.to_string()))
            }
            SettingType::Enum(values) => {
                Err(format!("{text:?} is not one of {}", values.join(", ")))
            }
        }
    }

    /// A value read back from TOML, when it is one of this type.
    pub fn accept(&self, value: &toml::Value) -> Option<SettingValue> {
        match (self, value) {
            (SettingType::String, toml::Value::String(s)) => Some(SettingValue::String(s.clone())),
            (SettingType::Bool, toml::Value::Boolean(b)) => Some(SettingValue::Bool(*b)),
            (SettingType::Int, toml::Value::Integer(i)) => Some(SettingValue::Int(*i)),
            (SettingType::Enum(values), toml::Value::String(s)) if values.contains(s) => {
                Some(SettingValue::String(s.clone()))
            }
            _ => None,
        }
    }
}

impl SettingValue {
    pub fn to_toml(&self) -> toml::Value {
        match self {
            SettingValue::String(s) => toml::Value::String(s.clone()),
            SettingValue::Bool(b) => toml::Value::Boolean(*b),
            SettingValue::Int(i) => toml::Value::Integer(*i),
        }
    }

    pub fn display(&self) -> String {
        match self {
            SettingValue::String(s) => s.clone(),
            SettingValue::Bool(b) => b.to_string(),
            SettingValue::Int(i) => i.to_string(),
        }
    }
}

/// A `depends` entry: another plugin this one needs installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub name: String,
    /// `owner/repo[/subdir]`.
    pub source: String,
    pub git_ref: Option<String>,
}

/// A `[[themes]]` entry: a stylesheet the theme menu offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Theme {
    pub id: String,
    /// A `.css` file inside the plugin.
    pub file: String,
}

// ── Limits ──────────────────────────────────────────────────────────────

/// The longest text pattern or path regex a manifest may carry.
pub const MAX_PATTERN_CHARS: usize = 256;

/// A pattern compiled with bounded memory: `regex` matches in linear time,
/// and these keep a crafted pattern from costing much to build.
pub fn compile(pattern: &str) -> Result<regex::Regex, String> {
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!("longer than {MAX_PATTERN_CHARS} characters"));
    }
    regex::RegexBuilder::new(pattern)
        .size_limit(256 * 1024)
        .dfa_size_limit(256 * 1024)
        .build()
        .map_err(|e| e.to_string().lines().last().unwrap_or_default().to_string())
}

pub(super) fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1")
}

/// A host as it must be written: lowercase ASCII (punycode for an IDN), a
/// DNS name or an IPv4 address, nothing else.
pub(super) fn is_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
}

/// A key in the subset of tmux's syntax a plugin may bind: modifiers, then
/// one letter or digit or a named key. `PageUp`/`PageDown` become tmux's
/// own names, so the key reads back from `list-keys` as written.
pub fn normalize_key(key: &str) -> Option<String> {
    let mut rest = key;
    let mut out = String::new();
    while let Some((m, tail)) = rest
        .split_once('-')
        .filter(|(m, tail)| matches!(*m, "C" | "M" | "S") && !tail.is_empty())
    {
        out.push_str(m);
        out.push('-');
        rest = tail;
    }
    const NAMED: &[&str] = &[
        "Up", "Down", "Left", "Right", "Home", "End", "PPage", "NPage", "Tab", "BTab", "Space",
        "Enter", "Escape", "BSpace", "DC", "IC",
    ];
    let name = match rest {
        "PageUp" => "PPage",
        "PageDown" => "NPage",
        other => other,
    };
    let single = name.len() == 1 && name.bytes().all(|b| b.is_ascii_alphanumeric());
    let function = name
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n));
    (single || function || NAMED.contains(&name)).then(|| {
        out.push_str(name);
        out
    })
}

/// The settings with their defaults, for the gate and `config`.
pub fn defaults(settings: &[Setting]) -> BTreeMap<String, SettingValue> {
    settings
        .iter()
        .filter_map(|s| s.default.clone().map(|d| (s.key.clone(), d)))
        .collect()
}
