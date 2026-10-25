//! A `run-shell` a client sends, relayed so what it printed and how it ended
//! reach that client.
//!
//! tmux 3.4 does not hand a `run-shell`'s output to the client that ran it: it
//! opens it, and the "returned 1" of a failure, in view-mode on the current
//! pane. tmuxy draws no view-mode, so the pane looked untouched while every
//! key went to the mode, and one of them opens a prompt on the control client
//! after which tmux answers none of tmuxy's commands. Later versions hand the
//! output to the client, inside the command's reply, where nothing showed it.
//!
//! So the shell command runs inside a wrapper that prints nothing and always
//! succeeds: it keeps the output and the exit status in a server option
//! instead, which the same command list reads back and removes, inside the
//! reply. The session restore relays its shell steps the same way
//! (`session_snapshot/restore.rs`).

/// The server option a relayed `run-shell` leaves its answer in. One per
/// command, so two in flight never read each other's.
pub(super) fn relay_key(id: u64) -> String {
    format!("@tmuxy-run-{id}")
}

/// `command` with its `run-shell` relayed through the option `key`, followed
/// by the commands that read the option back and remove it. `tmux` is the
/// shell command line that reaches this server from inside the job.
///
/// `None` leaves the command as it came: no `run-shell` in it, one that runs
/// in the background (`-b`) or runs a tmux command (`-C`), more than one, or
/// syntax this does not model (a comment, a brace block, a `;` glued to a
/// word, a word tmux would expand `~` at the start of).
pub(super) fn relay_run_shell(command: &str, key: &str, tmux: &str) -> Option<String> {
    let commands = split_command_list(command)?;
    let mut run_shells = commands
        .iter()
        .enumerate()
        .filter(|(_, words)| matches!(words.first(), Some(&("run-shell" | "run"))));
    let (at, words) = run_shells.next()?;
    if run_shells.next().is_some() {
        return None;
    }
    let (flags, shell) = split_flags(&words[1..])?;
    if shell.starts_with('~') || shell == "''" || shell == "\"\"" {
        return None;
    }

    // The shell word stays exactly as written, between two quoted segments of
    // the same tmux word, so tmux reads it as it always did: its quoting, its
    // `$VAR`s and its `#{formats}` are all still tmux's. A newline, not `;`,
    // ends it inside the group, so a trailing `&` or `# comment` still parses.
    let before = "out=$( { ";
    let after =
        format!("\n}} 2>&1 ); rc=$?; {tmux} set-option -gq {key} \"{key} $rc\n$out\"; true");
    let wrapped = format!("{}{shell}{}", quoted(before), quoted(&after));
    let mut relayed = vec![words[0]];
    relayed.extend(flags);
    relayed.push(&wrapped);

    let mut out: Vec<String> = commands
        .iter()
        .enumerate()
        .map(|(i, words)| {
            if i == at {
                relayed.join(" ")
            } else {
                words.join(" ")
            }
        })
        .collect();
    out.push(format!("show-options -gqv {key}"));
    out.push(format!("set-option -gqu {key}"));
    Some(out.join(" ; "))
}

/// What a relayed `run-shell`'s reply carried.
#[derive(Debug, PartialEq)]
pub(super) struct Relayed<'a> {
    /// Lines the rest of the command list printed, ahead of the answer.
    pub before: Vec<&'a str>,
    /// The shell command's exit status and output; `None` when the
    /// `run-shell` never ran (tmux stopped the list at an earlier failure).
    pub answer: Option<(i32, String)>,
}

/// Read a relayed `run-shell`'s answer out of its reply's output.
pub(super) fn read_relayed<'a>(output: &'a str, key: &str) -> Relayed<'a> {
    let lines: Vec<&str> = output.lines().collect();
    let status_at = lines.iter().position(|line| {
        line.strip_prefix(key)
            .and_then(|rest| rest.strip_prefix(' '))
            .is_some_and(|rc| rc.trim().parse::<i32>().is_ok())
    });
    match status_at {
        Some(at) => {
            let rc = lines[at][key.len() + 1..].trim().parse().unwrap_or(0);
            let text = lines[at + 1..].join("\n").trim_end().to_string();
            Relayed {
                before: lines[..at].to_vec(),
                answer: Some((rc, text)),
            }
        }
        None => Relayed {
            before: lines,
            answer: None,
        },
    }
}

/// What a run-shell printed, cut to what a notice can show: its last lines,
/// since a failing script says why at the end.
pub(super) fn clip_output(text: &str) -> String {
    const MAX_LINES: usize = 20;
    const MAX_CHARS: usize = 2000;
    let lines: Vec<&str> = text.lines().collect();
    let kept = lines[lines.len().saturating_sub(MAX_LINES)..].join("\n");
    let chars = kept.chars().count();
    if chars <= MAX_CHARS && lines.len() <= MAX_LINES {
        return kept;
    }
    let tail: String = kept.chars().skip(chars.saturating_sub(MAX_CHARS)).collect();
    format!("…\n{tail}")
}

/// Text placed inside a tmux double-quoted word so that the shell command
/// `run-shell` builds from it reads it unchanged: escaped for tmux's parser,
/// with `#` doubled for the format expansion `run-shell` applies after.
fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' | '\\' | '$' => {
                out.push('\\');
                out.push(c);
            }
            '\n' => out.push_str("\\n"),
            '#' => out.push_str("##"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A run-shell's words after the verb, as its flags (each with any value it
/// takes) and the one shell-command word. `None` for `-b`, `-C`, a flag this
/// does not know, or anything but exactly one shell word.
fn split_flags<'a>(words: &[&'a str]) -> Option<(Vec<&'a str>, &'a str)> {
    let mut flags = Vec::new();
    let mut rest = words.iter().copied();
    let mut shell = None;
    while let Some(word) = rest.next() {
        if word == "--" {
            flags.push(word);
            shell = rest.next();
            break;
        }
        let Some(letters) = word.strip_prefix('-').filter(|l| !l.is_empty()) else {
            shell = Some(word);
            break;
        };
        // Each flag kept takes a value, so a word holds one: `-t %3` or `-t%3`.
        if !matches!(letters.chars().next(), Some('c' | 'd' | 't')) {
            return None;
        }
        flags.push(word);
        if letters.len() == 1 {
            flags.push(rest.next()?);
        }
    }
    if rest.next().is_some() {
        return None;
    }
    Some((flags, shell?))
}

/// A tmux command list split into commands of words, each word exactly as
/// written. `None` for what this does not model.
fn split_command_list(line: &str) -> Option<Vec<Vec<&str>>> {
    let mut commands = vec![Vec::new()];
    let mut chars = line.char_indices().peekable();
    while let Some(&(start, c)) = chars.peek() {
        if c == ' ' || c == '\t' {
            chars.next();
            continue;
        }
        if matches!(c, '#' | '{' | '}') {
            return None;
        }
        let mut quote: Option<char> = None;
        let mut end = start;
        let mut glued_semicolon = false;
        while let Some(&(i, c)) = chars.peek() {
            if quote.is_none() && (c == ' ' || c == '\t') {
                break;
            }
            chars.next();
            end = i + c.len_utf8();
            glued_semicolon = false;
            match (quote, c) {
                (None, '\'' | '"') => quote = Some(c),
                (Some(q), _) if c == q => quote = None,
                (None | Some('"'), '\\') => {
                    let (j, escaped) = chars.next()?;
                    end = j + escaped.len_utf8();
                }
                (None, ';') => glued_semicolon = true,
                _ => {}
            }
        }
        if quote.is_some() {
            return None;
        }
        let word = &line[start..end];
        if word == ";" {
            commands.push(Vec::new());
        } else if glued_semicolon {
            return None;
        } else if let Some(command) = commands.last_mut() {
            command.push(word);
        }
    }
    if commands.iter().any(Vec::is_empty) {
        return None;
    }
    Some(commands)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const TMUX: &str = "'/usr/bin/tmux' -L tmuxy";

    #[test]
    fn a_run_shell_is_relayed_through_the_key_and_read_back() {
        let out = relay_run_shell("run-shell 'echo hi'", "@tmuxy-run-7", TMUX).unwrap();
        assert_eq!(
            out,
            "run-shell \"out=\\$( { \"'echo hi'\"\\n} 2>&1 ); rc=\\$?; '/usr/bin/tmux' -L tmuxy \
             set-option -gq @tmuxy-run-7 \\\"@tmuxy-run-7 \\$rc\\n\\$out\\\"; true\" \
             ; show-options -gqv @tmuxy-run-7 ; set-option -gqu @tmuxy-run-7"
        );
    }

    #[test]
    fn the_shell_word_and_the_pin_ahead_of_it_go_out_as_written() {
        let pinned = r#"select-window -t @2 ; select-pane -t %5 ; run-shell "bash $HOME/.config/tmuxy/bin/tmuxy/nav left #{pane_id}""#;
        let out = relay_run_shell(pinned, "@tmuxy-run-1", TMUX).unwrap();
        assert!(
            out.starts_with("select-window -t @2 ; select-pane -t %5 ; run-shell "),
            "{out}"
        );
        assert!(
            out.contains(r#""bash $HOME/.config/tmuxy/bin/tmuxy/nav left #{pane_id}""#),
            "{out}"
        );
    }

    #[test]
    fn flags_and_their_values_are_kept() {
        let out = relay_run_shell("run -t %3 -d 1 'true'", "@k", TMUX).unwrap();
        assert!(out.starts_with("run -t %3 -d 1 \"out="), "{out}");
        let out = relay_run_shell("run-shell -t%3 'true'", "@k", TMUX).unwrap();
        assert!(out.starts_with("run-shell -t%3 \"out="), "{out}");
    }

    #[test]
    fn background_tmux_commands_and_unmodelled_syntax_go_out_as_they_came() {
        for command in [
            "splitw -h",
            "run-shell -b 'sleep 1'",
            "run-shell -C 'display hi'",
            "run-shell 'a' ; run-shell 'b'",
            "run-shell ~/bin/x",
            "run-shell ''",
            "run-shell",
            "run-shell -x 'a'",
            "run-shell 'a' 'b'",
            "run-shell 'a' # note",
            "run-shell 'unterminated",
            "display hi; run-shell 'a'",
            "if-shell true { run-shell 'a' }",
        ] {
            assert_eq!(relay_run_shell(command, "@k", TMUX), None, "{command}");
        }
    }

    #[test]
    fn the_answer_is_read_from_after_the_status_line() {
        let out = "@tmuxy-run-4 3\nRUN_FAILED\nsecond line\n";
        assert_eq!(
            read_relayed(out, "@tmuxy-run-4"),
            Relayed {
                before: vec![],
                answer: Some((3, "RUN_FAILED\nsecond line".to_string())),
            }
        );
        let quiet = read_relayed("noise\n@tmuxy-run-4 0", "@tmuxy-run-4");
        assert_eq!(quiet.before, vec!["noise"]);
        assert_eq!(quiet.answer, Some((0, String::new())));
        // A list that stopped before its run-shell has no answer.
        assert_eq!(read_relayed("", "@tmuxy-run-4").answer, None);
        // Another command's key is not this one's.
        assert_eq!(read_relayed("@tmuxy-run-40 1", "@tmuxy-run-4").answer, None);
    }

    /// Undo `quoted`: what tmux's parser and then `run-shell`'s format
    /// expansion make of the segment.
    fn unquoted(segment: &str) -> String {
        let inner = &segment[1..segment.len() - 1];
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => match chars.next().unwrap() {
                    'n' => out.push('\n'),
                    escaped => out.push(escaped),
                },
                '#' => {
                    assert_eq!(chars.next(), Some('#'), "a lone # in {segment}");
                    out.push('#');
                }
                '"' | '$' => panic!("unescaped {c} in {segment}"),
                _ => out.push(c),
            }
        }
        out
    }

    proptest! {
        /// Whatever the socket path or key, the wrapper's own text reaches
        /// the shell unchanged.
        #[test]
        fn quoted_text_reaches_the_shell_unchanged(text in "\\PC*") {
            prop_assert_eq!(unquoted(&quoted(&text)), text);
        }

        /// A shell word in any quoting tmux allows survives the rewrite
        /// verbatim, and every other word of the list too.
        #[test]
        fn the_shell_word_survives_verbatim(
            body in "[a-zA-Z0-9 _./$#{}%&|<>=-]{1,40}",
            single in any::<bool>(),
            pin in proptest::option::of("%[0-9]{1,3}"),
        ) {
            let word = if single {
                format!("'{}'", body.replace('\'', ""))
            } else {
                format!("\"{}\"", body.replace(['"', '\\', '$'], ""))
            };
            prop_assume!(word != "''" && word != "\"\"");
            let command = match &pin {
                Some(pane) => format!("select-pane -t {pane} ; run-shell {word}"),
                None => format!("run-shell {word}"),
            };
            let out = relay_run_shell(&command, "@tmuxy-run-9", TMUX).unwrap();
            prop_assert!(out.contains(&format!("\"{word}\"")), "{}", out);
            if let Some(pane) = &pin {
                let expected_prefix = format!("select-pane -t {pane} ; ");
                prop_assert!(out.starts_with(&expected_prefix), "{}", out);
            }
        }
    }
}
