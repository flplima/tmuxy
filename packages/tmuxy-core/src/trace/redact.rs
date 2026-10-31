//! Redaction helpers: what a value becomes before it is written to the trace.

use std::hash::{Hash, Hasher};

use super::{salt, MAX_FULL, MAX_SCRUB};

/// Stable, non-cryptographic hash for de-identifying a name/path. `DefaultHasher`
/// uses fixed keys, so the id is stable within and across runs — enough to
/// correlate "same window" without recording the window's name.
pub(super) fn hash_str(s: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    salt().hash(&mut h);
    s.hash(&mut h);
    format!("h:{:016x}", h.finish())
}

/// Redact the home directory to `~` and truncate. serde escaping already keeps
/// newlines from breaking the NDJSON framing; this bounds size and strips the
/// most common absolute-path leak.
pub(super) fn scrub(s: &str) -> String {
    let replaced = match dirs::home_dir().and_then(|h| h.to_str().map(String::from)) {
        Some(home) if !home.is_empty() => s.replace(&home, "~"),
        _ => s.to_string(),
    };
    replaced.chars().take(MAX_SCRUB).collect()
}

/// Truncate to `n` chars without any redaction (used for values already deemed
/// safe, or at `Full` where content is explicitly opted in).
pub(super) fn bound(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A `FULL_ONLY` value as it is written at `Full`: keystrokes cut out, bounded.
pub(super) fn full_only(s: &str) -> String {
    bound(&redact_command(s), MAX_FULL)
}

/// Whether a command word's arguments are what the user typed or pasted:
/// `send-keys` (its `send` alias, and the prefixes tmux accepts for it) and
/// `set-buffer` (`setb`, `set-b…`).
fn carries_keystrokes(word: &str) -> bool {
    let word = word.trim_start_matches(['\'', '"']);
    word.starts_with("send") || word.starts_with("set-b") || word == "setb"
}

/// A tmux command line with everything after its first keystroke-carrying
/// command cut to `…`, so a log or trace line names the command but never the
/// keys, password or paste it delivered. Words split on whitespace and `;`, so
/// a `send-keys` anywhere in a compound or newline-joined batch is found; a
/// quoted word that merely looks like one only redacts more.
pub fn redact_command(command: &str) -> String {
    let mut word_start = None;
    let ends = command.char_indices().chain([(command.len(), ' ')]);
    for (i, c) in ends {
        if c.is_whitespace() || c == ';' {
            if let Some(start) = word_start.take() {
                if carries_keystrokes(&command[start..i]) {
                    return format!("{} …", &command[..i]);
                }
            }
        } else if word_start.is_none() {
            word_start = Some(i);
        }
    }
    command.to_string()
}
