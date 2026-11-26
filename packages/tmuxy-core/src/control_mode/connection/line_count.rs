//! What the PTY reader has read from tmux, every line counted whether or not
//! it made an event, for a timed-out reply's warning (`LinkReads`).

use crate::control_mode::monitor_core::LinkReads;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Shared by the PTY reader, which counts, and the connection, which reads.
#[derive(Debug)]
pub(super) struct LineCount {
    started: Instant,
    lines: AtomicU64,
    /// When the last line came: milliseconds after `started`, plus one, so
    /// zero means none yet.
    last: AtomicU64,
}

impl LineCount {
    pub(super) fn new(started: Instant) -> Self {
        Self {
            started,
            lines: AtomicU64::new(0),
            last: AtomicU64::new(0),
        }
    }

    /// A line was read, at `now`.
    pub(super) fn line(&self, now: Instant) {
        let after = now.saturating_duration_since(self.started).as_millis();
        let after = u64::try_from(after).unwrap_or(u64::MAX - 1);
        self.last.store(after + 1, Ordering::Relaxed);
        self.lines.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn reads(&self) -> LinkReads {
        let last = self.last.load(Ordering::Relaxed);
        LinkReads {
            lines: self.lines.load(Ordering::Relaxed),
            last_at: (last > 0).then(|| self.started + Duration::from_millis(last - 1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LineCount;
    use std::time::{Duration, Instant};

    #[test]
    fn every_line_is_counted_and_the_last_ones_time_kept() {
        let start = Instant::now();
        let count = LineCount::new(start);
        assert_eq!(count.reads().lines, 0);
        assert_eq!(count.reads().last_at, None);
        count.line(start + Duration::from_millis(5));
        count.line(start + Duration::from_millis(1200));
        let reads = count.reads();
        assert_eq!(reads.lines, 2);
        assert_eq!(reads.last_at, Some(start + Duration::from_millis(1200)));
    }
}
