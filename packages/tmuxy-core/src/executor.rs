pub use crate::tmux_quote;

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

/// A tmux command the router has a policy for, with every verb tmux runs it
/// by: its name, its alias, and any prefix of the name no other command
/// shares — tmux runs `resize-w` as `resize-window`.
pub struct TmuxCommand {
    pub name: &'static str,
    pub alias: &'static str,
    /// The shortest prefix of `name` that names no other tmux command.
    pub unique_prefix: &'static str,
}

pub const RESIZE_WINDOW: TmuxCommand = TmuxCommand {
    name: "resize-window",
    alias: "resizew",
    unique_prefix: "resize-w",
};

pub const NEW_WINDOW: TmuxCommand = TmuxCommand {
    name: "new-window",
    alias: "neww",
    unique_prefix: "new-w",
};

impl TmuxCommand {
    /// Whether tmux runs this command for `verb`.
    pub fn named_by(&self, verb: &str) -> bool {
        verb == self.alias || (verb.starts_with(self.unique_prefix) && self.name.starts_with(verb))
    }
}

/// Does any command in a (possibly compound) command list run `command`?
///
/// The keyboard actor prepends `select-window -t @N \; select-pane -t %N \;`
/// to every bound command, so a binding arrives as a compound whose FIRST
/// command is the pin. Any interception written as
/// `command.starts_with("<verb>")` silently stops matching the moment a
/// binding is pinned — the guard is still there, it just never fires again.
/// Ask about the whole list instead.
pub fn compound_runs(list: &str, command: &TmuxCommand) -> bool {
    split_compound(list)
        .iter()
        .any(|part| command.named_by(command_verb(part)))
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
            if !found && NEW_WINDOW.named_by(command_verb(trimmed)) {
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
    const LONG_FORMS: [&str; 4] = ["split-window", "kill-pane", "kill-window", "break-pane"];
    if !split_compound(command)
        .iter()
        .any(|part| LONG_FORMS.contains(&command_verb(part)))
    {
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

/// Split a command list into its commands, where tmux would.
///
/// The separators are the ones tmux acts on outside quotes — a bare `;`, the
/// frontend's `\;` (the monitor turns it into `;`) and a newline, which ends
/// the control-mode line whatever is open — read the way tmux's parser reads
/// quotes: nothing escapes inside single quotes, and a backslash escapes the
/// next character anywhere else. Splitting only on `\;`, and toggling on
/// every quote, let a policy miss a command tmux then ran:
/// `display x ; resizew` and `display "\"" \; resizew` both hid the
/// `resizew` from the router. A plain `cmd.split("\\;")` also splits inside
/// quoted payloads, so `send-keys -l 'a\;b'` was torn into two bogus
/// commands.
///
/// Where tmux's reading is in doubt (a `;` glued to a word, a `{ … }` block)
/// this splits: a policy that sees a command too many refuses a command too
/// many, never runs one it did not see.
pub(crate) fn split_compound(cmd: &str) -> Vec<String> {
    #[derive(PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = Quote::None;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        match (&quote, c) {
            (_, '\n') => {
                quote = Quote::None;
                parts.push(std::mem::take(&mut current));
            }
            (Quote::None, ';') => parts.push(std::mem::take(&mut current)),
            (Quote::None, '\\') if chars.peek() == Some(&';') => {
                chars.next();
                parts.push(std::mem::take(&mut current));
            }
            (Quote::None | Quote::Double, '\\') => {
                current.push(c);
                if let Some(&next) = chars.peek() {
                    if next != '\n' {
                        current.push(next);
                        chars.next();
                    }
                }
            }
            (Quote::None, '\'') => {
                quote = Quote::Single;
                current.push(c);
            }
            (Quote::None, '"') => {
                quote = Quote::Double;
                current.push(c);
            }
            (Quote::Single, '\'') | (Quote::Double, '"') => {
                quote = Quote::None;
                current.push(c);
            }
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn new_window_rewrite_quotes_the_session() {
        // Session names come from servers.json / `tmuxy session connect`, so they can
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
    /// The regression this pair of helpers exists for: the keyboard actor pins
    /// every bound command, so `prefix c` never looked like a `new-window` to a
    /// head-anchored check, and the raw command escaped to an external
    /// subprocess against an attached control-mode client.
    #[test]
    fn compound_runs_sees_past_the_binding_pin() {
        let pinned =
            "select-window -t @2 \\; select-pane -t %5 \\; new-window -c \"#{pane_current_path}\"";
        assert!(compound_runs(pinned, &NEW_WINDOW));
        assert!(compound_runs("neww", &NEW_WINDOW));
        // A pane pin alone (an overlay binding) is still seen through.
        assert!(compound_runs("select-pane -t %5 \\; neww", &NEW_WINDOW));
        // No false positives: `new-window` as an argument is not a verb, and a
        // different command with the same prefix does not count.
        assert!(!compound_runs(
            "select-pane -t %5 \\; split-window -h",
            &NEW_WINDOW
        ));
        assert!(!compound_runs("send-keys -l 'new-window'", &NEW_WINDOW));
        assert!(!compound_runs("new-session -d", &NEW_WINDOW));
    }

    /// tmux runs any prefix of a command's name no other command shares, so
    /// a policy that knew only the name and the alias missed `resize-w`.
    #[test]
    fn a_command_is_seen_under_every_name_tmux_runs_it_by() {
        for verb in ["resize-window", "resizew", "resize-w", "resize-win"] {
            assert!(RESIZE_WINDOW.named_by(verb), "{verb}");
        }
        for verb in ["resize-", "resize-pane", "resizep", "resize-windows"] {
            assert!(!RESIZE_WINDOW.named_by(verb), "{verb}");
        }
        for verb in ["new-window", "neww", "new-w", "new-wi"] {
            assert!(NEW_WINDOW.named_by(verb), "{verb}");
        }
        for verb in ["new", "new-", "new-session", "news"] {
            assert!(!NEW_WINDOW.named_by(verb), "{verb}");
        }
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

    /// Every separator tmux acts on splits, read with tmux's quoting: a bare
    /// `;`, a newline, and a quote a backslash escaped does not open or close
    /// anything. Each of these hid a `resizew` from the router.
    #[test]
    fn split_compound_splits_where_tmux_does() {
        let verbs = |cmd: &str| -> Vec<String> {
            split_compound(cmd)
                .iter()
                .map(|part| command_verb(part).to_string())
                .filter(|verb| !verb.is_empty())
                .collect()
        };
        assert_eq!(verbs("display x ; resizew -x 1"), ["display", "resizew"]);
        assert_eq!(verbs("display x\nresizew -x 1"), ["display", "resizew"]);
        assert_eq!(
            verbs("display \"\\\"\" \\; resizew"),
            ["display", "resizew"]
        );
        assert_eq!(verbs("display \\' \\; resizew"), ["display", "resizew"]);
        assert_eq!(
            verbs("display 'it'\\''s' ; resizew"),
            ["display", "resizew"]
        );
        // An open quote does not survive the end of the line.
        assert_eq!(verbs("display 'x\nresizew"), ["display", "resizew"]);
        // Quoted separators stay payload.
        assert_eq!(verbs("display 'a ; b' \"c ; d\" \"e\\\";f\""), ["display"]);
    }
}
