//! What a shell command leaves on its pane when it ends (OSC 133 `C` … `D`).
//!
//! A command that ran for a while is one the user may have stopped watching,
//! so its end is said the way a program says its own with OSC 7501: a `done`
//! record of the pane's, which the pane shows as unread, with how it ended
//! as the message. The pane's mark, its tooltip and the push notice then
//! follow from the record like any other. A short command ends without a
//! word.
//!
//! A status that is not zero is said in the message and is still `done`,
//! never `error`. Most long commands that end that way were stopped by the
//! person watching them (Ctrl-C on a server is 130, a closed ssh 255), and
//! an unread result has the manners that fits: the client that shows the
//! pane takes it off at once, and it is pushed only after it has waited.
//!
//! This file is the whole of that choice: the tracker only hands it the two
//! marks and applies what it answers.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use super::program_status::{Record, Report, State};

/// How long a command runs before its end is worth a mark.
pub(crate) const LONG_COMMAND: Duration = Duration::from_secs(10);

/// The id the shell's record is kept under, beside those of the programs
/// that report for themselves.
pub(crate) const RECORD_ID: &str = "tmuxy.command";

/// A command started: what the last one left is no longer news.
pub(crate) fn began() -> Report {
    Report::Clear {
        id: RECORD_ID.to_string(),
    }
}

/// A command that ran for `ran` ended with `exit`, the status the shell gave.
pub(crate) fn ended(exit: Option<i32>, ran: Duration) -> Option<Report> {
    if ran < LONG_COMMAND {
        return None;
    }
    let took = spoken(ran);
    let msg = match exit {
        Some(status) if status != 0 => format!("Exit {status} after {took}"),
        _ => format!("Finished in {took}"),
    };
    Some(Report::Set {
        id: RECORD_ID.to_string(),
        record: Record {
            state: State::Done,
            kind: None,
            progress: None,
            app: None,
            title: None,
            msg: Some(STANDARD.encode(msg)),
        },
    })
}

/// `15 s`, `2 min 5 s`, `1 h 3 min`: the two largest units that are not zero.
fn spoken(ran: Duration) -> String {
    let secs = ran.as_secs();
    let (hours, minutes, seconds) = (secs / 3600, secs % 3600 / 60, secs % 60);
    let parts = [(hours, "h"), (minutes, "min"), (seconds, "s")];
    let spoken: Vec<String> = parts
        .iter()
        .skip_while(|(amount, _)| *amount == 0)
        .take(2)
        .filter(|(amount, _)| *amount != 0)
        .map(|(amount, unit)| format!("{amount} {unit}"))
        .collect();
    spoken.join(" ")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn message(report: &Report) -> String {
        let Report::Set { record, .. } = report else {
            panic!("a record is set: {report:?}");
        };
        let bytes = crate::control_mode::images::base64_decode(record.msg.as_deref().unwrap());
        String::from_utf8(bytes.unwrap()).unwrap()
    }

    #[test]
    fn a_short_command_ends_without_a_word() {
        assert_eq!(ended(Some(1), Duration::from_secs(9)), None);
        assert_eq!(ended(Some(0), Duration::from_millis(9_999)), None);
    }

    #[test]
    fn a_long_command_that_succeeded_is_a_result_to_be_seen() {
        let report = ended(Some(0), Duration::from_secs(15)).unwrap();
        assert!(
            matches!(&report, Report::Set { id, record } if id == RECORD_ID && record.state == State::Done)
        );
        assert_eq!(message(&report), "Finished in 15 s");
    }

    /// Ctrl-C on a server that ran for two minutes is not a failure to be
    /// told about: it is a result like any other, with its status said.
    #[test]
    fn a_long_command_that_did_not_exit_zero_is_still_a_result_naming_its_status() {
        for status in [1, 130, 255] {
            let report = ended(Some(status), Duration::from_secs(125)).unwrap();
            assert!(matches!(&report, Report::Set { record, .. } if record.state == State::Done));
            assert_eq!(message(&report), format!("Exit {status} after 2 min 5 s"));
        }
    }

    #[test]
    fn a_shell_that_gives_no_exit_status_is_taken_as_done() {
        let report = ended(None, Duration::from_secs(3_780)).unwrap();
        assert_eq!(message(&report), "Finished in 1 h 3 min");
    }

    #[test]
    fn a_new_command_takes_the_last_ones_mark_away() {
        assert_eq!(
            began(),
            Report::Clear {
                id: RECORD_ID.to_string()
            }
        );
    }

    #[test]
    fn a_duration_is_said_in_its_two_largest_units() {
        assert_eq!(spoken(Duration::from_secs(10)), "10 s");
        assert_eq!(spoken(Duration::from_secs(60)), "1 min");
        assert_eq!(spoken(Duration::from_secs(3_600)), "1 h");
        assert_eq!(spoken(Duration::from_secs(3_605)), "1 h");
        assert_eq!(spoken(Duration::from_secs(86_400 + 61)), "24 h 1 min");
    }
}
