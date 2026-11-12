//! The guest's paced reads (`reads`, M12).

use super::tests::{core, marked, response, sent, with_a_pane, Core};
use super::*;
use crate::constants::tmux_formats::TmuxList;
use crate::control_mode::state::{
    LIST_BEGIN_MARKER, LIST_END_MARKER, REPLY_BEGIN_MARKER, REPLY_END_MARKER, VERSION_MARKER,
};

fn paced(now: Instant, copy_mode: bool) -> Core {
    let (mut core, _) = core("app");
    with_a_pane(&mut core, now);
    if copy_mode {
        for event in [
            marked(&core, LIST_BEGIN_MARKER, TmuxList::Panes.name()),
            response("%0,0,0,0,80,24,0,0,1,sleep,,1,,,,@0, ,0,0,0,,,,0,,,,,,,"),
            marked(&core, LIST_END_MARKER, ""),
        ] {
            core.step(event, now);
        }
        assert!(core.aggregator().has_pane_in_copy_mode());
    }
    core.with_read_pacing(ReadPacing::OneBatchInFlight)
}

/// The batches of reads `actions` sent, each as the id of the reply that
/// closes it and how many window re-lists it carries.
fn batches(core: &Core, actions: &[Action<&'static str>]) -> Vec<(String, usize)> {
    let end = core.aggregator().markers().tag(REPLY_END_MARKER);
    let windows = core.aggregator().markers().list_command(TmuxList::Windows);
    let mut out = Vec::new();
    let mut relists = 0;
    for line in sent(actions) {
        if line == windows {
            relists += 1;
        }
        if let Some(id) = line
            .strip_prefix(&format!("display-message -p '{end} "))
            .and_then(|rest| rest.strip_suffix('\''))
        {
            out.push((id.to_string(), relists));
            relists = 0;
        }
    }
    assert_eq!(relists, 0, "a re-list outside a batch: {actions:?}");
    out
}

fn answer(core: &mut Core, id: &str, now: Instant) -> Vec<Action<&'static str>> {
    let (begin, end) = (
        marked(core, REPLY_BEGIN_MARKER, id),
        marked(core, REPLY_END_MARKER, id),
    );
    let mut actions = core.step(begin, now);
    actions.extend(core.step(end, now));
    actions
}

#[test]
fn on_a_paced_link_reads_asked_for_while_a_batch_is_out_go_once_after_it() {
    let start = Instant::now();
    let mut core = paced(start, false);
    let mut burst = Vec::new();
    for n in 1..=5 {
        burst.extend(core.step(
            ControlModeEvent::WindowAdd {
                window_id: WindowId::from_number(n),
            },
            start,
        ));
    }
    let first = batches(&core, &burst);
    assert_eq!(first.len(), 1, "{burst:?}");
    assert_eq!(first[0].1, 1);
    let meanwhile = core.tick(start + Duration::from_millis(200));
    assert!(batches(&core, &meanwhile).is_empty());

    let after = answer(&mut core, &first[0].0, start + Duration::from_millis(300));
    let second = batches(&core, &after);
    assert_eq!(second.len(), 1, "{after:?}");
    assert_eq!(second[0].1, 1);

    let quiet = answer(&mut core, &second[0].0, start + Duration::from_millis(400));
    assert!(sent(&quiet).is_empty(), "{quiet:?}");
}

/// A guest's tmux cannot answer a poll every 50 ms.
#[test]
fn on_a_paced_link_the_copy_mode_poll_waits_for_its_answer() {
    let start = Instant::now();
    let mut core = paced(start, true);
    let mut out = Vec::new();
    for tick in 0..20u64 {
        out.extend(core.tick(start + FIRST_SYNC_DELAY + COPY_MODE_SYNC_INTERVAL * tick as u32));
    }
    let polls = batches(&core, &out);
    assert_eq!(polls.len(), 1, "{out:?}");

    let later = start + FIRST_SYNC_DELAY + COPY_MODE_SYNC_INTERVAL * 20;
    let answered = answer(&mut core, &polls[0].0, later);
    assert_eq!(batches(&core, &answered).len(), 1, "{answered:?}");
}

#[test]
fn on_a_paced_link_an_unanswered_batch_is_given_up_at_the_reply_timeout() {
    let start = Instant::now();
    let mut core = paced(start, false);
    let add = |n| ControlModeEvent::WindowAdd {
        window_id: WindowId::from_number(n),
    };
    let first = core.step(add(1), start);
    assert_eq!(batches(&core, &first).len(), 1);
    let second = core.step(add(2), start);
    assert!(batches(&core, &second).is_empty());
    assert!(core.next_deadline() <= start + REPLY_TIMEOUT);
    let given_up = core.tick(start + REPLY_TIMEOUT);
    assert_eq!(batches(&core, &given_up).len(), 1);
}

/// The version the server reports at attach decides what is re-listed
/// behind a command: a swap on 3.2, which announces none, and not on a
/// later tmux, whose `%layout-change` brings it. Before the answer, and
/// after a line that only looks like it, every workaround stays on.
#[test]
fn the_version_the_server_reports_decides_what_is_re_listed() {
    let swap_relists = |answer: Option<&str>| {
        let (mut core, now) = core("app");
        let ask = core.aggregator().markers().version_read_command();
        assert!(core
            .attach_commands((80, 24), AttachConfig::default())
            .contains(&ask));
        if let Some(answer) = answer {
            let event = marked(&core, VERSION_MARKER, answer);
            core.step(event, now);
        }
        !core.command("swap-pane -D", None, now).relists.is_empty()
    };
    assert!(swap_relists(None), "not answered yet");
    assert!(swap_relists(Some("3.2a")));
    assert!(!swap_relists(Some("3.6a")));
    assert!(!swap_relists(Some("next-3.8")));

    // A pane can print the marker's word, never its token.
    let (mut core, now) = core("app");
    core.step(response(&format!("{VERSION_MARKER} 0000 3.6a")), now);
    assert!(!core.command("swap-pane -D", None, now).relists.is_empty());
}
