//! A command's `%begin` … `%end`/`%error` block: where one opens, and the
//! one line that closes it.

use super::{ControlModeEvent, Parser};

impl Parser {
    pub(super) fn handle_begin(&mut self, line: &str) -> Option<ControlModeEvent> {
        // Format: %begin timestamp command-number flags
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            self.in_response = true;
            self.response_timestamp = parts[1].parse().unwrap_or(0);
            self.response_command_num = parts[2].parse().unwrap_or(0);
            self.response_guard = parts[1..].join(" ");
            self.response_buffer.clear();
            self.response_has_lines = false;
            self.response_overflowed = false;
        }
        None
    }

    /// `Some(success)` when `line` is the `%end` (`true`) or `%error`
    /// (`false`) that closes the open block: tmux writes the same time,
    /// command number and flags on both guards of a block.
    pub(super) fn closing_guard(&self, line: &str) -> Option<bool> {
        use crate::constants::control_events as ev;
        let (rest, success) = match line.strip_prefix(ev::END) {
            Some(rest) => (rest, true),
            None => (line.strip_prefix(ev::ERROR)?, false),
        };
        let guard = rest.split_whitespace().collect::<Vec<_>>().join(" ");
        (guard == self.response_guard).then_some(success)
    }

    pub(super) fn handle_end(&mut self, success: bool) -> Option<ControlModeEvent> {
        let event = if self.response_overflowed {
            ControlModeEvent::CommandResponse {
                timestamp: self.response_timestamp,
                command_num: self.response_command_num,
                output: format!("reply larger than {} bytes", self.max_response_bytes),
                success: false,
            }
        } else {
            ControlModeEvent::CommandResponse {
                timestamp: self.response_timestamp,
                command_num: self.response_command_num,
                output: std::mem::take(&mut self.response_buffer),
                success,
            }
        };
        self.in_response = false;
        Some(event)
    }
}
