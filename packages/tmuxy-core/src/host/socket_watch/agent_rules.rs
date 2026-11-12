//! A state for agents that have no hooks, read off their screens: Gemini
//! CLI, Aider, Cursor's agent, Amp, and the agents whose hooks are code
//! (OpenCode, Pi, Crush). Their panes would otherwise show nothing.
//!
//! The signs, from the bottom of the screen, every pass of the socket watch:
//!
//!   * an approval dialog ([`super::agent_screen::shows_dialog`]) is
//!     `needs-input`;
//!   * a screen that changed since the last pass is `working`: the agent is
//!     printing, or its spinner is turning;
//!   * a screen that has held still for [`STILL_PASSES`] passes is `idle`.
//!
//! The rules never take over a state something else declared. What they
//! last wrote is kept beside the state (`@tmuxy-rules-state`), and they
//! change the state only while it is still theirs or unset: a hook, a
//! `tmuxy pane state`, a program's own report or a send's question wins.
//! When the agent's process ends, a state that is still theirs is taken
//! off. Every write is conditional on the state the pass read, so one
//! declared between the read and the write is not overwritten either.
//!
//! An agent run by an interpreter (`node`, `python3`) is found by the
//! script it runs ([`program`]).

pub mod program;

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use super::PaneRow;
use crate::argv::run_shell_word;
use crate::constants::tmux_options;
use crate::PaneStateName;

/// The processes read by these rules. The agents with hooks
/// ([`super::agent_screen::AGENT_COMMANDS`]) are not among them: their
/// hooks own their state.
pub const RULE_AGENTS: [&str; 7] = [
    "gemini",
    "aider",
    "cursor-agent",
    "amp",
    "opencode",
    "pi",
    "crush",
];

/// Passes a screen must hold still for before the agent reads as idle:
/// about four and a half seconds at the socket watch's pace. Shorter, and a
/// pause between two tool calls reads as the end of the turn.
pub const STILL_PASSES: u32 = 3;

pub fn is_rule_agent(command: &str) -> bool {
    RULE_AGENTS.contains(&command)
}

/// What one pane's screen has been doing.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Track {
    hash: u64,
    still: u32,
}

fn hash(screen: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    screen.hash(&mut hasher);
    hasher.finish()
}

/// The state the screen says, given what it was doing: `None` while it has
/// not settled into a sign yet (first sight, or still for too short a time).
pub fn judge(track: &mut Option<Track>, screen: &str) -> Option<PaneStateName> {
    let now = hash(screen);
    let dialog = super::agent_screen::shows_dialog(screen).then_some(PaneStateName::NeedsInput);
    let Some(seen) = track else {
        // First sight: nothing to compare with yet.
        *track = Some(Track {
            hash: now,
            still: 0,
        });
        return dialog;
    };
    if seen.hash == now {
        seen.still = seen.still.saturating_add(1);
    } else {
        seen.hash = now;
        seen.still = 0;
    }
    if dialog.is_some() {
        return dialog;
    }
    match seen.still {
        0 => Some(PaneStateName::Working),
        n if n >= STILL_PASSES => Some(PaneStateName::Idle),
        _ => None,
    }
}

/// What the rules do to a pane: write a state, take theirs off, or nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Set(&'static str),
    Clear,
}

/// The change, given the pane's state now (`current`), what the rules last
/// wrote (`ours`), and what the screen says (`wanted`). A state that is not
/// the rules' own is left alone; so is a pane a send is asking on.
pub fn decide(
    current: &str,
    ours: &str,
    wanted: Option<PaneStateName>,
    asking: bool,
) -> Option<Change> {
    let theirs = !current.is_empty() && current != ours;
    if theirs || asking {
        return None;
    }
    let wanted = wanted?.as_str();
    (wanted != current).then_some(Change::Set(wanted))
}

/// The panes the rules read, and what each screen has been doing.
#[derive(Default)]
pub struct Rules {
    tracks: HashMap<String, Option<Track>>,
}

fn tmux_output(args: &[&str]) -> Option<String> {
    let output = crate::session::tmux_command().args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The state the rules last wrote on `pane`; empty for none.
fn ours(pane: &str) -> String {
    tmux_output(&[
        "show-options",
        "-pqv",
        "-t",
        pane,
        tmux_options::RULES_STATE,
    ])
    .unwrap_or_default()
    .trim()
    .to_string()
}

/// The tmux command that makes `change` on `pane` while its state still
/// reads `read`, as argv words: the state and the rules' own note of it
/// together, so a reader never sees one without the other, and nothing at
/// all when a writer declared another state since the pass read it.
pub fn guarded_command(pane: &str, read: &str, change: &Change) -> Vec<String> {
    let both = |verb: &str, value: &str| {
        [tmux_options::PANE_STATE, tmux_options::RULES_STATE]
            .map(|option| format!("{verb} -t {pane} {option}{value}"))
            .join(" ; ")
    };
    let commands = match change {
        Change::Set(state) => both("set-option -p", &format!(" {state}")),
        Change::Clear => both("set-option -pu", ""),
    };
    let still = format!("#{{==:#{{{}}},{read}}}", tmux_options::PANE_STATE);
    ["if-shell", "-F", "-t", pane, &still, &commands]
        .map(String::from)
        .to_vec()
}

/// Write `change` on `pane` through `run-shell`, if its state still reads
/// `read`.
fn write(pane: &str, read: &str, change: &Change) {
    let words: Vec<String> = crate::session::tmux_argv(false)
        .into_iter()
        .chain(guarded_command(pane, read, change))
        .map(|w| run_shell_word(&w))
        .collect();
    let line = words.join(" ");
    if tmux_output(&["run-shell", "-b", &line]).is_none() {
        tracing::debug!(target: "tmuxy_core::agents", pane, "the screen's state was not written");
    }
}

impl Rules {
    /// One pass over every pane on the socket.
    pub fn pass(&mut self, rows: &[PaneRow]) {
        let mut seen = HashMap::new();
        for row in rows {
            let tracked = self.tracks.remove(&row.pane_id);
            let program = program::program(&row.pane_id, &row.command);
            if !is_rule_agent(&program) {
                // The agent is gone from this pane: a state that is still the
                // rules' own goes with it.
                if tracked.is_some() && !row.state.is_empty() && row.state == ours(&row.pane_id) {
                    write(&row.pane_id, &row.state, &Change::Clear);
                }
                continue;
            }
            let mut track = tracked.unwrap_or_default();
            let Some(screen) = tmux_output(&["capture-pane", "-p", "-t", &row.pane_id]) else {
                seen.insert(row.pane_id.clone(), track);
                continue;
            };
            let wanted = judge(&mut track, &screen);
            let mine = if row.state.is_empty() {
                String::new()
            } else {
                ours(&row.pane_id)
            };
            if let Some(change) = decide(&row.state, &mine, wanted, row.asking) {
                tracing::debug!(target: "tmuxy_core::agents", pane = %row.pane_id, ?change, "the screen sets the pane state");
                write(&row.pane_id, &row.state, &change);
            }
            seen.insert(row.pane_id.clone(), track);
        }
        self.tracks = seen;
    }
}

#[cfg(test)]
#[path = "agent_rules_tests.rs"]
mod tests;
