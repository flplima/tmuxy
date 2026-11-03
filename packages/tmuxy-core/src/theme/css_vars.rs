//! The `@tmuxy-css-*` options: each sets one CSS variable on the page over
//! the theme file.

use super::CSS_VAR_PREFIX;
use crate::session;

/// A `show-options -g` line's value as tmux printed it: in double quotes
/// when it had to, with `"` and `\` escaped.
pub(super) fn unquote(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .map(|v| v.replace("\\\"", "\"").replace("\\\\", "\\"))
        .unwrap_or_else(|| value.to_string())
}

/// The `--name: value` pairs among `show-options -g` lines, as
/// `{ "name": "value" }` with the `--` dropped. tmux prints a value in double
/// quotes when it has to, escaping `"` and `\`. A name that could end a
/// declaration, or a value that could start another rule, is left out: the
/// client writes these into one style rule, one declaration each.
pub(super) fn parse_css_vars<'a>(
    lines: impl Iterator<Item = &'a str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut vars = serde_json::Map::new();
    for line in lines {
        let Some(rest) = line.strip_prefix(CSS_VAR_PREFIX) else {
            continue;
        };
        let (name, value) = rest.split_once(' ').unwrap_or((rest, ""));
        let value = unquote(value);
        let usable = session::is_safe_css_name(name) && is_safe_css_value(&value);
        if usable {
            vars.insert(name.to_string(), serde_json::Value::String(value));
        }
    }
    vars
}

/// A value that is one CSS declaration's value and nothing more: it cannot
/// end the declaration (`;`, `{`, `}`), comment out the ones after it
/// (`/*`), or fetch anything (`url(` and its kin, or a backslash escape that
/// would spell one).
fn is_safe_css_value(value: &str) -> bool {
    const FETCHES: [&str; 3] = ["url(", "src(", "image-set("];
    let lower = value.to_ascii_lowercase();
    !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, ';' | '{' | '}' | '\\'))
        && !lower.contains("/*")
        && !lower.contains("*/")
        && !FETCHES.iter().any(|f| lower.contains(f))
}
