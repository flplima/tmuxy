//! The core's reads — the re-lists and captures that refresh its picture of
//! tmux — paced to what the host's link can carry.
//!
//! On a local socket a read costs microseconds and goes out the moment it is
//! asked for. In a guest machine every byte of a read crosses an emulated
//! UART and is handled by an emulated CPU: a `list-panes` with the pane
//! format costs about as much as tmux's whole answer to it. Unpaced, five
//! tabs opened at once left the keystrokes typed next waiting seconds behind
//! reads that all said the same thing.
//!
//! Paced, one batch of reads is on the wire at a time. What is asked for
//! while it is out is merged — each list once, each capture once — and sent
//! when tmux has answered it, so every read asked for still goes out after
//! the request, and the copy-mode poll never queues faster than tmux answers.
//! The attach's lists are the first batch. A host's re-sync is the one batch
//! that goes even with another out, since the host waits on a round trip
//! behind it; what is asked for meanwhile waits for both.

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

#[derive(Debug, Default)]
pub(super) struct ReadGate {
    /// Batches on the wire: one, or two while a re-sync is out beside one.
    in_flight: usize,
    windows: bool,
    panes: bool,
    captures: Vec<String>,
}

impl ReadGate {
    pub(super) fn want(&mut self, markers: &Markers, commands: Vec<String>) {
        let windows = markers.list_command(TmuxList::Windows);
        let panes = markers.list_command(TmuxList::Panes);
        let stash = markers.list_command(TmuxList::Stash);
        for command in commands {
            if command == windows {
                self.windows = true;
            } else if command == panes || command == stash {
                self.panes = true;
            } else if !self.captures.contains(&command) {
                self.captures.push(command);
            }
        }
    }

    /// The lists in M2's order, then the captures (M3); `even_beside_one`
    /// takes them with a batch out.
    pub(super) fn take(&mut self, markers: &Markers, even_beside_one: bool) -> Option<Vec<String>> {
        let wanted = self.windows || self.panes || !self.captures.is_empty();
        if (self.in_flight > 0 && !even_beside_one) || !wanted {
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
        self.in_flight += 1;
        Some(lines)
    }

    pub(super) fn answered(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}

impl<W> MonitorCore<W> {
    pub fn with_read_pacing(mut self, pacing: ReadPacing) -> Self {
        self.read_pacing = pacing;
        self
    }

    pub(super) fn read(&mut self, commands: Vec<String>, actions: &mut Vec<Action<W>>) {
        match self.read_pacing {
            ReadPacing::Immediate => {
                self.count_lists(&commands);
                actions.push(Action::Send(commands));
            }
            ReadPacing::OneBatchInFlight => {
                self.reads.want(self.aggregator.markers(), commands);
            }
        }
    }

    /// Reads that go out with what the host sends now (a command's re-lists,
    /// the attach's): as they are, or on a paced link as the next batch when
    /// none is out, merged into it otherwise.
    pub(super) fn reads_out(&mut self, reads: Vec<String>, now: Instant) -> Vec<String> {
        match self.read_pacing {
            ReadPacing::Immediate => {
                self.count_lists(&reads);
                reads
            }
            ReadPacing::OneBatchInFlight => {
                self.reads.want(self.aggregator.markers(), reads);
                self.next_batch(now).unwrap_or_default()
            }
        }
    }

    /// The full re-list a host asks for when it is about to wait on a round
    /// trip behind it (a page's first frame, a resume, a session switch), to
    /// send now. On a paced link it is a batch of its own, with the reads
    /// that were waiting, even beside a batch already out: the host's wait
    /// has to see it answered.
    pub fn resync(&mut self, now: Instant) -> Vec<String> {
        let relist = self.aggregator.markers().window_relist_commands().to_vec();
        match self.read_pacing {
            ReadPacing::Immediate => {
                self.count_lists(&relist);
                relist
            }
            ReadPacing::OneBatchInFlight => {
                self.reads.want(self.aggregator.markers(), relist);
                self.batch(now, true).unwrap_or_default()
            }
        }
    }

    fn count_lists(&mut self, lines: &[String]) {
        let panes = self.aggregator.markers().list_command(TmuxList::Panes);
        let sent = lines.iter().filter(|line| **line == panes).count() as u64;
        self.pane_lists_sent = self.pane_lists_sent.wrapping_add(sent);
    }

    pub(super) fn flush_reads(&mut self, now: Instant) -> Option<Action<W>> {
        self.next_batch(now).map(Action::Send)
    }

    fn next_batch(&mut self, now: Instant) -> Option<Vec<String>> {
        self.batch(now, false)
    }

    /// tmux answers commands in order, so the empty reply-wrapped command
    /// after the reads is answered once they all are.
    fn batch(&mut self, now: Instant, even_beside_one: bool) -> Option<Vec<String>> {
        let mut lines = self
            .reads
            .take(self.aggregator.markers(), even_beside_one)?;
        self.count_lists(&lines);
        let id = self.fresh_reply_id();
        lines.extend(self.aggregator.markers().reply_wrapped_lines(id, ""));
        self.wait_for_reply(id, Waiter::Reads, now);
        Some(lines)
    }
}
