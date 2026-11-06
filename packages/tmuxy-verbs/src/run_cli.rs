//! `tmuxy run` and `tmuxy tab create`: a tmux command the caller names, run
//! inside `run-shell` under the one routing policy
//! (`tmuxy_core::command_router::route_cli_run`), and a new tab.

use tmuxy_core::argv::run_shell_line;
use tmuxy_core::command_router::{route_cli_run, CliRun, RUN_VERBS};
use tmuxy_core::paths::Layout;
use tmuxy_core::run_shell::{self, Ran, RunShellError};
use tmuxy_core::tmux_command::NewTab;
use tmuxy_core::PaneId;

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_NO_SERVER, EXIT_USAGE};

#[derive(clap::Args, Debug)]
pub struct RunArgs {
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
    /// The tmux command and its arguments, or the whole command as one
    /// argument.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    words: Vec<String>,
}

#[derive(clap::Args, Debug)]
pub struct NewTabArgs {
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
    name: Option<String>,
}

pub fn run(args: RunArgs) {
    let answer = Answer::new(args.json);
    if matches!(
        args.words.first().map(String::as_str),
        Some("--help" | "-h")
    ) {
        print!("{}", usage());
        return;
    }
    let words = match args.words.as_slice() {
        [] => {
            if !args.json {
                eprint!("Error: tmux command required\n{}", usage());
                std::process::exit(EXIT_USAGE);
            }
            answer.exit(EXIT_USAGE, "tmux command required")
        }
        [line] if line.contains(char::is_whitespace) => match split_words(line) {
            Some(words) => words,
            None => answer.exit(EXIT_USAGE, &format!("unterminated quote in {line:?}")),
        },
        words => words.to_vec(),
    };
    match route_cli_run(&words) {
        CliRun::Refused(why) => answer.exit(EXIT_FAILED, &why),
        CliRun::NewTab { name } => {
            eprintln!("Note: new-window intercepted for safety. Using split-window + break-pane.");
            new_tab(&answer, name.as_deref());
        }
        CliRun::Run => run_words(&answer, &words),
    }
}

pub fn tab_create(args: NewTabArgs) {
    new_tab(&Answer::new(args.json), args.name.as_deref());
}

/// The pane the caller runs in, as tmuxy-cli resolved it: what a target-less
/// command means, since the client inside `run-shell` is attached to nothing.
fn caller_pane() -> Option<String> {
    std::env::var("TMUX_PANE")
        .ok()
        .filter(|pane| PaneId::parse(pane).is_ok())
}

fn run_words(answer: &Answer, words: &[String]) {
    let caller = caller_pane();
    let line = run_line(
        caller.as_deref(),
        &tmuxy_core::session::tmux_argv(false),
        words,
    );
    match run_shell::shell(&Layout::current(), &line, caller.as_deref()) {
        Ok(ran) => relay(answer, &ran),
        Err(e) => fail_to_run(answer, e),
    }
}

/// The shell line `run-shell` runs: tmux on tmuxy's socket and the words,
/// each quoted so neither `run-shell`'s format expansion nor its shell reads
/// anything in them. The inner client is attached to nothing, so the caller's
/// pane rides along as its TMUX_PANE, which tmux reads for an unattached
/// client the way it does for a shell in a pane.
fn run_line(caller: Option<&str>, tmux: &[String], words: &[String]) -> String {
    let mut line = caller
        .map(|pane| format!("TMUX_PANE={pane} "))
        .unwrap_or_default();
    line.push_str(&run_shell_line(tmux));
    line.push(' ');
    line.push_str(&run_shell_line(words));
    line
}

/// What the command printed, as if it had run here, and its exit status.
fn relay(answer: &Answer, ran: &Ran) {
    eprint!("{}", ran.err);
    let fields = [
        ("status", ran.status.to_string()),
        ("stdout", cli_json::string(&ran.out)),
    ];
    if !answer.is_json() {
        print!("{}", ran.out);
    } else if ran.status == 0 {
        answer.done(&fields, "");
    } else {
        answer.fail_with(ran.status, ran.err.trim(), &fields);
    }
    if ran.status != 0 {
        std::process::exit(ran.status);
    }
}

fn fail_to_run(answer: &Answer, e: RunShellError) -> ! {
    match e {
        RunShellError::NoServer(_) => answer.exit(
            EXIT_NO_SERVER,
            &format!(
                "no tmux server on socket '{}'",
                tmuxy_core::session::tmux_socket()
            ),
        ),
        e => answer.exit(EXIT_FAILED, &e.to_string()),
    }
}

/// A new tab beside the caller's pane, in the caller's session.
fn new_tab(answer: &Answer, name: Option<&str>) {
    let caller = caller_pane();
    let mut read = vec!["display-message".to_string(), "-p".to_string()];
    if let Some(pane) = &caller {
        read.extend(["-t".to_string(), pane.clone()]);
    }
    read.push("#{session_id}".to_string());
    let session = match tmuxy_core::session::tmux_output(&read) {
        Ok(out) => out.trim().to_string(),
        Err(e) if tmuxy_core::session::is_no_server(&e.to_string()) => {
            fail_to_run(answer, RunShellError::NoServer(e.to_string()))
        }
        Err(e) => answer.exit(EXIT_FAILED, &e.to_string()),
    };
    let tab = NewTab {
        from: caller.as_deref(),
        into: Some(&session).filter(|s| !s.is_empty()).map(String::as_str),
        name,
        print_id: true,
        ..NewTab::default()
    };
    let out = match run_shell::tmux(&Layout::current(), &tab.argv()) {
        Ok(out) => out,
        Err(e) => fail_to_run(answer, e),
    };
    let id = out
        .split_whitespace()
        .rfind(|w| w.starts_with('@'))
        .unwrap_or_default();
    answer.done(&[("tabId", cli_json::string(id))], id);
}

/// A command written as one argument, split as a shell splits words: on
/// blanks, with single quotes, double quotes and backslashes. `None` when a
/// quote is left open.
fn split_words(line: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if let Some(done) = word.take() {
                    words.push(done);
                }
            }
            '\'' => {
                let w = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => w.push(c),
                    }
                }
            }
            '"' => {
                let w = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => w.push(chars.next()?),
                        c => w.push(c),
                    }
                }
            }
            '\\' => word.get_or_insert_with(String::new).push(chars.next()?),
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    Some(words)
}

fn usage() -> String {
    format!("{USAGE_HEAD}{}\n{USAGE_TAIL}", verb_list())
}

/// The commands `tmuxy run` passes on by their full names, wrapped.
fn verb_list() -> String {
    let names: Vec<&str> = RUN_VERBS
        .iter()
        .copied()
        .filter(|name| name.contains('-') && !matches!(*name, "new-window" | "resize-window"))
        .collect();
    let mut list = String::new();
    let mut row = String::from(" ");
    for name in names {
        if row.len() + name.len() + 1 > 76 {
            list.push_str(row.trim_end());
            list.push('\n');
            row = String::from(" ");
        }
        row.push(' ');
        row.push_str(name);
    }
    list.push_str(row.trim_end());
    list
}

const USAGE_HEAD: &str = "Usage: tmuxy run <tmux-command> [args...]

Run a tmux command that reads, arranges or closes panes and windows,
safely through run-shell.

It runs these, by full name or alias (never a prefix):
";

const USAGE_TAIL: &str = "
And refuses everything else:
  - keys into any pane, your own too (send-keys, paste-buffer, pipe-pane):
    use `tmuxy pane send`, which asks the user before typing into another
  - commands that run a shell or keep a command for later (run-shell,
    if-shell, split-window, new-session, respawn-pane, bind-key,
    command-prompt, display-popup, …): use `tmuxy pane split`, `pane run`,
    `tab create`
  - writes to an option, hook or the environment (set-option, set-hook,
    set-environment, source-file)
  - an argument ending in `;` (tmux starts another command there), and a
    format that runs a shell: `#(…)`, or the `E:` and `T:` modifiers
  - new-window is intercepted → `tmuxy tab create`
  - resize-window is blocked (unreliable with control mode attached)

Every argument reaches tmux quoted: `#{…}` formats are expanded by the
command they are given to, never by run-shell.

Examples:
  tmuxy run swap-pane -s %0 -t %1
  tmuxy run list-panes -F '#{pane_id} #{pane_current_command}'
  tmuxy run copy-mode -q            # leave copy mode
  tmuxy run new-window              # intercepted → safe alternative
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_in_one_argument_is_split_as_a_shell_splits_it() {
        let split = |line: &str| split_words(line).unwrap_or_default();
        assert_eq!(
            split(r##"list-sessions -F "#{session_name} #{session_attached}""##),
            ["list-sessions", "-F", "#{session_name} #{session_attached}"]
        );
        assert_eq!(
            split("list-panes $(touch /tmp/owned)"),
            ["list-panes", "$(touch", "/tmp/owned)"]
        );
        assert_eq!(
            split("rename-window 'it''s' a\\ tab"),
            ["rename-window", "its", "a tab"]
        );
    }

    #[test]
    fn every_word_reaches_tmux_as_written() {
        let words = |w: &[&str]| w.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(
            run_line(
                Some("%1"),
                &words(&["tmux", "-S", "/tmp/my sockets/tmuxy"]),
                &words(&["list-panes", "-F", "#{a:59}id", "it's"]),
            ),
            "TMUX_PANE=%1 tmux -S '/tmp/my sockets/tmuxy' list-panes -F '##{a:59}id' 'it'\\''s'"
        );
        assert_eq!(
            run_line(
                None,
                &words(&["tmux", "-L", "tmuxy"]),
                &words(&["kill-server"])
            ),
            "tmux -L tmuxy kill-server"
        );
    }

    #[test]
    fn the_help_lists_every_full_name_but_the_two_it_intercepts() {
        let list = verb_list();
        assert!(list.starts_with("  break-pane capture-pane"), "{list}");
        assert!(list.ends_with(" unlink-window"), "{list}");
        for left_out in ["breakp", "new-window", "resize-window"] {
            assert!(!list.split_whitespace().any(|w| w == left_out), "{list}");
        }
        assert!(
            list.lines().all(|line| line.chars().count() <= 76),
            "{list}"
        );
        assert!(usage().contains(&list));
    }
}
