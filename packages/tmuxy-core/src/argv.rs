//! A tmux command as argv, and the two lines it is sent as: a line tmux's
//! own command parser reads (a control-mode command, a `source-file` line),
//! and a shell line (what `run-shell` hands `/bin/sh`). Every place that
//! sends a command builds its argv and renders it here, so a word is quoted
//! for the reader it is going to, once.

fn plain(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c))
}

/// One word as tmux's command parser reads it: as it is when plain, else
/// double-quoted ([`crate::tmux_double_quoted`]).
///
/// A format such as `#{window_id}` MUST be quoted: to tmux's parser a bare
/// `#` starts a comment, so an unquoted format vanishes and the command fails
/// with "-F expects an argument". Inside double quotes it is just text, and
/// the command expands it when it runs. Braces too: `{` opens a command block
/// to the same parser, so the layout of any side-by-side split
/// (`…{40x24,0,0,1,…}`) would be a syntax error.
pub fn tmux_word(word: &str) -> String {
    if plain(word) {
        return word.to_string();
    }
    crate::tmux_double_quoted(word)
}

/// `argv` as one line tmux's command parser reads back as the same argv.
pub fn control_line<S: AsRef<str>>(argv: &[S]) -> String {
    argv.iter()
        .map(|w| tmux_word(w.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A command list as argv, `;` a word of its own between two commands, as
/// one line tmux's command parser reads back as the same list.
pub fn control_list<S: AsRef<str>>(argv: &[S]) -> String {
    argv.split(|w| w.as_ref() == ";")
        .map(control_line)
        .collect::<Vec<_>>()
        .join(" ; ")
}

/// Free text as the operands that end a command, after `--`.
///
/// tmux reads a command's options until the first word that does not start
/// with a dash, or until `--`. Text standing where the operands go (a shell
/// command, a window's name, typed keys) that starts with a dash (`-1`,
/// `--help`) is read as flags instead, and tmux refuses the command ("unknown
/// flag -1"). A flag's own argument (`-n name`, `-c dir`) needs none: tmux
/// takes the next word whole. No words, no `--`.
pub fn operands<S: Into<String>>(words: impl IntoIterator<Item = S>) -> Vec<String> {
    let words: Vec<String> = words.into_iter().map(Into::into).collect();
    if words.is_empty() {
        return words;
    }
    std::iter::once("--".to_string()).chain(words).collect()
}

pub fn shell_word(word: &str) -> String {
    if plain(word) {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', r"'\''"))
}

pub fn shell_line<S: AsRef<str>>(argv: &[S]) -> String {
    argv.iter()
        .map(|w| shell_word(w.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Text that tmux expands as a format before using it (`run-shell`'s
/// command, inside shell quotes too, and `display-message`'s message), with
/// every `#` doubled so it reads back as itself: a `#(…)` would otherwise run
/// and a `#{…}` be replaced with whatever tmux knows by that name. All but
/// a run of `#` just before a `[`: tmux leaves a style (`#[…]`), however
/// many `#` it opens with, as it is, so a doubled one came back doubled
/// (`#[` typed as `##[`). The one place the rule is spelled.
pub fn format_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut hashes = 0;
    for c in text.chars() {
        if c == '#' {
            hashes += 1;
            continue;
        }
        let copies = if c == '[' { hashes } else { hashes * 2 };
        out.extend(std::iter::repeat_n('#', copies));
        hashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('#', hashes * 2));
    out
}

/// One word of a shell line that `run-shell` runs: [`shell_word`] as a
/// [`format_literal`].
pub fn run_shell_word(word: &str) -> String {
    format_literal(&shell_word(word))
}

pub fn run_shell_line<S: AsRef<str>>(argv: &[S]) -> String {
    argv.iter()
        .map(|w| run_shell_word(w.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A model of how tmux reads a command list given as argv (`;` a word of its
/// own between commands), for tests: each command's options read as tmux's
/// `args_parse` reads them, with the verb's own option template (the `args`
/// of its `cmd-*.c`, tmux 3.8; 3.2a's BSD getopt agrees on all of this).
/// Options end at the first word without a leading dash (a lone `-` is an
/// operand) or at `--`; a flag that takes an argument takes the next word
/// whole. Each command comes back as its verb and operands, or as tmux's own
/// complaint (`unknown flag -1`). A verb missing from the table is refused,
/// so a builder that starts sending a new one adds its template first.
#[cfg(test)]
pub(crate) fn as_tmux_reads<S: AsRef<str>>(
    argv: &[S],
) -> Result<Vec<(String, Vec<String>)>, String> {
    const TEMPLATES: &[(&str, &str)] = &[
        ("break-pane", "abdPF:n:s:t:Wx:X:y:Y:"),
        ("breakp", "abdPF:n:s:t:Wx:X:y:Y:"),
        ("display-message", "aCc:d:jlINpt:F:v"),
        ("move-window", "abdkrs:t:"),
        ("rename-window", "t:"),
        ("resize-window", "aADLRt:Ux:y:"),
        ("resizew", "aADLRt:Ux:y:"),
        ("select-layout", "Enopt:"),
        ("select-pane", "DdegLlMmP:RT:t:UZ"),
        ("send-keys", "c:FHKlMN:Rt:X"),
        ("set-option", "aFgopqst:uUw"),
        ("show-options", "AgF:Hpqst:vw"),
        ("split-window", "bB:c:de:EfF:hIkl:m:p:PR:s:S:t:T:vWZ"),
        ("splitw", "bB:c:de:EfF:hIkl:m:p:PR:s:S:t:T:vWZ"),
    ];
    let words: Vec<&str> = argv.iter().map(AsRef::as_ref).collect();
    let mut read = Vec::new();
    for command in words.split(|w| *w == ";").filter(|c| !c.is_empty()) {
        let (verb, rest) = (command[0], &command[1..]);
        let template = TEMPLATES
            .iter()
            .find(|(name, _)| *name == verb)
            .map(|(_, t)| *t)
            .ok_or_else(|| format!("no option template for {verb}"))?;
        let mut i = 0;
        while let Some(word) = rest.get(i).filter(|w| w.starts_with('-') && **w != "-") {
            i += 1;
            if *word == "--" {
                break;
            }
            for (at, letter) in word.char_indices().skip(1) {
                let Some(found) = template
                    .find(letter)
                    .filter(|_| letter.is_ascii_alphanumeric())
                else {
                    return Err(format!("unknown flag -{letter}"));
                };
                if template[found + 1..].starts_with(':') {
                    if at + 1 == word.len() {
                        rest.get(i)
                            .ok_or_else(|| format!("-{letter} expects an argument"))?;
                        i += 1;
                    }
                    break;
                }
            }
        }
        read.push((
            verb.to_string(),
            rest[i..].iter().map(|w| w.to_string()).collect(),
        ));
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What tmux's format expansion turns back into the text: every `#`
    /// doubled, but a run just before `[`, which tmux keeps as it is.
    #[test]
    fn a_format_literal_reads_back_as_the_text_it_was() {
        for (text, literal) in [
            ("#{pane_id}", "##{pane_id}"),
            ("#(id)", "##(id)"),
            ("#[fg=red]", "#[fg=red]"),
            ("##[x", "##[x"),
            ("a#b#[c", "a##b#[c"),
            ("ends #", "ends ##"),
            ("###", "######"),
            ("no hash", "no hash"),
        ] {
            assert_eq!(format_literal(text), literal, "{text}");
        }
    }

    #[test]
    fn a_tmux_word_quotes_what_tmux_would_otherwise_split_or_expand() {
        // A bare `#` is a comment to tmux's parser: a format is always quoted.
        assert_eq!(tmux_word("#{window_id}"), "\"#{window_id}\"");
        assert_eq!(
            tmux_word("#{s/,/%2C/:window_layout}"),
            "\"#{s/,/%2C/:window_layout}\""
        );
        // `{` opens a command block: a side-by-side layout is quoted.
        assert_eq!(
            tmux_word("b1c2,80x24,0,0{40x24,0,0,1}"),
            "\"b1c2,80x24,0,0{40x24,0,0,1}\""
        );
        assert_eq!(tmux_word("a b"), "\"a b\"");
        assert_eq!(tmux_word("say \"hi\" $HOME"), "\"say \\\"hi\\\" \\$HOME\"");
        assert_eq!(
            control_line(&["select-pane", "-t", "%3"]),
            "select-pane -t %3"
        );
    }

    #[test]
    fn a_shell_word_is_single_quoted_and_a_run_shell_word_doubles_its_hashes() {
        assert_eq!(shell_word("/usr/bin/tmux"), "/usr/bin/tmux");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
        assert_eq!(run_shell_word("/a b/it's#1"), r"'/a b/it'\''s##1'");
        assert_eq!(shell_line(&["tmux", "-L", "my sock"]), "tmux -L 'my sock'");
        assert_eq!(run_shell_line(&["echo", "#{x}"]), "echo '##{x}'");
    }

    #[test]
    fn operands_follow_a_double_dash_and_tmux_reads_them_whole() {
        assert_eq!(operands(["-1"]), ["--", "-1"]);
        assert!(operands(Vec::<String>::new()).is_empty());
        // The model refuses what tmux refuses, and reads a dash-led operand
        // or flag argument as tmux does.
        assert_eq!(
            as_tmux_reads(&["rename-window", "-t", "@1", "-1"]),
            Err("unknown flag -1".to_string())
        );
        let mut argv = vec!["rename-window".to_string(), "-t".into(), "-x".into()];
        argv.extend(operands(["--help"]));
        assert_eq!(
            as_tmux_reads(&argv),
            Ok(vec![(
                "rename-window".to_string(),
                vec!["--help".to_string()]
            )])
        );
        assert_eq!(
            as_tmux_reads(&["send-keys", "-t", "%1", "-"]),
            Ok(vec![("send-keys".to_string(), vec!["-".to_string()])])
        );
    }
}
