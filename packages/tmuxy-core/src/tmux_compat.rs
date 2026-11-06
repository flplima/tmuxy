//! What tmux does not announce, and so what the monitor re-lists behind a
//! client's command.
//!
//! tmux reports most state changes as control-mode notifications; this is the
//! table of the ones it does not — a user option written, a pane marked, the
//! windows renumbered — each with the list the clients then read stale until
//! the idle heartbeat. The monitor asks [`relists_after`] about every command
//! a client sends and refreshes those lists right behind it.
//!
//! The other version-specific behaviour tmuxy carries lives where it acts, and
//! docs/TMUX-VERSION-BUGS.md is the account of all of it:
//!
//! - the `neww` rewrite (3.5a crash): `tmux_command::new_window_rewrite`,
//!   applied by `command_router::route_command` on every transport;
//! - typed text cut at every `#{` (3.7a expands `send-keys -l`):
//!   [`split_format_literals`], applied by the router too;
//! - every mutation from a script through `run-shell`, never a second client
//!   (3.3a–3.5a crash): `packages/tmuxy-cli/bin/tmuxy/_lib`, `transport.rs`, `theme.rs`;
//! - session- and window-scoped rather than global option writes while
//!   attached (3.5a crash): `control_mode/monitor_core/attach.rs`,
//!   `control_mode/state/window_state.rs` (`window_setup_commands`);
//! - `run-shell` output relayed through a server option (3.4 shows it in
//!   view-mode): `control_mode/monitor_core/run_shell.rs`;
//! - `run-shell` output redirected to files (the same, for scripts):
//!   `_run_shell` in `packages/tmuxy-cli/bin/tmuxy/_lib`, `ask_run_shell` in `session_snapshot`;
//! - the copy-mode flag asked as `#{pane_mode}`, not `#{pane_in_mode}` (3.4
//!   put a fresh pane in view-mode): `constants::tmux_formats`;
//! - a space as the group listing's separator (3.4 prints a control
//!   character as `_`): `groups::list_panes_format`;
//! - `-q` for `allow-passthrough` (absent on 3.2):
//!   `control_mode/state/window_state.rs`;
//! - the JSON `#{window_layout}` of 3.8 read back into the classic string:
//!   `layout::parse_json`;
//! - the version floor itself (3.2): `tmux_check`.

use std::sync::LazyLock;

use crate::tmux_command::{
    self, unquote, Command, CommandList, TmuxCommand, MOVE_WINDOW, RUN_SHELL, SELECT_PANE,
    SEND_KEYS, SET_OPTION, SET_WINDOW_OPTION, SWAP_PANE, SWAP_WINDOW,
};

/// A list the clients read that a command changes without a notification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relist {
    Windows,
    Panes,
}

/// One kind of command tmux answers with no notification. What goes
/// unannounced, and on which tmux versions, is said where each is listed.
pub struct Silent {
    pub relist: Relist,
    /// The commands this applies to; empty means any command.
    pub commands: &'static [&'static TmuxCommand],
    /// A further condition on the command — its flags, the option it names.
    pub when: fn(&Command) -> bool,
}

const fn always(_: &Command) -> bool {
    true
}

fn names_tmuxy_option(command: &Command) -> bool {
    command.args().iter().any(|w| w.contains("@tmuxy-"))
}

/// A `@tmuxy-*` option is written with a pane-scope flag (`-p`, `-pu`, …).
fn names_pane_scoped_tmuxy_option(command: &Command) -> bool {
    names_tmuxy_option(command)
        && command
            .args()
            .iter()
            .any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('p'))
}

/// The script writes options tmux does not announce from inside its
/// `run-shell`, where the write is invisible here (`RELIST_TAG`).
fn runs_a_relisting_script(command: &Command) -> bool {
    starts_tagged_script(command, RELIST_TAG)
}

fn marks_a_pane(command: &Command) -> bool {
    command.args().iter().any(|w| *w == "-m" || *w == "-M")
}

/// Every command tmux leaves unannounced, and the list to read behind it.
pub const SILENT_COMMANDS: &[Silent] = &[
    // A user option (a dragged sidebar width, a hidden column, a focus request) changes without
    // a notification, and the clients read it off list-windows (every version).
    Silent {
        relist: Relist::Windows,
        commands: &[&SET_OPTION, &SET_WINDOW_OPTION],
        when: names_tmuxy_option,
    },
    // The stack script writes @tmuxy-collapsible from inside run-shell, and the re-list is what
    // turns the flag into a relayout (every version).
    Silent {
        relist: Relist::Windows,
        commands: &[&RUN_SHELL],
        when: runs_a_relisting_script,
    },
    // A reorder renumbers every window past the moved one and tmux announces none of them; the
    // tab strip would show two tabs at one index (every version).
    Silent {
        relist: Relist::Windows,
        commands: &[&MOVE_WINDOW, &SWAP_WINDOW],
        when: always,
    },
    // #{pane_marked} changes without a notification (every version).
    Silent {
        relist: Relist::Panes,
        commands: &[&SELECT_PANE],
        when: marks_a_pane,
    },
    // A pane-scoped @tmuxy-* write changes list-panes and nothing else: answering a `tmuxy pane
    // send -t` clears @tmuxy-ask, and the question would stay on screen until the next event
    // moved it (every version).
    Silent {
        relist: Relist::Panes,
        commands: &[&SET_OPTION],
        when: names_pane_scoped_tmuxy_option,
    },
    // No %layout-change follows a swap; on later versions the re-list only repeats what the
    // notification brought (3.2).
    Silent {
        relist: Relist::Panes,
        commands: &[&SWAP_PANE],
        when: always,
    },
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Relists {
    pub windows: bool,
    pub panes: bool,
}

/// Which lists `list` leaves stale. Each command of it counts, inside a
/// block or not, under any name tmux runs it by — and one that names a
/// command-alias of tmuxy's own counts as the alias's body. A word anywhere
/// else is an argument, a key sent to a shell.
pub fn relists_after(list: &CommandList) -> Relists {
    let mut relists = Relists::default();
    each_command(list, &mut |command| {
        for silent in SILENT_COMMANDS {
            let applies =
                silent.commands.is_empty() || silent.commands.iter().any(|c| command.runs(c));
            if applies && (silent.when)(command) {
                match silent.relist {
                    Relist::Windows => relists.windows = true,
                    Relist::Panes => relists.panes = true,
                }
            }
        }
    });
    relists
}

/// What a tmuxy script that changes tmux in several separate steps — split,
/// break, set-option, swap, resize — puts ahead of its shell command, as a
/// shell variable assignment the shell ignores: `run-shell "TMUXY_EFFECT=settle
/// …/pane-group add …"`. Each step fires its own `%layout-change` or
/// `%window-add`; the monitor holds the emissions back until they settle, or
/// the clients would draw the intermediate split before the final layout.
/// The UI (`scriptWith` in `tmuxy-ui/src/domain/commandHelpers.ts`) and the
/// essentials aliases write it.
pub const SETTLE_TAG: &str = "TMUXY_EFFECT=settle";

/// What a tmuxy script that writes options tmux does not announce puts ahead
/// of its shell command, the same way (the stack script and its
/// `@tmuxy-collapsible`): the windows are re-listed behind it.
pub const RELIST_TAG: &str = "TMUXY_EFFECT=relist-windows";

pub fn settles(list: &CommandList) -> bool {
    let mut found = false;
    each_command(list, &mut |command| {
        found |= starts_tagged_script(command, SETTLE_TAG)
    });
    found
}

fn starts_tagged_script(command: &Command, tag: &str) -> bool {
    command.runs(&RUN_SHELL)
        && command.args().iter().any(|word| {
            word.trim_start_matches(['\'', '"'])
                .trim_start()
                .starts_with(tag)
        })
}

fn each_command(list: &CommandList, visit: &mut dyn FnMut(&Command)) {
    for command in list.every() {
        match tmuxy_alias(command.verb()) {
            Some(body) => tmux_command::parse(body).every().for_each(&mut *visit),
            None => visit(command),
        }
    }
}

/// The body of the command-alias `name`, as `tmuxy.essentials.conf` — the
/// file that defines every alias a binding resolves to — spells it.
fn tmuxy_alias(name: &str) -> Option<&'static str> {
    static ALIASES: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
        include_str!("../assets/tmuxy.essentials.conf")
            .lines()
            .filter_map(|line| {
                let list = tmux_command::parse(line);
                let command = list.top_level().next()?;
                let definition = command
                    .args()
                    .iter()
                    .find_map(|w| unquote(w).filter(|_| w.starts_with('\'')))?;
                command
                    .args()
                    .iter()
                    .any(|w| w.starts_with("command-alias"))
                    .then(|| definition.split_once('='))
                    .flatten()
                    .map(|(name, body)| (name.to_string(), body.to_string()))
            })
            .collect()
    });
    ALIASES
        .iter()
        .find(|(alias, _)| alias == name)
        .map(|(_, body)| body.as_str())
}

/// tmux 3.7a format-expands the text of a `send-keys -l`, and doubling the
/// `#` does not protect a valid variable (`##{pane_id}` still arrives as
/// `#%0`; docs/TMUX-VERSION-BUGS.md). Typed text holding a `#{` is therefore
/// sent as several `send-keys -l`, one line each, cut between every `#` and
/// the `{` after it, so the two never share a format context; the pane gets
/// the text back whole. `None` leaves `list` as it came: anything but one
/// `send-keys -l` whose text holds a `#{`.
pub fn split_format_literals(list: &CommandList) -> Option<Vec<String>> {
    let mut top = list.top_level();
    let command = top.next()?;
    if top.next().is_some() || list.has_blocks() || !command.runs(&SEND_KEYS) {
        return None;
    }
    let (literal, before) = command.words().split_last()?;
    if !before.contains(&"-l") {
        return None;
    }
    let text = unquote(literal)?;
    if !text.contains("#{") {
        return None;
    }
    let at = literal.as_ptr() as usize - command.text.as_ptr() as usize;
    let prefix = command.text[..at].trim_start();
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut previous = None;
    for c in text.chars() {
        if previous == Some('#') && c == '{' {
            parts.push(std::mem::take(&mut part));
        }
        part.push(c);
        previous = Some(c);
    }
    parts.push(part);
    Some(
        parts
            .iter()
            .map(|part| format!("{prefix}{}", crate::tmux_quote(part)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relists(command: &str) -> Relists {
        relists_after(&tmux_command::parse(command))
    }

    fn windows(command: &str) -> bool {
        relists(command).windows
    }

    fn panes(command: &str) -> bool {
        relists(command).panes
    }

    #[test]
    fn reorder_commands_re_list_the_windows() {
        assert!(windows("move-window -b -s @3 -t @1"));
        assert!(windows("select-window -t @0 \\; swapw -s @3 -t @1"));
        assert!(windows("select-window -t @0 ; swapw -s @3 -t @1"));
        // Inside a block, and under a prefix tmux runs it by.
        assert!(windows("if -F 1 { move-w -r }"));
        assert!(!windows("select-window -t @3"));
        assert!(!windows("send-keys -t %1 move-window Enter"));
    }

    /// tmux 3.2 sends no `%layout-change` for a swap, so the panes are
    /// re-listed behind every one — pinned by the keyboard actor or not.
    #[test]
    fn pane_swaps_re_list_the_panes() {
        assert!(panes("swap-pane -D"));
        assert!(panes(
            "select-window -t @8 ; select-pane -t %32 ; swap-pane -D"
        ));
        assert!(panes("select-pane -t %3 \\; swapp -s %1 -t %2"));
        assert!(!panes("select-pane -t %3"));
        assert!(!panes("send-keys -t %1 swap-pane Enter"));
    }

    #[test]
    fn option_writes_and_the_stack_script_re_list_the_windows() {
        assert!(windows(
            "select-window -t @0 ; select-pane -t %2 ; run-shell \"TMUXY_EFFECT=relist-windows bash /x/tmuxy/stack off #{window_id}\""
        ));
        // A binding names the alias; its body, in tmuxy.essentials.conf, is
        // what runs.
        assert!(windows("tmuxy-stack-off"));
        assert!(!windows("tmuxy-nav-left"));
        assert!(!windows("run-shell \"bash /x/tmuxy/nav left\""));
        assert!(windows("set-o -w -t @1 @tmuxy-sidebar-hidden 1"));
        assert!(windows("set-option -w -t @1 @tmuxy-collapsible 1"));
        assert!(windows("set -w -t @1 @tmuxy-sidebar-cols 40"));
        assert!(!windows("split-window -h"));
        // A key sent to a shell is not a command, whatever it spells.
        assert!(!windows(
            "send-keys -t %1 'set-option @tmuxy-collapsible 1' Enter"
        ));
    }

    /// Answering a `tmuxy pane send -t` is a pane-scoped option write, and the
    /// question stays on screen until the panes are re-listed behind it.
    #[test]
    fn pane_scoped_option_writes_re_list_the_panes() {
        assert!(panes("set-option -pu -t %3 @tmuxy-ask"));
        assert!(panes(
            "set-option -pu -t %3 @tmuxy-ask \\; set-option -p -t %3 @tmuxy-ask-answer 'a1:yes'"
        ));
        // Window- and session-scoped writes go the other way (list-windows).
        let window_write = relists("set-option -w -t @1 @tmuxy-collapsible 1");
        assert!(window_write.windows && !window_write.panes);
        assert!(!panes("split-window -h"));
        // A pane option that isn't ours changes nothing tmuxy reads.
        assert!(!panes("set-option -p -t %3 remain-on-exit on"));
    }

    #[test]
    fn marking_a_pane_re_lists_the_panes() {
        assert!(panes("select-pane -m -t %3"));
        assert!(panes("selectp -M"));
        assert!(!panes("select-pane -t %3"));
        assert!(!panes("send-keys -t %1 'select-pane -m' Enter"));
    }

    /// The multi-step scripts say so on the `run-shell` that starts them,
    /// whoever builds it — a binding's alias or a client's command.
    #[test]
    fn a_script_tagged_to_settle_is_seen_however_it_is_started() {
        let settles = |c: &str| settles(&tmux_command::parse(c));
        assert!(settles(
            "select-pane -t %3 ; run-shell \"TMUXY_EFFECT=settle $TMUXY_DATA_DIR/bin/tmuxy/pane-group add %3 80 24\""
        ));
        assert!(settles("tmuxy-pane-group-add"));
        assert!(settles("tmuxy-float"));
        assert!(!settles(
            "run-shell \"$TMUXY_DATA_DIR/bin/tmuxy/pane-group join %3 %1 0\""
        ));
        assert!(!settles(
            "send-keys -t %1 -l 'TMUXY_EFFECT=settle run-shell x'"
        ));
        assert!(!settles("tmuxy-nav-left"));
    }

    /// Every essentials alias a binding resolves to is readable here, so
    /// none is left for the monitor to treat as an unknown verb.
    #[test]
    fn every_tmuxy_alias_is_read_from_the_essentials() {
        for alias in [
            "tmuxy-pane-group-add",
            "tmuxy-stack",
            "tmuxy-nav-up",
            "tmuxy-float",
        ] {
            assert!(
                tmuxy_alias(alias).is_some_and(|body| body.starts_with("run-shell ")),
                "{alias}"
            );
        }
        assert_eq!(tmuxy_alias("tmuxy-nope"), None);
    }

    /// 3.7a: typed text with a `#{` goes as one `send-keys -l` per piece,
    /// cut between each `#` and its `{`; the pane reassembles it verbatim.
    #[test]
    fn typed_text_is_cut_between_every_hash_and_brace() {
        let split = |c: &str| split_format_literals(&tmux_command::parse(c));
        assert_eq!(
            split("send-keys -t %3 -l -- 'echo #{pane_id} ##{x}'"),
            Some(vec![
                "send-keys -t %3 -l -- 'echo #'".to_string(),
                "send-keys -t %3 -l -- '{pane_id} ##'".to_string(),
                "send-keys -t %3 -l -- '{x}'".to_string(),
            ])
        );
        assert_eq!(
            split("send-keys -t %3 -l -- 'it'\\''s #{a}'"),
            Some(vec![
                "send-keys -t %3 -l -- 'it'\\''s #'".to_string(),
                "send-keys -t %3 -l -- '{a}'".to_string(),
            ])
        );
        for untouched in [
            "send-keys -t %3 -l -- 'no format here'",
            "send-keys -t %3 -l -- '#notbrace'",
            "send-keys -t %3 Enter",
            "display -p '#{pane_id}'",
            "send-keys -t %3 -l 'a#{b}' ; display x",
        ] {
            assert_eq!(split(untouched), None, "{untouched}");
        }
    }
}
