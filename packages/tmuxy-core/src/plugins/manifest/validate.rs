use std::collections::HashSet;

use serde::Deserialize;
use toml::Spanned;

use super::super::{is_valid_name, source};
use super::report::Report;
use super::sections::{
    compile, is_host, is_local_host, normalize_key, Dependency, Key, KeyTable, LinkHandler,
    LinkMatch, Setting, SettingType, Theme,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawLink {
    id: Spanned<String>,
    #[serde(rename = "match")]
    kind: Spanned<String>,
    #[serde(default)]
    hosts: Option<Spanned<Vec<String>>>,
    #[serde(default)]
    path_regex: Option<Spanned<String>>,
    #[serde(default)]
    schemes: Option<Spanned<Vec<String>>>,
    #[serde(default)]
    ports: Option<Spanned<Vec<u16>>>,
    #[serde(default)]
    pattern: Option<Spanned<String>>,
    action: Spanned<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawKey {
    key: Spanned<String>,
    #[serde(default)]
    table: Option<Spanned<String>>,
    action: Spanned<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawSetting {
    key: Spanned<String>,
    #[serde(rename = "type")]
    kind: Spanned<String>,
    #[serde(default)]
    values: Option<Vec<String>>,
    #[serde(default)]
    default: Option<Spanned<toml::Value>>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    secret: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawDependency {
    name: String,
    source: String,
    #[serde(default, rename = "ref")]
    git_ref: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawTheme {
    id: Spanned<String>,
    file: Spanned<String>,
}

pub(super) fn links(
    raw: Vec<Spanned<RawLink>>,
    actions: &HashSet<String>,
    report: &mut Report<'_>,
) -> Vec<LinkHandler> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in raw {
        let span = raw.span();
        let l = raw.into_inner();
        let id = l.id.get_ref().clone();
        if !is_valid_name(&id) || !seen.insert(id.clone()) {
            report.at(
                l.id.span(),
                format!("link handler id {id:?} is malformed or declared twice"),
            );
        }
        if !actions.contains(l.action.get_ref()) {
            report.at(
                l.action.span(),
                format!("no [[actions]] entry has id {:?}", l.action.get_ref()),
            );
        }
        let matcher = match l.kind.get_ref().as_str() {
            "url" => {
                if let Some(p) = &l.pattern {
                    report.at(p.span(), "pattern belongs to match = \"text\"");
                }
                let hosts = l.hosts.map(Spanned::into_inner).unwrap_or_default();
                if hosts.is_empty() {
                    report.at(
                        span.clone(),
                        "match = \"url\" needs hosts = [\"example.com\"]",
                    );
                }
                for h in &hosts {
                    if !is_host(h) {
                        report.at(span.clone(), format!(
                            "host {h:?}: lowercase ASCII, punycode for an international name (xn--…)"
                        ));
                    }
                }
                let local = !hosts.is_empty() && hosts.iter().all(|h| is_local_host(h));
                let schemes = l
                    .schemes
                    .map(Spanned::into_inner)
                    .unwrap_or_else(|| vec!["https".into()]);
                for s in &schemes {
                    let ok = s == "https" || (s == "http" && local);
                    if !ok {
                        report.at(
                            span.clone(),
                            format!("scheme {s:?}: https, or http for localhost hosts only"),
                        );
                    }
                }
                let ports = l.ports.map(Spanned::into_inner).unwrap_or_default();
                if !ports.is_empty() && !local {
                    report.at(span.clone(), "ports are for localhost hosts only");
                }
                let path_regex = l.path_regex.map(|p| {
                    if let Err(e) = compile(&format!("^(?:{})$", p.get_ref())) {
                        report.at(p.span(), format!("path_regex: {e}"));
                    }
                    p.into_inner()
                });
                LinkMatch::Url {
                    hosts,
                    path_regex,
                    schemes,
                    ports,
                }
            }
            "text" => {
                if l.hosts.is_some()
                    || l.path_regex.is_some()
                    || l.schemes.is_some()
                    || l.ports.is_some()
                {
                    report.at(
                        span.clone(),
                        "hosts, path_regex, schemes and ports belong to match = \"url\"",
                    );
                }
                let pattern = match l.pattern {
                    Some(p) => {
                        if let Err(e) = compile(p.get_ref()) {
                            report.at(p.span(), format!("pattern: {e}"));
                        }
                        p.into_inner()
                    }
                    None => {
                        report.at(span.clone(), "match = \"text\" needs a pattern");
                        String::new()
                    }
                };
                LinkMatch::Text { pattern }
            }
            other => {
                report.at(
                    l.kind.span(),
                    format!("match {other:?}: \"url\" or \"text\""),
                );
                LinkMatch::Text {
                    pattern: String::new(),
                }
            }
        };
        out.push(LinkHandler {
            id,
            matcher,
            action: l.action.into_inner(),
        });
    }
    out
}

pub(super) fn keys(
    raw: Vec<Spanned<RawKey>>,
    actions: &HashSet<String>,
    report: &mut Report<'_>,
) -> Vec<Key> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in raw {
        let k = raw.into_inner();
        let table = match k.table.as_ref().map(|t| t.get_ref().as_str()) {
            None | Some("prefix") => KeyTable::Prefix,
            Some("root") => KeyTable::Root,
            Some(other) => {
                report.at(
                    k.table.as_ref().map(Spanned::span).unwrap_or_default(),
                    format!("table {other:?}: \"prefix\" or \"root\""),
                );
                KeyTable::Prefix
            }
        };
        let key = match normalize_key(k.key.get_ref()) {
            Some(key) => key,
            None => {
                report.at(k.key.span(), format!(
                    "key {:?}: C-/M-/S- modifiers, then a letter, a digit, F1-F12 or a named key (Up, Enter, PageUp, …)",
                    k.key.get_ref()
                ));
                k.key.get_ref().clone()
            }
        };
        if !seen.insert((table, key.clone())) {
            report.at(
                k.key.span(),
                format!("key {key} in {} is declared twice", table.as_str()),
            );
        }
        if !actions.contains(k.action.get_ref()) {
            report.at(
                k.action.span(),
                format!("no [[actions]] entry has id {:?}", k.action.get_ref()),
            );
        }
        out.push(Key {
            key,
            table,
            action: k.action.into_inner(),
        });
    }
    out
}

pub(super) fn settings(raw: Vec<Spanned<RawSetting>>, report: &mut Report<'_>) -> Vec<Setting> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in raw {
        let span = raw.span();
        let s = raw.into_inner();
        let key = s.key.get_ref().clone();
        let key_ok = !key.is_empty()
            && key.len() <= 40
            && key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !key_ok {
            report.at(
                s.key.span(),
                format!("setting key {key:?}: lowercase letters, digits and '_'"),
            );
        } else if !seen.insert(key.clone()) {
            report.at(s.key.span(), format!("setting {key:?} is declared twice"));
        }
        let kind = match (s.kind.get_ref().as_str(), s.values) {
            ("string", None) => SettingType::String,
            ("bool", None) => SettingType::Bool,
            ("int", None) => SettingType::Int,
            ("enum", Some(values)) if !values.is_empty() => SettingType::Enum(values),
            ("enum", _) => {
                report.at(
                    s.kind.span(),
                    "type = \"enum\" needs values = [\"a\", \"b\"]",
                );
                SettingType::Enum(Vec::new())
            }
            (_, Some(_)) => {
                report.at(s.kind.span(), "values belong to type = \"enum\"");
                SettingType::String
            }
            (other, None) => {
                report.at(
                    s.kind.span(),
                    format!("type {other:?}: string, bool, int or enum"),
                );
                SettingType::String
            }
        };
        if s.secret && kind != SettingType::String {
            report.at(span.clone(), "only a string setting can be secret");
        }
        let default = s.default.and_then(|d| {
            let value = kind.accept(d.get_ref());
            if value.is_none() {
                report.at(d.span(), format!("default is not {}", kind.describe()));
            }
            if s.secret {
                report.at(
                    d.span(),
                    "a secret has no default: the plugin would ship it",
                );
            }
            value
        });
        let description = s.description.unwrap_or_default();
        if description.chars().any(char::is_control) {
            report.at(span, "description must be one line of text");
        }
        out.push(Setting {
            key,
            kind,
            default,
            description,
            secret: s.secret,
        });
    }
    out
}

pub(super) fn depends(
    raw: Option<Spanned<Vec<RawDependency>>>,
    own_name: &str,
    report: &mut Report<'_>,
) -> Vec<Dependency> {
    let Some(raw) = raw else { return Vec::new() };
    let span = raw.span();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for d in raw.into_inner() {
        if !is_valid_name(&d.name) || d.name == own_name || !seen.insert(d.name.clone()) {
            report.at(
                span.clone(),
                format!(
                    "depends: {:?} is malformed, this plugin, or listed twice",
                    d.name
                ),
            );
        }
        match source::parse_repo(&d.source) {
            Ok(s) if s.git_ref.is_none() => {}
            Ok(_) => report.at(
                span.clone(),
                format!("depends: {:?}: the ref goes in ref = \"…\"", d.source),
            ),
            Err(e) => report.at(span.clone(), format!("depends: {e}")),
        }
        if d.git_ref.as_deref().is_some_and(|r| !source::is_ref(r)) {
            report.at(
                span.clone(),
                format!("depends: ref {:?} is malformed", d.git_ref),
            );
        }
        out.push(Dependency {
            name: d.name,
            source: d.source,
            git_ref: d.git_ref,
        });
    }
    out
}

pub(super) fn themes(raw: Vec<Spanned<RawTheme>>, report: &mut Report<'_>) -> Vec<Theme> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in raw {
        let t = raw.into_inner();
        let id = t.id.get_ref().clone();
        if !is_valid_name(&id) || !seen.insert(id.clone()) {
            report.at(
                t.id.span(),
                format!("theme id {id:?} is malformed or declared twice"),
            );
        }
        let file = t.file.get_ref().clone();
        let inside = std::path::Path::new(&file)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
        if !inside || !file.ends_with(".css") {
            report.at(
                t.file.span(),
                format!("file {file:?}: a .css file inside the plugin"),
            );
        }
        out.push(Theme { id, file });
    }
    out
}
