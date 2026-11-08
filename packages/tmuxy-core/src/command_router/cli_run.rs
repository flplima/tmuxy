//! What `tmuxy run` passes on to tmux, and what it refuses.

use super::RESIZE_WINDOW_REFUSAL;
use crate::tmux_command::{NEW_WINDOW, RESIZE_WINDOW};

/// The commands `tmuxy run` passes on, by their names and aliases: every
/// read a client's query may run ([`super::READ_VERBS`]), and these, which
/// move panes and windows about or close them. Left out is every command
/// that types into a pane (`send-keys`, `paste-buffer`, `pipe-pane`: keys go
/// through `tmuxy pane send`, which asks the user before typing into another
/// pane), runs a shell or keeps a command for later (`run-shell`, `if-shell`,
/// `split-window <cmd>`, `new-session <cmd>`, `bind-key`, `command-prompt`,
/// `display-popup`, ...), and every write to an option, hook or environment:
/// an option can run a shell (`status-right` with `#(...)`, `command-alias`,
/// `default-command`) or mirror a pane's keys into every other one
/// (`synchronize-panes`). `resize-window` is refused before this list is
/// read, with the reason every client gets.
const ARRANGE_VERBS: &[&str] = &[
    "break-pane",
    "breakp",
    "clear-history",
    "clearhist",
    "clock-mode",
    "copy-mode",
    "delete-buffer",
    "deleteb",
    "join-pane",
    "joinp",
    "kill-pane",
    "killp",
    "kill-server",
    "kill-session",
    "kill-window",
    "killw",
    "last-pane",
    "lastp",
    "last-window",
    "last",
    "link-window",
    "linkw",
    "move-pane",
    "movep",
    "move-window",
    "movew",
    "new-window",
    "neww",
    "next-layout",
    "nextl",
    "next-window",
    "next",
    "previous-layout",
    "prevl",
    "previous-window",
    "prev",
    "rename-session",
    "rename",
    "rename-window",
    "renamew",
    "resize-pane",
    "resizep",
    "rotate-window",
    "rotatew",
    "select-layout",
    "selectl",
    "select-pane",
    "selectp",
    "select-window",
    "selectw",
    "swap-pane",
    "swapp",
    "swap-window",
    "swapw",
    "unlink-window",
    "unlinkw",
];

pub fn run_verbs() -> impl Iterator<Item = &'static str> {
    super::READ_VERBS.iter().chain(ARRANGE_VERBS).copied()
}

/// What `tmuxy run` does with the command it was given, as words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliRun {
    /// Run as given, every argument quoted.
    Run,
    /// `new-window`: a new tab instead ([`tmux_command::NewTab`]), named by
    /// its `-n`.
    NewTab { name: Option<String> },
    /// Not run; why, for the person who asked.
    Refused(String),
}

/// A name counts only as written: tmux would also take a unique prefix of
/// one (`i` is `if-shell`), so a prefix of an allowed name is not allowed.
/// The arguments reach tmux as they are, so what tmux itself reads in them is
/// refused too: an argument ending in `;` ends the command and starts
/// another, and a format either runs a shell, `#(...)`, or expands a value as
/// a format again (the `E:` and `T:` modifiers), over a pane title or a path
/// any program can set.
pub fn route_cli_run(words: &[String]) -> CliRun {
    for word in words {
        if word.ends_with(';') {
            return refused("tmux reads an argument ending in ';' as the start of another command");
        }
        if word.contains("#(") {
            return refused("a '#(' format runs a shell");
        }
        let reexpands = word.as_bytes().windows(3).any(|w| {
            matches!(w[0], b'{' | b';')
                && matches!(w[1], b'E' | b'T')
                && matches!(w[2], b':' | b';')
        });
        if reexpands {
            return refused(
                "the E: and T: formats expand a value again, and a '#(' in it runs a shell",
            );
        }
    }
    let verb = words.first().map(String::as_str).unwrap_or_default();
    if RESIZE_WINDOW.named_by(verb) {
        return CliRun::Refused(RESIZE_WINDOW_REFUSAL.to_string());
    }
    if !run_verbs().any(|v| v == verb) {
        return refused(&format!(
            "'{verb}' is not a command `tmuxy run` passes on (`tmuxy run --help` lists them); keys go through `tmuxy pane send`"
        ));
    }
    if NEW_WINDOW.named_by(verb) {
        // A tab takes a name and runs a shell: anything else `new-window`
        // takes — a directory, a window index, a command — would be dropped
        // on the way, so it is refused rather than half done.
        let mut name = None;
        let mut args = words[1..].iter();
        while let Some(word) = args.next() {
            match word.as_str() {
                "-d" => {}
                "-n" => match args.next() {
                    Some(given) => name = Some(given.clone()),
                    None => return refused("-n needs a name"),
                },
                other => {
                    return refused(&format!(
                        "new-window takes only -n <name> here, not '{other}': a tab runs a shell, and `tmuxy pane run` runs a command"
                    ))
                }
            }
        }
        return CliRun::NewTab { name };
    }
    CliRun::Run
}

fn refused(why: &str) -> CliRun {
    CliRun::Refused(format!("refused: {why}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &[&str]) -> Vec<String> {
        line.iter().map(|w| w.to_string()).collect()
    }

    /// `tmuxy run` must not be a way past the question `tmuxy pane send`
    /// asks before typing into another pane — neither by typing itself nor by
    /// running a shell, which can run any tmux it likes.
    #[test]
    fn tmuxy_run_refuses_keys_shells_options_and_chains() {
        for line in [
            &["send-keys", "-t", "%3", "rm -rf ~", "Enter"][..],
            &["send", "-t%3", "id", "Enter"],
            &["send-k", "-lt", "%3", "id"],
            &["paste-buffer", "-t", "%3"],
            &["pasteb", "-p", "-t", "%3"],
            &["pipe-pane", "-t", "%3", "-I", "echo id"],
            &["send-keys", "-t", "%1", "-X", "cancel"],
            &["run-shell", "tmux send-keys -t %3 id Enter"],
            &["if-shell", "true", "send-keys -t %3 id Enter"],
            &["respawn-pane", "-k", "-t", "%3", "id"],
            &["set-environment", "-g", "TMUXY_SERVER_BIN", "/tmp/evil"],
            &["set-hook", "-g", "pane-focus-in", "send-keys id"],
            &["source-file", "/tmp/evil.conf"],
            &["i", "true", "run-shell id"],
            &["run-s", "id"],
            &["split-window", "-d", "id"],
            &["splitw", "id"],
            &["new-session", "-d", "id"],
            &["display-popup", "-E", "id"],
            &["bind-key", "-n", "F12", "run-shell id"],
            &["command-prompt", "-I", "x", "run-shell %%"],
            &["confirm-before", "run-shell id"],
            &["choose-tree", "run-shell id"],
            &["detach-client", "-E", "id"],
            &["lock-server"],
            &["set", "-s", "command-alias[100]", "zz=run-shell id"],
            &["set-option", "-g", "status-right", "#(id)"],
            &["set", "-g", "default-command", "id"],
            &["setw", "synchronize-panes", "on"],
            &[
                "set-option",
                "-p",
                "-t",
                "%3",
                "@tmuxy-ask-answer",
                "3-1:yes",
            ],
            &["display-message", "x", ";", "run-shell", "id"],
            &["display-message", "x;", "run-shell", "id"],
            &["display-message", "-p", "#(id)"],
            &["list-panes", "-F", "#{?pane_active,#(id),}"],
            &["display-message", "-p", "#{E:pane_title}"],
            &["display-message", "-p", "#{T;=10:pane_current_path}"],
        ] {
            assert!(
                matches!(route_cli_run(&words(line)), CliRun::Refused(why) if why.starts_with("refused: ")),
                "{line:?}"
            );
        }
    }

    #[test]
    fn tmuxy_run_runs_what_reads_arranges_or_closes() {
        for line in [
            &["list-panes", "-F", "#{pane_id} #{?pane_active,active,}"][..],
            &["display-message", "-p", "#{session_name}"],
            &["select-pane", "-t", "%3", "-T", "build"],
            &["swap-pane", "-s", "%0", "-t", "%1"],
            &["move-window", "-s", "work:0", "-t", "work:1"],
            &["copy-mode", "-q", "-t", "%3"],
            &["kill-session", "-t", "scratch"],
        ] {
            assert_eq!(route_cli_run(&words(line)), CliRun::Run, "{line:?}");
        }
    }

    /// `new-window` crashes tmux 3.5a with control mode attached: a new tab
    /// instead, keeping its name; `resize-window` is refused, as for a client.
    #[test]
    fn tmuxy_run_turns_new_window_into_a_tab_and_refuses_resize_window() {
        assert_eq!(
            route_cli_run(&words(&["neww"])),
            CliRun::NewTab { name: None }
        );
        assert_eq!(
            route_cli_run(&words(&["new-window", "-d", "-n", "my-win"])),
            CliRun::NewTab {
                name: Some("my-win".into())
            }
        );
        for verb in ["resize-window", "resizew"] {
            assert!(matches!(
                route_cli_run(&words(&[verb, "-x", "80"])),
                CliRun::Refused(why) if why.starts_with("resize-window is blocked")
            ));
        }
        // What a tab cannot carry is refused, never dropped: a command for
        // the new pane, a directory, a window index.
        for line in [
            &["new-window", "htop"][..],
            &["neww", "-c", "/tmp"],
            &["new-window", "-t", "work:3"],
            &["new-window", "-n"],
        ] {
            assert!(
                matches!(route_cli_run(&words(line)), CliRun::Refused(why) if why.starts_with("refused: ")),
                "{line:?}"
            );
        }
    }
}
