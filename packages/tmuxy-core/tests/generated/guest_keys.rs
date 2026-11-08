//! The guests' key bindings, from the shipped conf.

use std::fmt::Write as _;

use super::{default_prefix, packages, HEADER};

/// The conf's bindings the guests leave out, by table: the prefix itself, and
/// the stacks, floats, marks, prompts and choosers their tmuxy build does not
/// carry.
const GUEST_OMITS: [(&str, &[&str]); 2] = [
    ("prefix", &["C-a", "a", "j"]),
    ("pane", &["s", "S", "=", "f", "m", ",", "g"]),
];

/// tmux's own prefix bindings, which the conf leaves in place and the guest's
/// tmux binds on its own, as the guest runs them.
const GUEST_TMUX_DEFAULTS: [(&str, &str); 14] = [
    ("n", "next-window"),
    ("x", "kill-pane"),
    ("&", "kill-window"),
    ("o", "select-pane -t :.+"),
    ("z", "resize-pane -Z"),
    ("Up", "select-pane -U"),
    ("Down", "select-pane -D"),
    ("Left", "select-pane -L"),
    ("Right", "select-pane -R"),
    ("[", "copy-mode"),
    ("Space", "next-layout"),
    ("0", "select-window -t :=0"),
    ("1", "select-window -t :=1"),
    ("2", "select-window -t :=2"),
];

/// One `bind` line of a tmux conf as `list-keys` prints the binding:
/// `bind-key [-r] -T <table> <key> <command>`, or `None` for any other line.
/// The guest has no `pane_current_path` to split at, so a `-c` naming it is
/// dropped.
fn conf_bind_as_listed(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("bind-key ")
        .or_else(|| line.strip_prefix("bind "))?;
    let mut words = rest.split_whitespace().peekable();
    let (mut table, mut repeat) = ("prefix", false);
    // A flag is a letter after the dash; a bare `-` is the key it binds.
    while let Some(flag) = words.next_if(|w| w.len() == 2 && w.starts_with('-') && w != &"--") {
        match flag {
            "-n" => table = "root",
            "-r" => repeat = true,
            "-T" => table = words.next()?,
            _ => {}
        }
    }
    let quoted = words.next()?;
    let key = match quoted {
        "\\\\" => "\\",
        _ => quoted
            .strip_prefix('\'')
            .and_then(|k| k.strip_suffix('\''))
            .unwrap_or(quoted),
    };
    let command = words
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" -c \"#{pane_current_path}\"", "");
    let omitted = GUEST_OMITS
        .iter()
        .any(|(t, keys)| *t == table && keys.contains(&key));
    if omitted {
        return None;
    }
    // `list-keys` escapes a one-character key that is also tmux syntax.
    let key = if key.chars().count() == 1 && !key.chars().all(char::is_alphanumeric) {
        format!("\\{key}")
    } else {
        key.to_string()
    };
    let repeat = if repeat { "-r " } else { "" };
    Some(format!("bind-key {repeat}-T {table} {key} {command}"))
}

/// The key bindings the guest transports report, having no server to ask:
/// the shipped tmuxy.defaults.conf's, read the way the server reads a live
/// tmux's (`host::KeyBindings::parse`), plus tmux's own defaults.
pub fn guest_keybindings() -> String {
    let path = packages().join("tmuxy-core/assets/tmuxy.defaults.conf");
    let conf = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let repeat_time = conf
        .lines()
        .find_map(|line| line.trim().strip_prefix("set -g repeat-time "))
        .unwrap_or_else(|| panic!("{} sets no repeat-time", path.display()));
    let mut listing = format!("{}\n{}\n", default_prefix(), repeat_time.trim());
    for line in conf.lines().filter_map(|l| conf_bind_as_listed(l.trim())) {
        let _ = writeln!(listing, "{line}");
    }
    for (key, command) in GUEST_TMUX_DEFAULTS {
        let _ = writeln!(
            listing,
            "{}",
            conf_bind_as_listed(&format!("bind {key} {command}")).unwrap_or_default()
        );
    }

    #[derive(serde::Serialize)]
    struct Generated<'a> {
        _generated: Vec<&'a str>,
        keybindings: tmuxy_core::host::KeyBindings,
    }
    let generated = Generated {
        _generated: HEADER.lines().collect(),
        keybindings: tmuxy_core::host::KeyBindings::parse(&listing),
    };
    format!(
        "{}\n",
        serde_json::to_string_pretty(&generated).unwrap_or_default()
    )
}
