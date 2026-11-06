//! Process icons from `tmuxy.conf`: `@tmuxy-icon-<process> <icon>` is the
//! icon a pane running `<process>` wears in its header and the sidebar.
//!
//! The icon is one or two ASCII characters (`$`, `>_`), or the name of an
//! SVG in the config dir's `icons/`. An SVG is sent inline, as a `data:` URL,
//! so both transports carry it the same way and the page fetches nothing;
//! the client draws its shape in the text colour beside it.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{Map, Value};

use super::css_vars::unquote;
use crate::constants::tmux_options;

/// Largest SVG sent: an icon is drawn at text size, and every client gets
/// each one with the settings.
const MAX_SVG_BYTES: u64 = 64 * 1024;

/// Longest text icon, in characters: an icon, not a label.
const MAX_TEXT_CHARS: usize = 2;

fn is_process_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+'))
}

/// An SVG's file name in `icons/`, never a path out of it.
fn is_svg_name(file: &str) -> bool {
    !file.starts_with('.')
        && !file.contains(['/', '\\'])
        && file
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("svg"))
}

fn is_text_icon(value: &str) -> bool {
    value.len() <= MAX_TEXT_CHARS
        && value.bytes().all(|b| b == b' ' || b.is_ascii_graphic())
        && value.bytes().any(|b| b.is_ascii_graphic())
}

/// The icon options among `show-options -g` lines:
/// `{ "<process>": "<text or SVG file name>" }`. Process names are
/// lowercased, as the client matches them.
pub(super) fn parse<'a>(lines: impl Iterator<Item = &'a str>) -> Map<String, Value> {
    let mut map = Map::new();
    for line in lines {
        let Some(rest) = line.strip_prefix(tmux_options::ICON_PREFIX) else {
            continue;
        };
        let (name, value) = rest.split_once(' ').unwrap_or((rest, ""));
        let value = unquote(value);
        let name = name.to_ascii_lowercase();
        if is_process_name(&name) && (is_svg_name(&value) || is_text_icon(&value)) {
            map.insert(name, Value::String(value));
        }
    }
    map
}

/// The SVG icons in `icons` (what [`parse`] returned) read from `dir`, as
/// `data:` URLs. One that is missing, too large or not an SVG is dropped:
/// the pane wears its built-in icon instead.
pub(super) fn inline_svgs(icons: &mut Map<String, Value>, dir: &Path) {
    icons.retain(|_, value| {
        let Some(file) = value.as_str().filter(|v| is_svg_name(v)) else {
            return true;
        };
        let path = dir.join(file);
        let small = std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= MAX_SVG_BYTES);
        let Some(svg) = small
            .then(|| std::fs::read_to_string(&path).ok())
            .flatten()
            .filter(|text| text.contains("<svg"))
        else {
            return false;
        };
        *value = Value::String(format!(
            "data:image/svg+xml;base64,{}",
            STANDARD.encode(svg)
        ));
        true
    });
}

#[cfg(test)]
#[path = "icons_tests.rs"]
mod tests;
