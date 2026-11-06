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

/// One word of a shell line that `run-shell` runs: [`shell_word`] with its
/// `#` doubled, since `run-shell` expands formats in its command, inside
/// shell quotes too, before `/bin/sh` sees it.
pub fn run_shell_word(word: &str) -> String {
    shell_word(word).replace('#', "##")
}

pub fn run_shell_line<S: AsRef<str>>(argv: &[S]) -> String {
    argv.iter()
        .map(|w| run_shell_word(w.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
