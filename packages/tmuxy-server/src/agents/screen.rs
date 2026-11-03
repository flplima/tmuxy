//! The screen's word on an agent's pane, for the moments its hooks say
//! nothing: Antigravity has no hook for a permission prompt at all, and
//! Claude Code and Codex fire none when the user answers one — the next
//! hook is the tool finishing, which for a long command is minutes later.
//!
//! So the server reads the bottom of every agent pane its hooks have marked,
//! a couple of times a second, and corrects the state on one sign only: an
//! approval dialog. One on screen is `needs-input`; one the server saw go
//! away again is `working`, the user having answered it. Nothing else on a
//! screen is trusted — a quiet screen proves nothing, and the hooks own
//! every other change. It is what the tmux tools for agents settled on
//! (agent-deck, tmux-agent-deck, bosun): hooks for the turn, the screen for
//! the dialogs.
//!
//! Reads are read-only tmux subprocesses (`list-panes`, `capture-pane`),
//! which tmux runs safely beside an attached control-mode client; the one
//! write goes through `run-shell`, as the CLI's do (docs/TMUX.md).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tmuxy_core::constants::tmux_options;
use tmuxy_core::plugins::job::shell_word;
use tracing::debug;

use crate::state::AppState;

const INTERVAL: Duration = Duration::from_millis(1500);

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

/// One `list-panes -a` row, tab-separated.
const PANES_FORMAT: &str =
    "#{pane_id}\t#{pane_current_command}\t#{@tmuxy-pane-state}\t#{@tmuxy-ask}";

#[derive(Debug, Clone, PartialEq)]
struct Row {
    pane_id: String,
    command: String,
    state: String,
    /// A send's question is up on the pane: the state is the question's.
    asking: bool,
}

fn parse_rows(listing: &str) -> Vec<Row> {
    listing
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(4, '\t').collect();
            let [pane_id, command, state, ask] = f[..] else {
                return None;
            };
            Some(Row {
                pane_id: pane_id.to_string(),
                command: command.to_string(),
                state: state.to_string(),
                asking: !ask.is_empty(),
            })
        })
        .collect()
}

/// Whether the pane runs one of the agents tmuxy installs hooks for. Claude
/// Code runs as `…/claude/versions/<version>`, so a bare version is Claude.
fn is_agent(command: &str) -> bool {
    matches!(command, "claude" | "codex" | "agy" | "antigravity")
        || crate::push::is_version(command)
}

/// Whether an option's line: the cursor or a number, then `N.`.
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
pub(crate) fn shows_dialog(screen: &str) -> bool {
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
pub(crate) struct Corrector {
    dialogs: HashSet<String>,
}

impl Corrector {
    /// The state `row` should have now, given whether its screen shows a
    /// dialog; `None` to leave it.
    fn correct(&mut self, row: &Row, dialog: bool) -> Option<&'static str> {
        if row.asking {
            self.dialogs.remove(&row.pane_id);
            return None;
        }
        match (row.state.as_str(), dialog) {
            ("working" | "idle", true) => {
                self.dialogs.insert(row.pane_id.clone());
                Some("needs-input")
            }
            ("needs-input", true) => {
                self.dialogs.insert(row.pane_id.clone());
                None
            }
            ("needs-input", false) => self.dialogs.remove(&row.pane_id).then_some("working"),
            _ => {
                self.dialogs.remove(&row.pane_id);
                None
            }
        }
    }

    /// Forget panes that are gone.
    fn retain(&mut self, rows: &[Row]) {
        self.dialogs
            .retain(|pane| rows.iter().any(|row| &row.pane_id == pane));
    }
}

fn tmux_output(args: &[&str]) -> Option<String> {
    let output = tmuxy_core::session::tmux_command()
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The agent panes a hook has marked, read and corrected once.
fn pass(corrector: &mut Corrector) {
    let Some(listing) = tmux_output(&["list-panes", "-a", "-F", PANES_FORMAT]) else {
        return;
    };
    let rows = parse_rows(&listing);
    corrector.retain(&rows);
    for row in rows
        .iter()
        .filter(|row| !row.state.is_empty() && is_agent(&row.command))
    {
        let Some(screen) = tmux_output(&["capture-pane", "-p", "-t", &row.pane_id]) else {
            continue;
        };
        let Some(state) = corrector.correct(row, shows_dialog(&screen)) else {
            continue;
        };
        debug!(target: "tmuxy_server::agents", pane = %row.pane_id, state, "the screen corrects the pane state");
        let tmux: Vec<String> = tmuxy_core::session::tmux_argv(false)
            .iter()
            .map(|w| shell_word(w))
            .collect();
        let line = format!(
            "{} set-option -p -t {} {} {}",
            tmux.join(" "),
            shell_word(&row.pane_id),
            tmux_options::PANE_STATE,
            state
        );
        let _ = tmux_output(&["run-shell", "-b", &line]);
    }
}

/// Correct agent panes from their screens until the server stops.
pub async fn watch(state: Arc<AppState>) {
    let shutdown = state.shutdown.clone();
    state
        .spawn(async move {
            let mut corrector = Corrector::default();
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(INTERVAL) => {}
                    _ = shutdown.cancelled() => return,
                }
                // A pass that panicked starts the next from nothing seen.
                corrector = tokio::task::spawn_blocking(move || {
                    pass(&mut corrector);
                    corrector
                })
                .await
                .unwrap_or_default();
            }
        })
        .await;
}

#[cfg(test)]
#[path = "screen_tests.rs"]
mod tests;
