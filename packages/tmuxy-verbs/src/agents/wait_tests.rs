use super::*;

fn listing(rows: &[(&str, &str, &str)]) -> HashMap<String, Seen> {
    parse_listing(
        &rows
            .iter()
            .map(|(pane, label, state)| format!("{pane}\t{label}\t{state}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn panes(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

#[test]
fn a_duration_is_seconds_minutes_or_hours() {
    assert_eq!(duration("30s"), Some(Duration::from_secs(30)));
    assert_eq!(duration("10m"), Some(Duration::from_secs(600)));
    assert_eq!(duration("2h"), Some(Duration::from_secs(7200)));
    assert_eq!(duration("45"), Some(Duration::from_secs(45)));
    assert_eq!(duration("1d"), None);
    assert_eq!(duration("m"), None);
}

#[test]
fn a_target_is_a_pane_id_or_the_one_pane_with_that_label() {
    let seen = listing(&[
        ("%1", "fix-a", "working"),
        ("%2", "dup", ""),
        ("%3", "dup", ""),
    ]);
    let targets = |t: &[&str]| resolve(&t.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &seen);
    assert_eq!(targets(&["fix-a", "%2"]), Ok(panes(&["%1", "%2"])));
    assert_eq!(targets(&["%9"]), Err("no pane %9".into()));
    assert_eq!(
        targets(&["nobody"]),
        Err("no pane is labelled \"nobody\"".into())
    );
    assert_eq!(
        targets(&["dup"]),
        Err("2 panes are labelled \"dup\"".into())
    );
}

/// The case that matters: an agent spawned a moment ago is idle from its
/// session start, before it has its task. That is not the end of its turn.
#[test]
fn a_pane_already_settled_when_the_wait_begins_does_not_end_it() {
    let mut wait = Waiter::new(panes(&["%1"]), &[], false, false);
    assert_eq!(wait.read(&listing(&[("%1", "a", "idle")]), true), None);
    assert_eq!(wait.read(&listing(&[("%1", "a", "working")]), false), None);
    assert_eq!(
        wait.read(&listing(&[("%1", "a", "idle")]), false),
        Some(vec![Counted {
            pane: "%1".into(),
            label: "a".into(),
            state: "idle".into()
        }])
    );
}

#[test]
fn now_counts_a_pane_that_is_already_there() {
    let mut wait = Waiter::new(panes(&["%1"]), &[Until::NeedsInput], false, true);
    let counted = wait
        .read(&listing(&[("%1", "a", "needs-input")]), true)
        .unwrap();
    assert_eq!(counted[0].state, "needs-input");
}

#[test]
fn only_the_states_asked_for_count_and_done_is_a_result_to_be_seen() {
    let mut wait = Waiter::new(panes(&["%1"]), &[Until::Done, Until::Error], false, false);
    wait.read(&listing(&[("%1", "", "working")]), true);
    assert_eq!(wait.read(&listing(&[("%1", "", "idle")]), false), None);
    assert_eq!(
        wait.read(&listing(&[("%1", "", "needs-input")]), false),
        None
    );
    assert_eq!(
        wait.read(&listing(&[("%1", "", "unread")]), false).unwrap()[0].state,
        "unread"
    );
}

#[test]
fn any_ends_on_the_first_pane_and_all_on_the_last() {
    let start = listing(&[("%1", "a", "working"), ("%2", "b", "working")]);
    let one = listing(&[("%1", "a", "error"), ("%2", "b", "working")]);
    let both = listing(&[("%1", "a", "working"), ("%2", "b", "needs-input")]);

    let mut any = Waiter::new(panes(&["%1", "%2"]), &[], false, false);
    any.read(&start, true);
    let counted = any.read(&one, false).unwrap();
    assert_eq!(counted.len(), 1);
    assert_eq!(counted[0].pane, "%1");

    let mut all = Waiter::new(panes(&["%1", "%2"]), &[], true, false);
    all.read(&start, true);
    assert_eq!(all.read(&one, false), None);
    // %1 counted when it got there, even though it is working again now.
    let counted = all.read(&both, false).unwrap();
    assert_eq!(
        counted
            .iter()
            .map(|c| (c.pane.as_str(), c.state.as_str()))
            .collect::<Vec<_>>(),
        [("%1", "error"), ("%2", "needs-input")]
    );
}

/// `fix-a %1` names one pane twice when %1 is `fix-a`: `--all` still ends.
#[test]
fn a_pane_named_twice_is_waited_for_once() {
    let mut all = Waiter::new(panes(&["%1", "%1"]), &[], true, false);
    all.read(&listing(&[("%1", "a", "working")]), true);
    let counted = all.read(&listing(&[("%1", "a", "idle")]), false).unwrap();
    assert_eq!(counted.len(), 1);
}

/// A crashed or closed pane is not a finished one: the wait ends, marked
/// gone, unless it was asked to wait for exactly that.
#[test]
fn a_pane_that_is_gone_ends_the_wait_as_gone_unless_exited_was_asked_for() {
    let start = listing(&[("%1", "", "working"), ("%2", "", "working")]);
    let after = listing(&[("%2", "", "working")]);

    let mut wait = Waiter::new(panes(&["%1", "%2"]), &[Until::Idle], true, false);
    wait.read(&start, true);
    assert_eq!(wait.read(&after, false).unwrap()[0].state, "exited");
    assert!(wait.gone);

    let mut asked = Waiter::new(
        panes(&["%1", "%2"]),
        &[Until::Exited, Until::Idle],
        true,
        false,
    );
    asked.read(&start, true);
    assert_eq!(asked.read(&after, false), None, "%2 is still working");
    assert!(!asked.gone);
}

#[test]
fn a_listing_line_without_a_pane_id_is_skipped() {
    let seen = parse_listing("%4\tfix\tworking\nnot a pane\n%5\t\t\n");
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen["%4"],
        Seen {
            label: "fix".into(),
            state: "working".into()
        }
    );
    assert_eq!(seen["%5"].state, "");
}
