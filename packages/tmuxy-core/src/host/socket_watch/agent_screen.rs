//! The screen's word on an agent's pane, for the moments its hooks say
//! nothing: Antigravity has no hook for a permission prompt at all, and
//! Claude Code and Codex fire none when the user answers one — the next
//! hook is the tool finishing, which for a long command is minutes later.
//!
//! So the bottom of every agent pane its hooks have marked is read, and the
//! state corrected on one sign only: an approval dialog. One on screen is
//! `needs-input`; one seen to go away again is `working`, the user having
//! answered it. Nothing else on a screen is trusted: a quiet screen proves
//! nothing, and the hooks own every other change. It is what the tmux tools
//! for agents settled on (agent-deck, tmux-agent-deck, bosun): hooks for the
//! turn, the screen for the dialogs.
//!
//! Reads are read-only tmux subprocesses (`capture-pane`), which tmux runs
//! safely beside an attached control-mode client; the one write goes
//! through `run-shell`, as the CLI's do (docs/TMUX.md).

use std::collections::HashSet;

use super::PaneRow;
use crate::argv::run_shell_word;
use crate::constants::tmux_options;

/// How far up a dialog is looked for: the bottom of the screen, where every
/// agent draws its prompt, and not output that has scrolled above it.
const BOTTOM_LINES: usize = 15;

/// The question lines the agents' approval dialogs open with: Claude Code's
/// "Do you want to proceed?" / "Do you want to make this edit…", Codex's
/// "Would you like to run the following command?", Antigravity's "Do you
/// want to proceed?", "Allow access to this file?", "Requesting permission
/// for:".
const QUESTIONS: [&str; 4] = [
    "Do you want to",
    "Would you like to",
    "Requesting permission",
    "Allow access to",
];

/// The glyphs a dialog's menu marks its chosen option with.
const CURSORS: [char; 4] = ['❯', '›', '>', '▶'];

/// The processes of the agents tmuxy installs hooks for (`tmuxy agent`),
/// Antigravity under either of its names.
pub const AGENT_COMMANDS: [&str; 4] = ["claude", "codex", "agy", "antigravity"];

pub fn is_agent(command: &str) -> bool {
    AGENT_COMMANDS.contains(&crate::program::program_name(command))
}

/// A tmux format, `1` while text may be typed into the pane for its agent:
/// one of [`AGENT_COMMANDS`] runs there (Claude Code under its version
/// number too), it is not waiting for an answer, and no `pane send` question
/// is up. Evaluated by tmux in the same command list as the keys it guards
/// (the diff review's send), so a shell, or a dialog the client has not seen
/// yet, gets nothing.
pub fn agent_takes_input_format() -> String {
    use crate::constants::tmux_options::{ASK, PANE_STATE};
    let command = "#{pane_current_command}";
    let agent = AGENT_COMMANDS
        .iter()
        .map(|name| format!("#{{==:{command},{name}}}"))
        .chain([format!("#{{m:[0-9]*.[0-9]*,{command}}}")])
        .reduce(|either, next| format!("#{{||:{either},{next}}}"))
        .unwrap_or_default();
    let needs_input = crate::PaneStateName::NeedsInput.as_str();
    format!("#{{&&:{agent},#{{&&:#{{!=:#{{{PANE_STATE}}},{needs_input}}},#{{==:#{{{ASK}}},}}}}}}")
}

/// A menu option's line (`N. text`, maybe after a cursor glyph): whether the
/// cursor is on it, and its text.
fn option_number(line: &str) -> Option<(bool, &str)> {
    let line = line.trim_start();
    let (cursor, rest) = match line.strip_prefix(CURSORS) {
        Some(rest) => (true, rest.trim_start()),
        None => (false, line),
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && rest[digits..].starts_with(". ")).then(|| (cursor, &rest[digits + 2..]))
}

/// Whether the bottom of `screen` shows an approval dialog: a numbered menu
/// with its cursor on an option, or one of the dialogs' questions over a
/// "Yes", or a `(y/n)`. Each needs two lines' agreement, or a closing
/// question in the agent's own reply ("Would you like to…?") would count.
pub fn shows_dialog(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
    let bottom = &lines[lines.len().saturating_sub(BOTTOM_LINES)..];
    let options: Vec<(bool, &str)> = bottom.iter().filter_map(|l| option_number(l)).collect();
    let menu = options.len() >= 2 && options.iter().any(|(cursor, _)| *cursor);
    let asked = bottom
        .iter()
        .position(|l| QUESTIONS.iter().any(|q| l.contains(q)))
        .is_some_and(|at| bottom[at + 1..].iter().any(|l| l.contains("Yes")));
    let yes_no = bottom.iter().any(|l| {
        let l = l.trim_end();
        ["(y/n)", "(Y/n)", "(y/N)", "[y/N]", "[Y/n]"]
            .iter()
            .any(|m| l.ends_with(m) || l.ends_with(&format!("{m}:")))
    });
    menu || asked || yes_no
}

/// The panes whose `needs-input` a dialog on screen backs: the ones the
/// screen may take it off again once the dialog is gone.
#[derive(Default)]
pub struct Corrector {
    dialogs: HashSet<String>,
}

impl Corrector {
    /// `None` leaves the state as it is.
    fn correct(&mut self, row: &PaneRow, dialog: bool) -> Option<&'static str> {
        if row.asking {
            self.dialogs.remove(&row.pane_id);
            return None;
        }
        use crate::PaneStateName::{Idle, NeedsInput, Working};
        match (crate::PaneStateName::parse(&row.state), dialog) {
            (Some(Working | Idle), true) => {
                self.dialogs.insert(row.pane_id.clone());
                Some(NeedsInput.as_str())
            }
            (Some(NeedsInput), true) => {
                self.dialogs.insert(row.pane_id.clone());
                None
            }
            (Some(NeedsInput), false) => self
                .dialogs
                .remove(&row.pane_id)
                .then_some(Working.as_str()),
            _ => {
                self.dialogs.remove(&row.pane_id);
                None
            }
        }
    }

    fn retain(&mut self, rows: &[PaneRow]) {
        self.dialogs
            .retain(|pane| rows.iter().any(|row| &row.pane_id == pane));
    }
}

fn tmux_output(args: &[&str]) -> Option<String> {
    let output = crate::session::tmux_command().args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

impl Corrector {
    /// Only an agent pane a hook has marked (a non-empty state) is read.
    pub(super) fn pass(&mut self, rows: &[PaneRow]) {
        self.retain(rows);
        for row in rows
            .iter()
            .filter(|row| !row.state.is_empty() && is_agent(&row.command))
        {
            let Some(screen) = tmux_output(&["capture-pane", "-p", "-t", &row.pane_id]) else {
                continue;
            };
            let Some(state) = self.correct(row, shows_dialog(&screen)) else {
                continue;
            };
            tracing::debug!(target: "tmuxy_core::agents", pane = %row.pane_id, state, "the screen corrects the pane state");
            let tmux: Vec<String> = crate::session::tmux_argv(false)
                .iter()
                .map(|w| run_shell_word(w))
                .collect();
            let line = format!(
                "{} set-option -p -t {} {} {}",
                tmux.join(" "),
                run_shell_word(&row.pane_id),
                tmux_options::PANE_STATE,
                state
            );
            if tmux_output(&["run-shell", "-b", &line]).is_none() {
                tracing::debug!(target: "tmuxy_core::agents", pane = %row.pane_id, "the corrected state was not written");
            }
        }
    }
}

#[cfg(test)]
#[path = "agent_screen_tests.rs"]
mod tests;
