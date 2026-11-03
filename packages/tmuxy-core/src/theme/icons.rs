//! Process icons from `tmuxy.conf`: `@tmuxy-icon-<process> <icon>` is the
//! icon a pane running `<process>` wears in its header and the sidebar.
//!
//! The icon is a glyph — a character or two, a Nerd Font codepoint, an emoji
//! — or the name of an image (`.svg`, `.png`, `.jpg`, `.gif`, `.webp`) in the
//! config dir's `icons/`. An image is sent inline, as a `data:` URL, so both
//! transports carry it the same way and the page fetches nothing.
//! `@tmuxy-icon-filter` says how the client paints an image: `palette` puts
//! every pixel in the nearest theme colour, a colour's name (`foreground`,
//! `red`, `bright-blue`…) paints the whole icon in it, `none` leaves it be.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{Map, Value};

use super::css_vars::unquote;
use crate::constants::tmux_options;

/// The filter when the option is unset or names nothing.
const DEFAULT_FILTER: &str = "palette";

/// The theme colours a whole icon may be painted in: the terminal's own,
/// as the themes name them (`--term-<name>`).
pub const COLOURS: [&str; 17] = [
    "foreground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright-black",
    "bright-red",
    "bright-green",
    "bright-yellow",
    "bright-blue",
    "bright-magenta",
    "bright-cyan",
    "bright-white",
];

/// Largest image sent: an icon is drawn at text size, and every client gets
/// each one with the settings.
const MAX_IMAGE_BYTES: u64 = 256 * 1024;

/// Longest glyph icon, in characters: an icon, not a label.
const MAX_GLYPH_CHARS: usize = 4;

/// The image types an icon may be, by extension.
fn image_type(file: &str) -> Option<&'static str> {
    let ext = file.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// A process name as a pane reports it: an executable's file name.
fn is_process_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+'))
}

/// A file name in `icons/`, never a path out of it.
fn is_file_name(file: &str) -> bool {
    !file.starts_with('.') && !file.contains(['/', '\\']) && image_type(file).is_some()
}

/// A glyph the client can draw as text.
fn is_glyph(value: &str) -> bool {
    let count = value.chars().count();
    count > 0
        && count <= MAX_GLYPH_CHARS
        && !value.chars().any(char::is_control)
        && !value.starts_with("data:")
}

/// The icon options among `show-options -g` lines, and the filter:
/// `{ "filter": "...", "map": { "<process>": "<glyph or file name>" } }`.
/// Process names are lowercased, as the client matches them.
pub(super) fn parse<'a>(lines: impl Iterator<Item = &'a str>) -> Value {
    let mut map = Map::new();
    let mut filter = DEFAULT_FILTER.to_string();
    for line in lines {
        let Some(rest) = line.strip_prefix(tmux_options::ICON_PREFIX) else {
            continue;
        };
        let (name, value) = rest.split_once(' ').unwrap_or((rest, ""));
        let value = unquote(value);
        // `@tmuxy-icon-filter` shares the prefix.
        if tmux_options::ICON_FILTER.strip_prefix(tmux_options::ICON_PREFIX) == Some(name) {
            if value == "none" || value == DEFAULT_FILTER || COLOURS.contains(&value.as_str()) {
                filter = value;
            }
            continue;
        }
        let name = name.to_ascii_lowercase();
        if is_process_name(&name) && (is_file_name(&value) || is_glyph(&value)) {
            map.insert(name, Value::String(value));
        }
    }
    serde_json::json!({ "filter": filter, "map": map })
}

/// The image icons in `icons` (what [`parse`] returned) read from `dir`, as
/// `data:` URLs. One that is missing, unreadable or too large is dropped:
/// the pane wears its built-in icon instead.
pub(super) fn inline_images(icons: &mut Value, dir: &Path) {
    let Some(map) = icons.get_mut("map").and_then(Value::as_object_mut) else {
        return;
    };
    map.retain(|_, value| {
        let Some(file) = value.as_str().filter(|v| is_file_name(v)) else {
            return true;
        };
        let Some(mime) = image_type(file) else {
            return false;
        };
        let path = dir.join(file);
        let small =
            std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= MAX_IMAGE_BYTES);
        let Some(bytes) = small.then(|| std::fs::read(&path).ok()).flatten() else {
            return false;
        };
        *value = Value::String(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
        true
    });
}

#[cfg(test)]
#[path = "icons_tests.rs"]
mod tests;
