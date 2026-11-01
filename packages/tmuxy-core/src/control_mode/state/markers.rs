//! The marker lines an aggregator brackets its own reads with, and the
//! control-mode lines a command is written as.

use crate::PaneId;

/// Marker printed (via `display-message -p`) immediately BEFORE a self-issued
/// capture-pane command, carrying the target pane id. Routing captures by
/// marker instead of arrival order or output shape is what makes attribution
/// exact: any other command's response (a send-keys ack has EMPTY output,
/// indistinguishable from capturing a blank pane) can otherwise steal a
/// pending capture and shunt one pane's content into another.
pub const CAPTURE_BEGIN_MARKER: &str = "TMUXY_CAP_BEGIN";
/// Marker printed immediately AFTER a self-issued capture-pane command.
pub const CAPTURE_END_MARKER: &str = "TMUXY_CAP_END";

/// Brackets for a command whose output is wanted back — see
/// [`Markers::reply_wrapped_lines`].
pub const REPLY_BEGIN_MARKER: &str = "TMUXY_RPY_BEGIN";
pub const REPLY_END_MARKER: &str = "TMUXY_RPY_END";

/// Brackets for the `show-buffer` that mirrors a copy-mode yank.
pub const BUFFER_BEGIN_MARKER: &str = "TMUXY_BUF_BEGIN";
pub const BUFFER_END_MARKER: &str = "TMUXY_BUF_END";

/// The marker lines one aggregator asks tmux to print, and recognises.
///
/// A marker block and a `capture-pane` block arrive on the same connection,
/// and what a capture prints is whatever the pane shows — so a marker that
/// is only a fixed word can be printed by any program (`cat` of a file is
/// enough). Read as tmuxy's own, a pane showing `TMUXY_CAP_END` closed its
/// own capture early and left it pending forever, and every client that
/// connected afterwards waited for a first state that never came. Every
/// marker therefore carries a token drawn from the OS random source when the
/// aggregator is made. It travels only on the control-mode connection: a
/// `display-message -p` prints to the client that ran it, never into a
/// pane's output. (tmux's message log keeps the commands a client ran, but
/// only a program with the tmux socket reads it, and that program can run any
/// tmux command it likes.) A13 in `docs/INVARIANTS.md`.
#[derive(Debug, Clone)]
pub struct Markers {
    token: String,
}

impl Markers {
    /// A fresh token: 128 bits from two `RandomState`s, which std seeds from
    /// the OS random source. Hex, so neither `display-message`'s format and
    /// strftime expansion nor tmux's command parser reads anything into it.
    pub(super) fn fresh() -> Self {
        use std::hash::BuildHasher;
        let half = || std::collections::hash_map::RandomState::new().hash_one("tmuxy-marker");
        Self {
            token: format!("{:016x}{:016x}", half(), half()),
        }
    }

    /// The text a marker line starts with: the marker's name and the token.
    pub fn tag(&self, marker: &str) -> String {
        format!("{marker} {}", self.token)
    }

    /// What follows `marker`'s tag in `line`, when `line` is that marker
    /// with this aggregator's token — and `None` for anything else, however
    /// closely it imitates one.
    pub(super) fn after<'a>(&self, line: &'a str, marker: &str) -> Option<&'a str> {
        let rest = line
            .strip_prefix(marker)?
            .strip_prefix(' ')?
            .strip_prefix(self.token.as_str())?;
        (rest.is_empty() || rest.starts_with(' ')).then(|| rest.trim())
    }

    /// Whether `line` is exactly `marker`, with no argument.
    pub(super) fn is(&self, line: &str, marker: &str) -> bool {
        self.after(line, marker) == Some("")
    }

    /// The numeric argument of a marker line of ours.
    pub(super) fn argument<T: std::str::FromStr>(&self, line: &str, marker: &str) -> Option<T> {
        self.after(line, marker)?.parse().ok()
    }

    /// The command that prints `marker`, followed by `argument` when there
    /// is one.
    fn print(&self, marker: &str, argument: Option<String>) -> String {
        let tag = self.tag(marker);
        match argument {
            Some(argument) => format!("display-message -p '{tag} {argument}'"),
            None => format!("display-message -p '{tag}'"),
        }
    }

    /// The control-mode lines that run `command` and get its output back.
    ///
    /// Control mode answers every line with a `%begin … %end|%error` block,
    /// so output can be attributed to the command that produced it by
    /// bracketing it with two marker lines whose blocks are unmistakable.
    /// The runtime writes the lines in one flush and resolves the reply when
    /// the END marker's block arrives (`SideEffect::CommandReply`).
    ///
    /// Separate LINES, not one `;` list: tmux stops a command list at its
    /// first error, so an END marker sharing the command's line would never
    /// run after a failure and the reply would hang. Separate lines are
    /// separate queue entries, each executed in send order whatever happened
    /// to the previous one — a `%error` block for the command is simply
    /// followed by the END marker's block. `command` may itself be a `;`
    /// list, or several lines (typed text is one `send-keys` per line): each
    /// of its lines goes as a line of its own, and a blank one not at all,
    /// since an empty line detaches a control-mode client.
    pub fn reply_wrapped_lines(&self, id: u64, command: &str) -> Vec<String> {
        let mut lines = vec![self.print(REPLY_BEGIN_MARKER, Some(id.to_string()))];
        lines.extend(control_mode_lines(command).map(str::to_string));
        lines.push(self.print(REPLY_END_MARKER, Some(id.to_string())));
        lines
    }

    /// Build the marker-bracketed capture-pane command for a pane's visible
    /// viewport. Each segment of a control-mode command list gets its own
    /// %begin/%end block, so the three responses arrive consecutively:
    /// BEGIN(pane) -> capture content -> END.
    ///
    /// The pane id is embedded WITHOUT its `%`: `display-message` runs the
    /// message through strftime-style expansion, and `%<digits>` is mangled
    /// (observed on tmux 3.7: `%69` prints as 67 spaces + `%69`; other
    /// versions can swallow it entirely). Bare digits are expansion-proof;
    /// the response router re-prefixes the `%`.
    pub fn capture_command(&self, pane_id: &PaneId) -> String {
        self.marker_wrapped_capture(pane_id, "")
    }

    /// `capture_command` for an explicit scrollback range (copy-mode sync).
    pub fn capture_command_range(&self, pane_id: &PaneId, start: i64, end: i64) -> String {
        self.marker_wrapped_capture(pane_id, &format!(" -S {start} -E {end}"))
    }

    /// The batch that refreshes `queued` panes: `list-panes` BEFORE every
    /// `capture-pane` (M3 in `docs/INVARIANTS.md`), so the cursor positions the
    /// captures are placed against are the ones tmux reports now.
    pub fn pane_refresh_commands(&self, queued: &[PaneId]) -> Vec<String> {
        let mut commands = vec![
            crate::constants::tmux_formats::LIST_PANES_CMD.to_string(),
            crate::constants::tmux_formats::LIST_STASH_PANES_CMD.to_string(),
        ];
        commands.extend(queued.iter().map(|pane| self.capture_command(pane)));
        commands
    }

    /// The marker-wrapped `show-buffer` that reads a yanked buffer back.
    pub(super) fn buffer_read_command(&self, buffer_name: &str) -> String {
        format!(
            "{} ; show-buffer -b {} ; {}",
            self.print(BUFFER_BEGIN_MARKER, None),
            crate::tmux_quote(buffer_name),
            self.print(BUFFER_END_MARKER, None),
        )
    }

    /// Shared marker-bracket format for both capture commands, so the BEGIN/END
    /// bracketing can't drift between the plain and ranged variants.
    fn marker_wrapped_capture(&self, pane_id: &PaneId, range: &str) -> String {
        format!(
            "{} ; capture-pane -t {pane_id} -p -e{range} ; {}",
            self.print(CAPTURE_BEGIN_MARKER, Some(pane_id.number().to_string())),
            self.print(CAPTURE_END_MARKER, None),
        )
    }
}

/// The control-mode lines a command is written as: one per line of it, a
/// blank one left out. Control mode reads a command per line, and an empty
/// line detaches the client — the monitor's own connection.
pub fn control_mode_lines(command: &str) -> impl Iterator<Item = &str> {
    command.split('\n').filter(|line| !line.trim().is_empty())
}
