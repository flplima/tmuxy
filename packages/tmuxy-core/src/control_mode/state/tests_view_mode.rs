use super::tests::*;
use super::tests_capture::captures;
use super::*;
use crate::constants::tmux_formats::TmuxList;
use crate::ids::test_ids::pid;

/// A view mode is closed, and said so, once nobody who could see it is
/// attached. tmux opens one on the current pane for what a `run-shell -b`
/// prints; the client draws no view mode, so every key went to a pager
/// nobody saw. The row reporting it makes the aggregator ask who is
/// attached; with only control clients the mode is reset and the person
/// told. A pane in view mode is never the client's copy mode.
#[test]
fn a_view_mode_nobody_sees_is_closed_with_a_notice() {
    let mut agg = StateAggregator::with_session_name("m");
    seed_active_pane(&mut agg, "%0", "@0");
    agg.step(ControlModeEvent::SessionsChanged);

    let opened = listed(&mut agg, TmuxList::Panes, &pane_row_in_mode("%0", "@0", 2));
    assert!(!agg.panes["%0"].in_mode, "view mode is not copy mode");
    assert!(agg.panes["%0"].view_mode);
    let asked = agg.markers().clients_read_command(&pid("%0"));
    assert!(
        opened
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::Send { batch: Batch::Own, commands } if commands.iter().any(|cmd| cmd == &asked))),
        "the row asks who is attached ({:?})",
        opened.effects
    );
    // The same row again is the same view mode, not a second question.
    let again = listed(&mut agg, TmuxList::Panes, &pane_row_in_mode("%0", "@0", 2));
    assert!(
        !again
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::Send { batch: Batch::Own, commands } if commands.iter().any(|cmd| cmd == &asked))),
        "a view mode already asked about is not asked about again"
    );

    // This client, and a terminal client of an unrelated session.
    agg.step(response(&marked(&agg, CLIENTS_BEGIN_MARKER, "0"), true));
    let answer = agg.step(response("1,,m\n0,,other\n", true));
    agg.step(response(&marked(&agg, CLIENTS_END_MARKER, ""), true));
    assert!(
        answer
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::Send { batch: Batch::Own, commands } if commands.iter().any(|cmd| cmd == "copy-mode -q -t %0"))),
        "the view mode is reset ({:?})",
        answer.effects
    );
    assert!(
        answer.effects.iter().any(
            |e| matches!(e, SideEffect::Notify(Notice::Message(text)) if text == "tmux opened a view in pane %0; closed it")
        ),
        "the person is told ({:?})",
        answer.effects
    );

    // Closed: the next row says so, and the next opening is asked about.
    listed(&mut agg, TmuxList::Panes, &pane_row_in_mode("%0", "@0", 0));
    assert!(!agg.panes["%0"].view_mode);
    let reopened = listed(&mut agg, TmuxList::Panes, &pane_row_in_mode("%0", "@0", 2));
    assert!(reopened
        .effects
        .iter()
        .any(|e| matches!(e, SideEffect::Send { batch: Batch::Own, commands } if commands.iter().any(|cmd| cmd == &asked))));
}

/// A terminal client attached to the session, or to one grouped with it,
/// sees the pager tmux opened and can close it: their listing is kept.
#[test]
fn a_view_mode_a_terminal_client_is_reading_is_left_open() {
    for clients in ["1,,m\n0,,m\n", "1,g1,m\n0,g1,m-tty\n"] {
        let mut agg = StateAggregator::with_session_name("m");
        seed_active_pane(&mut agg, "%0", "@0");
        agg.step(ControlModeEvent::SessionsChanged);
        listed(&mut agg, TmuxList::Panes, &pane_row_in_mode("%0", "@0", 2));

        agg.step(response(&marked(&agg, CLIENTS_BEGIN_MARKER, "0"), true));
        let answer = agg.step(response(clients, true));
        agg.step(response(&marked(&agg, CLIENTS_END_MARKER, ""), true));
        assert!(
            !answer.effects.iter().any(|e| matches!(
                e,
                SideEffect::Send {
                    batch: Batch::Own,
                    ..
                } | SideEffect::Notify(Notice::Message(_))
            )),
            "{clients:?}: the terminal client keeps its view ({:?})",
            answer.effects
        );
    }
}

/// The same request for a pane in copy mode is left to the copy-mode poll,
/// which captures every such pane on each tick: a follow-up per landed
/// capture would keep one on the wire at all times, since each tick finds
/// the last one in flight.
#[test]
fn a_capture_asked_twice_for_a_pane_in_copy_mode_is_left_to_the_poll() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    enter_copy_mode(&mut agg, "%0", "@0");
    agg.pending_captures.clear();
    assert_eq!(agg.queue_captures(&[pid("%0")]), vec![pid("%0")]);
    assert!(agg.queue_captures(&[pid("%0")]).is_empty());

    agg.step(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0"), true));
    let landed = agg.step(response("COPY MODE VIEW\n", true));
    assert!(
        !landed.effects.iter().any(|e| captures(e, "%0")),
        "no follow-up for a pane in copy mode ({:?})",
        landed.effects
    );
    agg.step(response(&marked(&agg, CAPTURE_END_MARKER, ""), true));
    assert!(agg
        .copy_mode_poll_commands()
        .iter()
        .any(|c| c.contains("capture-pane -t %0 ")));
}
