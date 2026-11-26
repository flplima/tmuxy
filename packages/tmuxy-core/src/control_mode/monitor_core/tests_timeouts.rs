//! What a timed-out reply's warning says the link read after its command
//! went out (`heard_since`).

use super::replies::Heard;
use super::tests::core;
use super::*;

#[test]
fn a_timed_out_reply_counts_the_lines_read_since_its_command_went_out() {
    let (mut core, now) = core("app");
    core.link_read(LinkReads {
        lines: 10,
        last_at: Some(now),
    });
    let asked = core.command("display -p hi", Some("caller"), now);
    let id = asked.reply_id().expect("a caller's command is wrapped");
    let later = now + Duration::from_secs(1);
    core.link_read(LinkReads {
        lines: 14,
        last_at: Some(later),
    });
    let (_, _, lines_at) = core.replies[&id];
    assert_eq!(lines_at, 10);
    assert_eq!(
        core.heard_since(lines_at, now + REPLY_TIMEOUT),
        Some(Heard {
            lines: 4,
            last_line_ago: Some(REPLY_TIMEOUT - Duration::from_secs(1)),
        })
    );
    assert!(core
        .tick(now + REPLY_TIMEOUT)
        .iter()
        .any(|a| matches!(a, Action::Answer("caller", reply) if reply.error.is_some())));
    assert!(core.replies.is_empty());
}

#[test]
fn a_host_that_does_not_count_says_nothing_of_lines() {
    let (mut core, now) = core("app");
    let asked = core.command("display -p hi", Some("caller"), now);
    let id = asked.reply_id().expect("a caller's command is wrapped");
    let (_, _, lines_at) = core.replies[&id];
    assert_eq!(core.heard_since(lines_at, now + REPLY_TIMEOUT), None);
}
