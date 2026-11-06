//! The `@tmuxy-css-*` options: each sets one CSS variable on the page over
//! the theme file.

use crate::constants::tmux_options::CSS_VAR_PREFIX;
use crate::session;

/// A `show-options -g` line's value as tmux printed it: single-quoted
/// (literal), double-quoted, or bare — and in the last two a backslash
/// escapes the character after it (`\$`, `\#`, `\~`, `\\`, `\"`). Only
/// `\"` and `\\` were undone, so an icon of `'$'` reached the page as `\$`.
pub(super) fn unquote(value: &str) -> String {
    let value = value.trim();
    if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        return inner.to_string();
    }
    let inner = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
                continue;
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
#[test]
fn a_value_reads_back_as_set_whichever_way_tmux_printed_it() {
    // What `show-options -g` printed for each value (tmux 3.5a).
    for (printed, set) in [
        (r#"\$"#, "$"),
        (r#"\#"#, "#"),
        (r#"\~"#, "~"),
        (r#"a\\b"#, r#"a\b"#),
        (r#"'a"b'"#, r#"a"b"#),
        (r#""a;b""#, "a;b"),
        (r#""it's""#, "it's"),
        (r#""{x}""#, "{x}"),
        (r##""#101010""##, "#101010"),
        (r#""$ ""#, "$ "),
    ] {
        assert_eq!(unquote(printed), set, "{printed}");
    }
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
