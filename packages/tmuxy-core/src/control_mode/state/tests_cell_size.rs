//! A program asks the terminal how big a cell is (`CSI 16 t`) or its text
//! area (`CSI 14 t`); the aggregator answers from the cell size a client
//! announced (`@tmuxy-cell-px`), typed into the pane that asked.

use super::tests::*;
use super::*;
use crate::constants::tmux_formats::CELL_PX_SUBSCRIPTION_NAME;
use crate::ids::test_ids::pid;

fn printed(agg: &mut StateAggregator, pane_id: &str, bytes: &[u8]) -> Vec<String> {
    agg.process_event(ControlModeEvent::Output {
        pane_id: pid(pane_id),
        content: bytes.to_vec(),
    })
    .commands
}

fn announce(agg: &mut StateAggregator, value: &str) {
    agg.process_event(ControlModeEvent::SessionSubscriptionChanged {
        name: CELL_PX_SUBSCRIPTION_NAME.to_string(),
        value: value.to_string(),
    });
}

/// The command that types `reply` into `pane_id`, as `cell_size` spells it.
fn typed(pane_id: &str, reply: &str) -> String {
    cell_size::reply_command(&pid(pane_id), reply)
}

/// An 80x24 pane on a tmux that does not answer the queries itself.
fn on_tmux_3_2() -> StateAggregator {
    let mut agg = StateAggregator::new();
    agg.caps = crate::tmux_compat::TmuxCaps::from_version("3.2a");
    seed_active_pane(&mut agg, "%0", "@0");
    seed_pane(&mut agg, "%1", "@0");
    agg
}

#[test]
fn the_query_is_answered_with_the_announced_size_in_the_pane_that_asked() {
    let mut agg = on_tmux_3_2();
    announce(&mut agg, "9x24");

    assert_eq!(
        printed(&mut agg, "%1", b"\x1b[16t"),
        vec![typed("%1", "\x1b[6;24;9t")]
    );
    // 24 rows of 24 px, 80 columns of 9 px.
    assert_eq!(
        printed(&mut agg, "%1", b"before\x1b[14tafter"),
        vec![typed("%1", "\x1b[4;576;720t")]
    );

    // A size not whole is rounded, each side on its own.
    announce(&mut agg, "8.5x17.4");
    assert_eq!(
        printed(&mut agg, "%0", b"\x1b[16t\x1b[14t"),
        vec![typed("%0", "\x1b[6;17;9t"), typed("%0", "\x1b[4;418;680t")]
    );
    assert_eq!(agg.to_tmux_state().cell_px.as_deref(), Some("8.5x17.4"));
}

#[test]
fn with_no_size_announced_the_query_gets_no_reply() {
    let mut agg = on_tmux_3_2();
    assert!(printed(&mut agg, "%0", b"\x1b[16t\x1b[14t").is_empty());

    // Not a size: as if none were announced. And a query asked before the
    // size came is not answered late.
    announce(&mut agg, "big");
    assert_eq!(agg.to_tmux_state().cell_px, None);
    assert!(printed(&mut agg, "%0", b"\x1b[16t").is_empty());
    announce(&mut agg, "9x24");
    assert!(printed(&mut agg, "%0", b"plain").is_empty());
}

#[test]
fn other_window_operations_get_nothing() {
    let mut agg = on_tmux_3_2();
    announce(&mut agg, "9x24");
    for query in [
        &b"\x1b[18t"[..],
        b"\x1b[15t",
        b"\x1b[19t",
        b"\x1b[14;2t",
        b"\x1b[22;0t",
        b"\x1b[23;0t",
        b"\x1b[8;24;80t",
        b"\x1b[?16t",
        b"\x1b[16T",
    ] {
        assert!(
            printed(&mut agg, "%0", query).is_empty(),
            "{}",
            String::from_utf8_lossy(query)
        );
    }
}

#[test]
fn a_pane_writing_the_query_in_a_loop_is_answered_a_few_times_a_second() {
    let mut agg = on_tmux_3_2();
    announce(&mut agg, "9x24");
    let flood = b"\x1b[16t".repeat(500);
    let replies = printed(&mut agg, "%0", &flood).len()
        + (0..50)
            .map(|_| printed(&mut agg, "%0", b"\x1b[16t").len())
            .sum::<usize>();
    assert_eq!(replies, usize::from(cell_size::MAX_REPLIES));
    // Another pane has a budget of its own.
    assert_eq!(printed(&mut agg, "%1", b"\x1b[16t").len(), 1);
}

#[test]
fn a_tmux_that_answers_itself_is_left_to_answer() {
    for version in ["3.4", "3.5a", "3.6a", "3.7a", "next-3.8", "master", ""] {
        let mut agg = on_tmux_3_2();
        agg.caps = crate::tmux_compat::TmuxCaps::from_version(version);
        announce(&mut agg, "9x24");
        assert!(
            printed(&mut agg, "%0", b"\x1b[16t\x1b[14t").is_empty(),
            "tmux {version:?}"
        );
    }
}

/// The announced size rides the state to every client: a delta when it
/// changes, `""` when it goes, nothing when it is announced again.
#[test]
fn the_announced_size_rides_the_next_delta() {
    let mut agg = on_tmux_3_2();
    mark_initial_sync_done(&mut agg);
    assert!(matches!(
        agg.to_state_update(),
        Some(crate::StateUpdate::Full { .. })
    ));
    let delta = |agg: &mut StateAggregator| match agg.to_state_update() {
        Some(crate::StateUpdate::Delta { delta }) => Some(delta.cell_px),
        None => None,
        other => panic!("expected a delta, got {other:?}"),
    };

    announce(&mut agg, "9x24");
    assert_eq!(delta(&mut agg), Some(Some("9x24".to_string())));
    announce(&mut agg, "9x24");
    assert_eq!(delta(&mut agg), None, "the same size again sends nothing");
    announce(&mut agg, "");
    assert_eq!(delta(&mut agg), Some(Some(String::new())));
}
