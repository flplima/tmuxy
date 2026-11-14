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
#[cfg(test)]
use crate::agent_dialog::BOTTOM_LINES;
pub use crate::agent_dialog::{is_agent, shows_dialog, AGENT_COMMANDS};
use crate::argv::run_shell_word;
use crate::constants::tmux_options;

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
