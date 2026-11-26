//! A control-mode block that stays open, said in the log: when replies time
//! out on a connection that never closed, its warning, or the lack of one,
//! tells which way the stream went.

use std::time::{Duration, Instant};

/// How long a block may stay open, lines arriving all the while, before the
/// PTY reader says so. A block that never closes takes in every line after
/// it as its body: the connection stays up and no reply is read again.
const LONG_OPEN_BLOCK: Duration = Duration::from_secs(10);

/// The block the parser is in, timed from its `%begin`, so one that never
/// closes is said once, with the lines it has taken in since. Said or not
/// tells a stream that kept arriving into an open block from one that went
/// quiet, when replies time out.
#[derive(Default)]
pub(super) struct OpenBlockWatch {
    open: Option<(Instant, u64)>,
    said: bool,
}

impl OpenBlockWatch {
    /// After each line, with the parser's open block (its guard's field
    /// count, `Parser::open_guard_fields`). Whether it warned now.
    pub(super) fn after_line(&mut self, guard_fields: Option<usize>, now: Instant) -> bool {
        let Some(guard_fields) = guard_fields else {
            *self = Self::default();
            return false;
        };
        let (since, lines) = self.open.get_or_insert((now, 0));
        *lines += 1;
        let open_for = now.saturating_duration_since(*since);
        if self.said || open_for < LONG_OPEN_BLOCK {
            return false;
        }
        self.said = true;
        tracing::warn!(
            open_secs = open_for.as_secs(),
            lines = *lines,
            guard_fields,
            "parser task: a control-mode block is still open, so no reply after it is read (a guard tmux wrote has 3 fields)"
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{OpenBlockWatch, LONG_OPEN_BLOCK};
    use std::time::{Duration, Instant};

    /// A block open past the limit while lines keep coming is said once; a
    /// block that closes starts the count again.
    #[test]
    fn a_block_that_stays_open_is_said_once() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let mut watch = OpenBlockWatch::default();
        assert!(!watch.after_line(Some(3), at(0)));
        assert!(!watch.after_line(Some(3), at(1)));
        assert!(watch.after_line(Some(3), at(0) + LONG_OPEN_BLOCK));
        assert!(!watch.after_line(Some(3), at(30)));
        assert!(!watch.after_line(None, at(31)));
        assert!(!watch.after_line(Some(5), at(32)));
        assert!(!watch.after_line(Some(5), at(33)));
        assert!(watch.after_line(Some(5), at(32) + LONG_OPEN_BLOCK));
    }

    #[test]
    fn blocks_that_close_are_never_said() {
        let start = Instant::now();
        let mut watch = OpenBlockWatch::default();
        for second in 0..60 {
            let now = start + Duration::from_secs(second);
            assert!(!watch.after_line(Some(3), now));
            assert!(!watch.after_line(None, now));
        }
    }
}
