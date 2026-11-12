//! A trace made fit to share: every value that could say something about the
//! user replaced, the shape of what happened kept.
//!
//! A trace taken at `labeled` or `full` holds session names, paths, error
//! text and command arguments; one at `shape` already holds none, but an
//! export is redacted whatever the level, so a user never has to know which
//! one they recorded at. What survives:
//!
//! - numbers, booleans and nulls (timing, counts, sizes, sequence numbers;
//!   a port or a process id is a number too, and passes);
//! - the typed names of what happened (`layer`, `name`, `op`, `kind`, …),
//!   only when they look like an identifier: letters, digits, `-` and `_`;
//! - ids (`%3`, `@1`, an `action_id`), only when they look like one.
//!
//! Everything else becomes a placeholder named for its key and numbered by
//! first appearance (`session-1`, `path-2`, `text-1`), the same value always
//! getting the same placeholder, so a reader still sees that two lines are
//! about the same session without learning its name. A command keeps its
//! tmux verb and loses its arguments.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

/// Keys whose value is the typed name of something: kept when it looks like
/// an identifier.
const NAMES: &[&str] = &[
    "layer", "name", "phase", "level", "op", "kind", "variant", "code", "verb", "shell",
];

/// Keys whose value is an id tmux or tmuxy made: kept when it looks like one.
const IDS: &[&str] = &["pane", "window", "action_id", "conn_id"];

/// Numbering of the values replaced so far, by key.
#[derive(Default)]
struct Placeholders {
    seen: HashMap<(String, String), usize>,
    counts: HashMap<String, usize>,
}

impl Placeholders {
    fn of(&mut self, key: &str, value: &str) -> Value {
        let label = match key {
            "error" | "message" | "reason" => "text",
            "args" | "command" => "args",
            key if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => key,
            _ => "value",
        };
        let next = self.counts.get(label).copied().unwrap_or(0) + 1;
        let n = *self
            .seen
            .entry((label.to_string(), value.to_string()))
            .or_insert_with(|| {
                self.counts.insert(label.to_string(), next);
                next
            });
        Value::from(format!("{label}-{n}"))
    }
}

fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    text.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn module_path(text: &str) -> bool {
    text.len() <= 96 && text.split("::").all(identifier)
}

fn id(text: &str) -> bool {
    let body = text.strip_prefix(['%', '@', '$']).unwrap_or(text);
    !body.is_empty()
        && body.len() <= 64
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn value(key: &str, value: &Value, names: &mut Placeholders) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => {
            let keep = (NAMES.contains(&key) && identifier(text))
                || (key == "component" && module_path(text))
                || (IDS.contains(&key) && id(text));
            if keep {
                return value.clone();
            }
            if key == "command" {
                // The tmux verb says what ran; its arguments may say anything.
                let verb = text.split_whitespace().next().unwrap_or_default();
                if identifier(verb) {
                    return Value::from(format!("{verb} …"));
                }
            }
            names.of(key, text)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| self::value(key, v, names)).collect())
        }
        Value::Object(map) => Value::Object(object(map, names)),
    }
}

fn object(map: &Map<String, Value>, names: &mut Placeholders) -> Map<String, Value> {
    map.iter()
        .map(|(key, v)| {
            // A key the writers do not use (a map keyed by something a user
            // named) is replaced as well.
            let shown = if field_name(key) {
                key.clone()
            } else {
                names.of("key", key).as_str().unwrap_or("key").to_string()
            };
            (shown, value(key, v, names))
        })
        .collect()
}

/// A key the trace's writers use: the schema's fields, and the few the
/// tools write themselves (a marker's label, an overflow line's count).
fn field_name(key: &str) -> bool {
    super::schema::class_of(key).is_some() || ["label", "dropped"].contains(&key)
}

/// `events`, redacted for sharing, in order.
pub fn redact_for_sharing(events: &[Map<String, Value>]) -> Vec<Map<String, Value>> {
    let mut names = Placeholders::default();
    events.iter().map(|ev| object(ev, &mut names)).collect()
}

/// The trace's lines as objects; a blank or malformed line is skipped.
pub fn parse_lines(content: &str) -> Vec<Map<String, Value>> {
    content
        .lines()
        .filter_map(|line| match serde_json::from_str::<Value>(line.trim()) {
            Ok(Value::Object(m)) => Some(m),
            _ => None,
        })
        .collect()
}

/// The last `n` actions (an `action_id` each, one per thing the user did):
/// every event from the first of them to the last, the uncorrelated ones in
/// between included.
pub fn last_actions(events: &[Map<String, Value>], n: usize) -> Vec<Map<String, Value>> {
    let mut first_seen: BTreeMap<&str, usize> = BTreeMap::new();
    let mut last_seen: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, ev) in events.iter().enumerate() {
        if let Some(id) = ev.get("action_id").and_then(Value::as_str) {
            first_seen.entry(id).or_insert(i);
            last_seen.insert(id, i);
        }
    }
    let mut by_recency: Vec<(&str, usize)> = last_seen.into_iter().collect();
    by_recency.sort_by_key(|&(_, i)| std::cmp::Reverse(i));
    let kept = &by_recency[..n.min(by_recency.len())];
    let start = kept
        .iter()
        .filter_map(|(id, _)| first_seen.get(id).copied())
        .min();
    match (start, kept.first()) {
        (Some(start), Some(&(_, end))) => events[start..=end].to_vec(),
        _ => Vec::new(),
    }
}

/// The last `last` actions of the trace file, redacted for sharing, as
/// NDJSON, and how many lines that is. What the Debug menu's Copy Trace
/// shows and copies.
pub fn shared_slice(last: usize) -> Result<(String, usize), String> {
    let path = super::trace_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|_| "there is no trace yet: turn traces on and try again".to_string())?;
    let events = redact_for_sharing(&last_actions(&parse_lines(&content), last));
    let text: String = events
        .iter()
        .map(|ev| format!("{}\n", Value::Object(ev.clone())))
        .collect();
    Ok((text, events.len()))
}

#[cfg(test)]
#[path = "share_tests.rs"]
mod tests;
