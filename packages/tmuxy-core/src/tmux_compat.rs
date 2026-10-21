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
//! - the `neww` rewrite (3.5a crash): `executor::new_window_rewrite`, applied
//!   by `command_router::route_command` on every transport;
//! - every mutation from a script through `run-shell`, never a second client
//!   (3.3a–3.5a crash): `bin/tmuxy/_lib`, `transport.rs`, `theme.rs`;
//! - session-scoped rather than global option writes while attached (3.5a
//!   crash): `control_mode/monitor/sync.rs`;
//! - `run-shell` output redirected to files (3.4 shows it in view-mode):
//!   `_run_shell` in `bin/tmuxy/_lib`, `ask_run_shell` in `session_snapshot`;
//! - the copy-mode flag asked as `#{pane_mode}`, not `#{pane_in_mode}` (3.4
//!   put a fresh pane in view-mode): `constants::tmux_formats`;
//! - a space as the group listing's separator (3.4 prints a control
//!   character as `_`): `groups::LIST_PANES_FORMAT`;
//! - `set -q` for `allow-passthrough` (absent on 3.2): `monitor/sync.rs`;
//! - the JSON `#{window_layout}` of 3.8 read back into the classic string:
//!   `layout::parse_json`;
//! - the version floor itself (3.2): `tmux_check`.

use crate::executor::{command_verb, split_compound};

/// A list the clients read that a command changes without a notification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relist {
    Windows,
    Panes,
}

/// One kind of command tmux answers with no notification.
pub struct Silent {
    /// The list to refresh behind it.
    pub relist: Relist,
    /// The verbs heading a command this applies to; empty means any verb.
    pub verbs: &'static [&'static str],
    /// A further condition on the command — its flags, the option it names.
    pub when: fn(&str) -> bool,
    /// The tmux versions it holds for.
    pub tmux: &'static str,
    /// What goes unannounced.
    pub because: &'static str,
}

const fn always(_: &str) -> bool {
    true
}

/// A `@tmuxy-*` option is named in the command.
fn names_tmuxy_option(command: &str) -> bool {
    command.contains("@tmuxy-")
}

/// A `@tmuxy-*` option is written with a pane-scope flag (`-p`, `-pu`, …).
fn names_pane_scoped_tmuxy_option(command: &str) -> bool {
    names_tmuxy_option(command)
        && command
            .split_whitespace()
            .any(|tok| tok.starts_with('-') && !tok.starts_with("--") && tok.contains('p'))
}

/// The stack script sets and unsets `@tmuxy-collapsible` itself, where the
/// write is invisible here; bindings arrive with the alias already expanded
/// to its `run-shell "bash …/tmuxy/stack …"`.
fn runs_the_stack_script(command: &str) -> bool {
    command.contains("tmuxy-stack") || command.contains("tmuxy/stack")
}

/// The mark is toggled: `select-pane -m` / `-M`.
fn marks_a_pane(command: &str) -> bool {
    command.split_whitespace().any(|w| w == "-m" || w == "-M")
}

/// Every command tmux leaves unannounced, and the list to read behind it.
pub const SILENT_COMMANDS: &[Silent] = &[
    Silent {
        relist: Relist::Windows,
        verbs: &["set-option", "set", "set-window-option", "setw"],
        when: names_tmuxy_option,
        tmux: "every version",
        because: "a user option (a dragged sidebar width, a hidden column, a focus request) \
                  changes without a notification, and the clients read it off list-windows",
    },
    Silent {
        relist: Relist::Windows,
        verbs: &[],
        when: runs_the_stack_script,
        tmux: "every version",
        because: "the stack script writes @tmuxy-collapsible from inside run-shell, and the \
                  re-list is what turns the flag into a relayout",
    },
    Silent {
        relist: Relist::Windows,
        verbs: &[
            "move-window",
            "movew",
            "swap-window",
            "swapw",
            "renumber-windows",
        ],
        when: always,
        tmux: "every version",
        because: "a reorder renumbers every window past the moved one and tmux announces \
                  none of them; the tab strip would show two tabs at one index",
    },
    Silent {
        relist: Relist::Panes,
        verbs: &["select-pane", "selectp"],
        when: marks_a_pane,
        tmux: "every version",
        because: "#{pane_marked} changes without a notification",
    },
    Silent {
        relist: Relist::Panes,
        verbs: &["set-option", "set", "setp"],
        when: names_pane_scoped_tmuxy_option,
        tmux: "every version",
        because: "a pane-scoped @tmuxy-* write changes list-panes and nothing else: answering \
                  a `tmuxy pane send -t` clears @tmuxy-ask, and the question would stay on \
                  screen until the next event moved it",
    },
    Silent {
        relist: Relist::Panes,
        verbs: &["swap-pane", "swapp"],
        when: always,
        tmux: "3.2",
        because: "no %layout-change follows a swap; on later versions the re-list only repeats \
                  what the notification brought",
    },
];

/// The lists to refresh behind `command`, a client's command list with its
/// `\;` separators unescaped or not.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Relists {
    pub windows: bool,
    pub panes: bool,
}

/// Which lists `command` leaves stale. Only the verb heading each command of
/// the list counts — anywhere else it is an argument, a key sent to a shell.
pub fn relists_after(command: &str) -> Relists {
    let mut relists = Relists::default();
    for part in split_compound(command)
        .iter()
        .flat_map(|part| part.split(" ; "))
    {
        let verb = command_verb(part);
        for silent in SILENT_COMMANDS {
            if (silent.verbs.is_empty() || silent.verbs.contains(&verb)) && (silent.when)(part) {
                match silent.relist {
                    Relist::Windows => relists.windows = true,
                    Relist::Panes => relists.panes = true,
                }
            }
        }
    }
    relists
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows(command: &str) -> bool {
        relists_after(command).windows
    }

    fn panes(command: &str) -> bool {
        relists_after(command).panes
    }

    #[test]
    fn reorder_commands_re_list_the_windows() {
        assert!(windows("move-window -b -s @3 -t @1"));
        assert!(windows("select-window -t @0 \\; swapw -s @3 -t @1"));
        // The monitor asks after unescaping the client's `\;`.
        assert!(windows("select-window -t @0 ; swapw -s @3 -t @1"));
        assert!(windows("renumber-windows"));
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
            "select-window -t @0 \\; select-pane -t %2 \\; run-shell \"bash /x/tmuxy/stack off #{window_id}\""
        ));
        assert!(windows("tmuxy-stack-off"));
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
        let window_write = relists_after("set-option -w -t @1 @tmuxy-collapsible 1");
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

    #[test]
    fn every_silent_command_says_which_tmux_and_why() {
        for silent in SILENT_COMMANDS {
            assert!(!silent.tmux.is_empty() && !silent.because.is_empty());
        }
    }
}
