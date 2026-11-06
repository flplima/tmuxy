//! The core's reads — the re-lists and captures that refresh its picture of
//! tmux — paced to what the host's link can carry.
//!
//! On a local socket a read costs microseconds and goes out the moment it is
//! asked for. In a guest machine every byte of a read crosses an emulated
//! UART and is handled by an emulated CPU: a `list-panes` with the pane
//! format costs about as much as tmux's whole answer to it. Five tabs opened
//! at once asked for a window re-list each, a pane refresh each, and a pane
//! refresh per title notification after, and the keystrokes typed next
//! waited seconds behind reads that all said the same thing.
//!
//! Paced, one batch of reads is on the wire at a time. What is asked for
//! while it is out is merged — each list once, each capture once — and sent
//! when tmux has answered it, so every read asked for still goes out after
//! the request, and the copy-mode poll never queues faster than tmux answers.

use super::*;
use crate::constants::tmux_formats::TmuxList;
use crate::control_mode::state::Markers;

/// How the core sends its reads to a host's link.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ReadPacing {
    /// Each as soon as it is asked for: a local socket.
    #[default]
    Immediate,
    /// One batch on the wire at a time, what is asked for meanwhile merged
    /// into the next: a link where every byte costs the far side CPU time.
    OneBatchInFlight,
}

/// The reads asked for and not yet sent, and whether a batch is out.
#[derive(Debug, Default)]
pub(super) struct ReadGate {
    in_flight: bool,
    windows: bool,
    panes: bool,
    /// Captures, each once, in the order asked for.
    captures: Vec<String>,
}

impl ReadGate {
    /// Merge `commands` — a re-list, a pane refresh, the copy-mode poll —
    /// into what the next batch reads.
    pub(super) fn want(&mut self, markers: &Markers, commands: Vec<String>) {
        for command in commands {
            if command == markers.list_command(TmuxList::Windows) {
                self.windows = true;
            } else if command == markers.list_command(TmuxList::Panes)
                || command == markers.list_command(TmuxList::Stash)
            {
                self.panes = true;
            } else if !self.captures.contains(&command) {
                self.captures.push(command);
            }
        }
    }

    /// The next batch, when none is out and something is wanted: the lists
    /// in M2's order, then the captures (M3).
    pub(super) fn take(&mut self, markers: &Markers) -> Option<Vec<String>> {
        let wanted = self.windows || self.panes || !self.captures.is_empty();
        if self.in_flight || !wanted {
            return None;
        }
        let mut lines = if self.windows {
            markers.window_relist_commands().to_vec()
        } else if self.panes {
            markers.pane_refresh_commands(&[])
        } else {
            Vec::new()
        };
        lines.append(&mut self.captures);
        self.windows = false;
        self.panes = false;
        self.in_flight = true;
        Some(lines)
    }

    /// The batch out has been answered, or given up on.
    pub(super) fn answered(&mut self) {
        self.in_flight = false;
    }
}

impl<W> MonitorCore<W> {
    /// Host a link with `pacing` (`ReadPacing::Immediate` unless set).
    pub fn with_read_pacing(mut self, pacing: ReadPacing) -> Self {
        self.read_pacing = pacing;
        self
    }

    /// A read the core wants sent: into `actions` now, or into the gate.
    pub(super) fn read(&mut self, commands: Vec<String>, actions: &mut Vec<Action<W>>) {
        match self.read_pacing {
            ReadPacing::Immediate => actions.push(Action::Send(commands)),
            ReadPacing::OneBatchInFlight => {
                self.reads.want(self.aggregator.markers(), commands);
            }
        }
    }

    /// The re-lists a client's command needs, as the lines that go right
    /// behind it: all of them, or on a paced link the gate's next batch.
    pub(super) fn relists_behind(&mut self, relists: Vec<String>, now: Instant) -> Vec<String> {
        match self.read_pacing {
            ReadPacing::Immediate => relists,
            ReadPacing::OneBatchInFlight => {
                self.reads.want(self.aggregator.markers(), relists);
                self.next_batch(now).unwrap_or_default()
            }
        }
    }

    /// The gate's next batch, when it has one to send.
    pub(super) fn flush_reads(&mut self, now: Instant) -> Option<Action<W>> {
        self.next_batch(now).map(Action::Send)
    }

    /// The reads, then an empty reply-wrapped command whose answer says tmux
    /// has answered them.
    fn next_batch(&mut self, now: Instant) -> Option<Vec<String>> {
        let mut lines = self.reads.take(self.aggregator.markers())?;
        let id = self.fresh_reply_id();
        lines.extend(self.aggregator.markers().reply_wrapped_lines(id, ""));
        self.replies.insert(id, (Waiter::Reads, now));
        Some(lines)
    }
}
