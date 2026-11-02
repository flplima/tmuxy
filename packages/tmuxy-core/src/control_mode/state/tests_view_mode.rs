//! The view mode tmux opens on a pane, which the client does not draw: it
//! is closed, with a notice, unless a terminal client is reading it.

use super::tests::*;
use super::*;
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

    let listed = agg.step(response(&pane_row_in_mode("%0", "@0", 2), true));
    assert!(!agg.panes["%0"].in_mode, "view mode is not copy mode");
    assert!(agg.panes["%0"].view_mode);
    let asked = agg.markers().clients_read_command(&pid("%0"));
    assert!(
        listed
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::SendTmuxCommand(cmd) if cmd == &asked)),
        "the row asks who is attached ({:?})",
        listed.effects
    );
    // The same row again is the same view mode, not a second question.
    let again = agg.step(response(&pane_row_in_mode("%0", "@0", 2), true));
    assert!(
        !again
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::SendTmuxCommand(cmd) if cmd == &asked)),
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
            .any(|e| matches!(e, SideEffect::SendTmuxCommand(cmd) if cmd == "copy-mode -q -t %0")),
        "the view mode is reset ({:?})",
        answer.effects
    );
    assert!(
        answer.effects.iter().any(
            |e| matches!(e, SideEffect::ShowMessage(text) if text == "tmux opened a view in pane %0; closed it")
        ),
        "the person is told ({:?})",
        answer.effects
    );

    // Closed: the next row says so, and the next opening is asked about.
    agg.step(response(&pane_row_in_mode("%0", "@0", 0), true));
    assert!(!agg.panes["%0"].view_mode);
    let reopened = agg.step(response(&pane_row_in_mode("%0", "@0", 2), true));
    assert!(reopened
        .effects
        .iter()
        .any(|e| matches!(e, SideEffect::SendTmuxCommand(cmd) if cmd == &asked)));
}

/// A terminal client attached to the session, or to one grouped with it,
/// sees the pager tmux opened and can close it: their listing is kept.
#[test]
fn a_view_mode_a_terminal_client_is_reading_is_left_open() {
    for clients in ["1,,m\n0,,m\n", "1,g1,m\n0,g1,m-tty\n"] {
        let mut agg = StateAggregator::with_session_name("m");
        seed_active_pane(&mut agg, "%0", "@0");
        agg.step(ControlModeEvent::SessionsChanged);
        agg.step(response(&pane_row_in_mode("%0", "@0", 2), true));

        agg.step(response(&marked(&agg, CLIENTS_BEGIN_MARKER, "0"), true));
        let answer = agg.step(response(clients, true));
        agg.step(response(&marked(&agg, CLIENTS_END_MARKER, ""), true));
        assert!(
            !answer.effects.iter().any(|e| matches!(
                e,
                SideEffect::SendTmuxCommand(_) | SideEffect::ShowMessage(_)
            )),
            "{clients:?}: the terminal client keeps its view ({:?})",
            answer.effects
        );
    }
}
