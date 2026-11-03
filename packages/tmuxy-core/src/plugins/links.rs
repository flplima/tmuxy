//! Link handlers: a click on a URL or on text in a pane that opens a
//! plugin's action instead of the browser.
//!
//! Pane output is untrusted, so the client only pre-selects: it sends a URL
//! whose host is in the inventory (`open_link`), or the clicked line and
//! column (`open_text`), and this module decides. A URL is checked as
//! parsed (scheme, no userinfo, the exact punycode host, no port but an
//! allowed one, the path regex matched whole), never as a string. A text
//! pattern runs in Rust's linear-time `regex` over one line, never as a JS
//! regex in the page, where a crafted pattern over crafted output could
//! freeze the UI.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::invoke::{Token, Trigger};
use super::manifest::{sections::compile, LinkHandler, LinkMatch};
use super::registry::{Installed, Registry};
use super::{Dirs, PluginError, Result};

/// The longest URL or line a handler is matched against.
pub const MAX_LINK_CHARS: usize = 4096;

/// What the action is told about the link (`link` in the context JSON).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub captures: BTreeMap<String, String>,
}

/// The handler a link matched, and what it matched.
pub struct Found<'a> {
    pub plugin: &'a Installed,
    pub handler: &'a LinkHandler,
    pub link: LinkInfo,
}

/// Every handler on this platform whose action runs here, in install order:
/// the user's own plugin first, then the lockfile's.
fn handlers(registry: &Registry) -> impl Iterator<Item = (&Installed, &LinkHandler)> {
    registry
        .plugins
        .iter()
        .filter(|p| p.manifest.runs_here())
        .flat_map(|p| p.manifest.link_handlers.iter().map(move |h| (p, h)))
        .filter(|(p, h)| p.manifest.actions_here().any(|a| a.id == h.action))
}

/// Whether `url` is one `matcher` takes.
pub fn url_matches(matcher: &LinkMatch, url: &url::Url) -> bool {
    let LinkMatch::Url {
        hosts,
        path_regex,
        schemes,
        ports,
    } = matcher
    else {
        return false;
    };
    if !schemes.iter().any(|s| s == url.scheme()) {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if !hosts.iter().any(|h| h == host) {
        return false;
    }
    if let Some(port) = url.port() {
        if !ports.contains(&port) {
            return false;
        }
    }
    match path_regex {
        None => true,
        Some(re) => compile(&format!("^(?:{re})$")).is_ok_and(|re| re.is_match(url.path())),
    }
}

/// The first handler that takes `raw`, a URL from a pane.
pub fn match_url<'a>(registry: &'a Registry, raw: &str) -> Option<Found<'a>> {
    if raw.chars().count() > MAX_LINK_CHARS {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    handlers(registry)
        .find(|(_, h)| url_matches(&h.matcher, &url))
        .map(|(plugin, handler)| Found {
            plugin,
            handler,
            link: LinkInfo {
                url: Some(url.to_string()),
                ..LinkInfo::default()
            },
        })
}

/// What a text pattern matches in `line` at `column` (in characters), with
/// its named captures.
pub fn text_matches(pattern: &str, line: &str, column: usize) -> Option<LinkInfo> {
    let re = compile(pattern).ok()?;
    let at = line
        .char_indices()
        .nth(column)
        .map(|(byte, _)| byte)
        .unwrap_or(line.len());
    let found = re.captures_iter(line).find_map(|caps| {
        let whole = caps.get(0)?;
        if whole.start() > at || at >= whole.end().max(whole.start() + 1) {
            return None;
        }
        let captures = re
            .capture_names()
            .flatten()
            .filter_map(|name| {
                caps.name(name)
                    .map(|m| (name.to_string(), m.as_str().to_string()))
            })
            .collect();
        Some(LinkInfo {
            text: Some(whole.as_str().to_string()),
            captures,
            ..LinkInfo::default()
        })
    });
    found
}

/// The first text handler whose pattern covers `column` of `line`.
pub fn match_text<'a>(registry: &'a Registry, line: &str, column: usize) -> Option<Found<'a>> {
    if line.chars().count() > MAX_LINK_CHARS {
        return None;
    }
    handlers(registry).find_map(|(plugin, handler)| match &handler.matcher {
        LinkMatch::Text { pattern } => text_matches(pattern, line, column).map(|link| Found {
            plugin,
            handler,
            link,
        }),
        LinkMatch::Url { .. } => None,
    })
}

/// What `open_link` / `open_text` answer: the action to run and the token
/// that carries the link, for the client's `TmuxOp.PluginAction`.
#[derive(Debug, Clone, Serialize)]
pub struct Prepared {
    pub plugin: String,
    pub action: String,
    pub token: String,
}

/// Prepare the action a link opens on `pane`: the URL is also the command's
/// last argument, as `tmuxy plugin action <plugin>:<id> -- <url>` passes it.
/// `None` when no handler takes it (the client then opens a URL in the
/// browser as before).
pub fn prepare(dirs: &Dirs, found: Option<Found<'_>>, pane: &str) -> Result<Option<Prepared>> {
    let Some(found) = found else {
        return Ok(None);
    };
    if !super::invoke::is_pane_id(pane) {
        return Err(PluginError::Invalid(format!("{pane:?} is not a pane id")));
    }
    let mut token = Token::new(
        &found.plugin.name,
        &found.handler.action,
        Trigger::Link,
        pane,
    );
    if let Some(url) = &found.link.url {
        token.args = vec![url.clone()];
    }
    token.link = Some(found.link);
    let id = token.create(dirs)?;
    Ok(Some(Prepared {
        plugin: found.plugin.name.clone(),
        action: found.handler.action.clone(),
        token: id,
    }))
}
