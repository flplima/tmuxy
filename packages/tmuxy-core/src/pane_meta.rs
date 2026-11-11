//! A pane's custom fields (`tmuxy pane meta`): short `key value` pairs a
//! script or an agent sets on a pane for its tree row to show, each until it
//! is unset or, with a time to live, until its time is up.
//!
//! They are kept in one pane option, `@tmuxy-meta`, as base64 of a JSON
//! object, so any text survives the tab-separated pane listing that reads
//! them back. The rules for what a field may hold are here and only here:
//! the verb applies them when it writes, and a reader that finds a value
//! that breaks them shows nothing of it.

use std::collections::BTreeMap;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// A pane holds at most this many fields: a row has room for a few.
pub const MAX_FIELDS: usize = 8;
/// A value longer than this is refused, not cut: a cut value can say
/// something else.
pub const MAX_VALUE_CHARS: usize = 80;
const MAX_KEY_CHARS: usize = 24;

/// One field's value, and when it stops being shown (seconds since the
/// epoch), if it has a time to live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    #[serde(rename = "v")]
    pub value: String,
    #[serde(rename = "until", default, skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
}

/// A pane's fields, by key, in key order.
pub type Fields = BTreeMap<String, Field>;

/// `key` as a field's name: a lowercase letter, then up to 23 lowercase
/// letters, digits, `-` or `_`. Short and plain, as the row shows it.
pub fn check_key(key: &str) -> Result<(), String> {
    let mut chars = key.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if first_ok && rest_ok && key.len() <= MAX_KEY_CHARS {
        Ok(())
    } else {
        Err(format!(
            "`{key}` is not a field name: a lowercase letter, then up to {} of a-z 0-9 - _",
            MAX_KEY_CHARS - 1
        ))
    }
}

/// `value` as a field's value: control characters taken out (a value is
/// one line of text in a row), surrounding spaces trimmed, and refused when
/// empty or longer than [`MAX_VALUE_CHARS`].
pub fn clean_value(value: &str) -> Result<String, String> {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return Err("a field's value is empty (unset the field instead)".into());
    }
    if cleaned.chars().count() > MAX_VALUE_CHARS {
        return Err(format!(
            "a field's value is longer than {MAX_VALUE_CHARS} characters"
        ));
    }
    Ok(cleaned)
}

/// The option's value for `fields`; empty for none, which the verb writes
/// as an unset option.
pub fn encode(fields: &Fields) -> String {
    if fields.is_empty() {
        return String::new();
    }
    let json = serde_json::to_string(fields).unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(json)
}

/// The fields in an option's value. Nothing for an empty value, and nothing
/// for one that is not fields, or holds one that breaks the rules: the
/// option is writable by anything on the socket.
pub fn decode(option: &str) -> Fields {
    let option = option.trim();
    if option.is_empty() {
        return Fields::new();
    }
    let Some(fields) = base64::engine::general_purpose::STANDARD
        .decode(option)
        .ok()
        .and_then(|json| serde_json::from_slice::<Fields>(&json).ok())
    else {
        return Fields::new();
    };
    let valid = fields.len() <= MAX_FIELDS
        && fields.iter().all(|(key, field)| {
            check_key(key).is_ok()
                && clean_value(&field.value).as_deref() == Ok(field.value.as_str())
        });
    if valid {
        fields
    } else {
        Fields::new()
    }
}

/// `fields` without those whose time is up at `now`.
pub fn live(mut fields: Fields, now: u64) -> Fields {
    fields.retain(|_, field| field.until.is_none_or(|until| until > now));
    fields
}

/// A time to live as `30s`, `5m`, `2h` or `1d`, in seconds.
pub fn parse_ttl(ttl: &str) -> Result<u64, String> {
    let bad = || format!("`{ttl}` is not a time to live: a number and s, m, h or d (`5m`)");
    let (number, unit) = ttl.split_at(ttl.len().saturating_sub(1));
    let scale = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return Err(bad()),
    };
    let n: u64 = number.parse().map_err(|_| bad())?;
    if n == 0 {
        return Err(bad());
    }
    n.checked_mul(scale).ok_or_else(bad)
}

#[cfg(test)]
mod tests;
