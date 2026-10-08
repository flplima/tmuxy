/// Single-quote a value for interpolation into a tmux command string.
///
/// Session names come from `servers.json` and the connect form, so they can
/// contain whitespace (which would silently truncate the target) or `;`
/// (which would append extra commands to the list).
pub fn tmux_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Build the `new-window` rewrite: `new-window`/`neww` crashes tmux 3.5a with
/// control mode attached, so both transports send `splitw ; breakp` instead.
///
/// `resizew` targets the current window, which is the new one after `breakp`,
/// so the new window matches the viewport at creation rather than inheriting
/// the half-width post-split size or the control-mode PTY default.
///
/// Shared by the SSE server and the Tauri app so the rewrite shape can't drift
/// between transports. Tabs carry no marker (an untagged window is a tab), so
/// there is nothing to tag.
pub fn new_window_rewrite(session: &str, size: Option<(u32, u32)>) -> String {
    let session = tmux_quote(session);
    match size {
        Some((cols, rows)) => {
            format!("splitw -t {session} ; breakp ; resizew -x {cols} -y {rows}")
        }
        None => format!("splitw -t {session} ; breakp"),
    }
}

/// The verb of a single tmux command — its first whitespace-delimited token.
pub(crate) fn command_verb(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

/// Does any command in a (possibly compound) command list use one of `verbs`?
///
/// The keyboard actor prepends `select-window -t @N \; select-pane -t %N \;`
/// to every bound command, so a binding arrives as a compound whose FIRST
/// command is the pin. Any interception written as
/// `command.starts_with("<verb>")` silently stops matching the moment a
/// binding is pinned — the guard is still there, it just never fires again.
/// Ask about the whole list instead.
pub fn compound_has_verb(command: &str, verbs: &[&str]) -> bool {
    split_compound(command)
        .iter()
        .any(|part| verbs.contains(&command_verb(part)))
}

/// Rewrite a `new-window` sitting anywhere in a (possibly pinned) command list,
/// leaving the commands around it — the keyboard actor's window/pane pin — in
/// place.
///
/// Without this, `prefix c` (`select-window … \; select-pane … \; new-window`)
/// misses the `starts_with("new-window")` intercept and the raw `new-window`
/// runs as an external subprocess against an attached control-mode client:
/// the exact crash the rewrite exists to prevent (see docs/TMUX.md).
///
/// Keeping the pin matters beyond the crash. `splitw -t <session>` targets the
/// session's *current* window, so the pin ahead of it is what makes the new tab
/// come from the window the user is actually looking at rather than whichever
/// one tmux last considered current.
///
/// Returns `None` when the list contains no `new-window`.
pub fn rewrite_new_window_in_compound(
    command: &str,
    session: &str,
    size: Option<(u32, u32)>,
) -> Option<String> {
    let mut found = false;
    let parts: Vec<String> = split_compound(command)
        .iter()
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }
            if !found && matches!(command_verb(trimmed), "new-window" | "neww") {
                found = true;
                return Some(new_window_rewrite(session, size));
            }
            Some(trimmed.to_string())
        })
        .collect();

    // Bare `;` on purpose: control mode's line parser rejects the shell-escaped
    // `\;` the frontend joins with, and the monitor's unescape only rewrites
    // the form it already knows.
    found.then(|| parts.join(" ; "))
}

/// Rewrite long-form mutating verbs (`split-window`, `kill-pane`, `kill-window`, `break-pane`)
/// to their safe short forms (`splitw`, `killp`, `killw`, `breakp`).
///
/// This protects control mode from triggering server-level `command-alias` safety traps
/// configured to block external mutating commands on the tmuxy socket.
pub fn rewrite_mutating_verbs(command: &str) -> String {
    if !compound_has_verb(
        command,
        &["split-window", "kill-pane", "kill-window", "break-pane"],
    ) {
        return command.to_string();
    }
    let parts: Vec<String> = split_compound(command)
        .iter()
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }
            let verb = command_verb(trimmed);
            let short = match verb {
                "split-window" => Some("splitw"),
                "kill-pane" => Some("killp"),
                "kill-window" => Some("killw"),
                "break-pane" => Some("breakp"),
                _ => None,
            };
            if let Some(short_verb) = short {
                let rest = trimmed[verb.len()..].trim_start();
                if rest.is_empty() {
                    Some(short_verb.to_string())
                } else {
                    Some(format!("{short_verb} {rest}"))
                }
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect();

    parts.join(" ; ")
}

/// Split a compound tmux command on the `\;` separators that are *outside*
/// quotes.
///
/// A plain `cmd.split("\\;")` also splits inside quoted payloads, so
/// `send-keys -l 'a\;b'` was torn into two bogus commands.
pub(crate) fn split_compound(cmd: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                current.push(c);
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push(c);
            }
            '\\' if !in_single && !in_double && chars.peek() == Some(&';') => {
                chars.next();
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts
}

/// One binding of a key table, as `list-keys` prints it
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyBinding {
    pub key: String,
    pub command: String,
    pub description: String,
    /// Whether this binding has the `-r` (repeat) flag.
    /// Repeat bindings auto-re-enter prefix mode after execution.
    #[serde(default)]
    pub repeat: bool,
}

/// Parse `tmux list-keys -T <table>` output into `KeyBinding`s.
///
/// One parser for every table — the prefix and root paths used to carry
/// separate copies, and the root copy computed the `-r` indices but then
/// hardcoded `repeat: false`, silently losing repeat bindings.
pub(crate) fn parse_bindings(table: &str, output: &str) -> Vec<KeyBinding> {
    let mut bindings = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        // tmux list-keys output format:
        //   bind-key    -T <table> KEY command...
        //   bind-key -r -T <table> KEY command...
        // The -r flag shifts all subsequent indices by 1.
        let (key_idx, cmd_idx, is_repeat) = if parts.len() >= 6
            && parts[0] == "bind-key"
            && parts[1] == "-r"
            && parts[3] == table
        {
            (4, 5, true)
        } else if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == table {
            (3, 4, false)
        } else {
            continue;
        };

        if cmd_idx >= parts.len() {
            continue;
        }

        let bound_key = parts[key_idx];

        // Unescape the key
        let key = if bound_key.starts_with('\\') && bound_key.len() == 2 {
            bound_key[1..].to_string()
        } else {
            bound_key.to_string()
        };

        // Get the command (everything after the key)
        let command = parts[cmd_idx..].join(" ");
        let description = describe_binding(parts[cmd_idx], &command);

        bindings.push(KeyBinding {
            key,
            command,
            description,
            repeat: is_repeat,
        });
    }

    bindings
}

/// Human description for the common commands the menus surface.
fn describe_binding(command_name: &str, command: &str) -> String {
    match command_name {
        "split-window" => {
            if command.contains("-h") {
                "Split pane vertically".to_string()
            } else {
                "Split pane horizontally".to_string()
            }
        }
        "resize-pane" => {
            if command.contains("-Z") {
                "Toggle pane fullscreen".to_string()
            } else {
                "Resize pane".to_string()
            }
        }
        "select-pane" => "Select pane".to_string(),
        "last-pane" => "Switch to last active pane".to_string(),
        "next-layout" => "Cycle through pane layouts".to_string(),
        "break-pane" => "Convert pane to window".to_string(),
        "copy-mode" => "Enter copy mode".to_string(),
        "command-prompt" => "Enter command mode".to_string(),
        "new-window" => "Create new window".to_string(),
        "kill-window" => "Close window".to_string(),
        "next-window" => "Next window".to_string(),
        "previous-window" => "Previous window".to_string(),
        "select-window" => "Select window".to_string(),
        _ => command.to_string(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {

    use super::*;

    #[test]
    fn parse_bindings_handles_plain_and_repeat_forms() {
        let output = "\
bind-key    -T prefix % split-window -h
bind-key -r -T prefix h resize-pane -L 5
bind-key    -T root C-Left select-pane -L
bind-key    -T prefix \\% send-keys %";
        let prefix = parse_bindings("prefix", output);
        assert_eq!(prefix.len(), 3);
        assert_eq!(prefix[0].key, "%");
        assert_eq!(prefix[0].description, "Split pane vertically");
        assert!(!prefix[0].repeat);
        // -r bindings keep their repeat flag (the old root copy hardcoded
        // repeat: false — this drift is what the shared parser fixes).
        assert_eq!(prefix[1].key, "h");
        assert!(prefix[1].repeat);
        // Escaped keys are unescaped.
        assert_eq!(prefix[2].key, "%");

        let root = parse_bindings("root", output);
        assert_eq!(root.len(), 1);
        assert_eq!(root[0].key, "C-Left");
        assert_eq!(root[0].description, "Select pane");
    }

    #[test]
    fn new_window_rewrite_quotes_the_session() {
        // Session names come from servers.json / the connect form, so they can
        // contain whitespace (which truncated the target) or `;` (which
        // appended extra commands to the list).
        let out = new_window_rewrite("my session", None);
        assert!(out.contains("splitw -t 'my session' ;"), "{out}");

        let out = new_window_rewrite("evil ; kill-server", None);
        assert!(out.contains("-t 'evil ; kill-server'"), "{out}");

        let out = new_window_rewrite("it's", None);
        assert!(out.contains(r"-t 'it'\''s'"), "{out}");
    }

    #[test]
    fn new_window_rewrite_includes_resize_only_with_a_size() {
        let sized = new_window_rewrite("tmuxy", Some((120, 40)));
        assert!(sized.contains("resizew -x 120 -y 40"), "{sized}");
        // Tabs carry no marker — the rewrite must not tag the window.
        assert!(!sized.contains("@tmuxy-window-type"), "{sized}");

        let plain = new_window_rewrite("tmuxy", None);
        assert!(!plain.contains("resizew"), "{plain}");
        assert!(!plain.contains("@tmuxy-window-type"), "{plain}");
    }

    /// The regression this pair of helpers exists for: the keyboard actor pins
    /// every bound command, so `prefix c` never looked like a `new-window` to a
    /// head-anchored check, and the raw command escaped to an external
    /// subprocess against an attached control-mode client.
    #[test]
    fn compound_has_verb_sees_past_the_binding_pin() {
        let pinned =
            "select-window -t @2 \\; select-pane -t %5 \\; new-window -c \"#{pane_current_path}\"";
        assert!(compound_has_verb(pinned, &["new-window", "neww"]));
        assert!(compound_has_verb("neww", &["new-window", "neww"]));
        // A pane pin alone (an overlay binding) is still seen through.
        assert!(compound_has_verb(
            "select-pane -t %5 \\; neww",
            &["new-window", "neww"]
        ));
        // No false positives: `new-window` as an argument is not a verb, and a
        // different command with the same prefix does not count.
        assert!(!compound_has_verb(
            "select-pane -t %5 \\; split-window -h",
            &["new-window", "neww"]
        ));
        assert!(!compound_has_verb(
            "send-keys -l 'new-window'",
            &["new-window", "neww"]
        ));
    }

    #[test]
    fn rewrite_new_window_in_compound_keeps_the_pin_around_the_rewrite() {
        let pinned = "select-window -t @2 \\; select-pane -t %5 \\; new-window";
        let out = rewrite_new_window_in_compound(pinned, "tmuxy", Some((120, 40)))
            .expect("a new-window in the list");

        // The pin survives, ahead of the rewrite — `splitw -t <session>` targets
        // the session's CURRENT window, so the pin is what aims it at the tab
        // the user is looking at.
        assert!(
            out.starts_with("select-window -t @2 ; select-pane -t %5 ;"),
            "{out}"
        );
        assert!(out.contains("splitw -t 'tmuxy'"), "{out}");
        assert!(out.contains("breakp"), "{out}");
        assert!(out.contains("resizew -x 120 -y 40"), "{out}");
        // Control mode's line parser rejects the shell-escaped separator.
        assert!(!out.contains("\\;"), "{out}");
    }

    #[test]
    fn rewrite_new_window_in_compound_passes_through_unpinned_and_unrelated() {
        let bare = rewrite_new_window_in_compound("new-window", "tmuxy", None)
            .expect("a bare new-window still rewrites");
        assert_eq!(bare, new_window_rewrite("tmuxy", None));

        assert!(rewrite_new_window_in_compound(
            "select-pane -t %5 \\; split-window -h",
            "tmuxy",
            None
        )
        .is_none());
    }

    #[test]
    fn split_compound_respects_quotes() {
        // Unquoted separators split.
        assert_eq!(
            split_compound("splitw \\; breakp"),
            vec!["splitw ".to_string(), " breakp".to_string()]
        );
        // A separator inside single quotes is payload, not a separator.
        assert_eq!(
            split_compound("send-keys -l 'a\\;b'"),
            vec!["send-keys -l 'a\\;b'".to_string()]
        );
        // Same for double quotes.
        assert_eq!(
            split_compound("send-keys -l \"a\\;b\""),
            vec!["send-keys -l \"a\\;b\"".to_string()]
        );
        // Mixed: quoted payload preserved, real separator still splits.
        assert_eq!(
            split_compound("send-keys -l 'a\\;b' \\; selectp -t %1"),
            vec![
                "send-keys -l 'a\\;b' ".to_string(),
                " selectp -t %1".to_string()
            ]
        );
    }
}
