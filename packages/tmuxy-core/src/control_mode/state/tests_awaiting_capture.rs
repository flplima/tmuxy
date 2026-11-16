//! A pane whose screen is unknown — moved to another window, or just
//! appeared — holds its `%output` until its capture lands (A9).

use super::tests::*;
use super::tests_capture::captures;
use super::*;
use crate::constants::tmux_formats::TmuxList;
use crate::ids::test_ids::{pid, wid};

/// A pane that moved windows (break-pane) holds its `%output` until the
/// capture of its new place lands. When that capture fails, the hold must
/// be released with it, or the pane goes blind: every line it prints from
/// then on is dropped until some later capture happens to land.
#[test]
fn a_moved_pane_whose_capture_fails_gets_its_output_back() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    for w in ["@0", "@1"] {
        agg.windows.insert(wid(w), WindowState::new(wid(w), 0));
    }
    let layout = "0000,80x24,0,0,0";
    let moved = agg.process_event(ControlModeEvent::LayoutChange {
        window_id: wid("@1"),
        layout: layout.into(),
        visible_layout: layout.into(),
        flags: String::new(),
    });
    assert_eq!(
        moved.panes_needing_refresh,
        vec![pid("%0")],
        "a move captures the pane"
    );
    agg.queue_captures(&[pid("%0")]);

    let held = agg.process_event(ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"STALE\r\n".to_vec(),
    });
    assert!(
        !held.state_changed,
        "output is held while the capture is in flight"
    );

    agg.process_event(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0"), true));
    agg.process_event(ControlModeEvent::CommandResponse {
        output: "can't find pane: %0\n".to_string(),
        success: false,
    });

    let after = agg.process_event(ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"FRESH".to_vec(),
    });
    assert!(
        after.state_changed,
        "output reaches the pane once the capture is over"
    );
    let first_row: String = agg.panes.get_mut("%0").unwrap().get_content()[0]
        .iter()
        .map(|c| c.char.clone())
        .collect();
    assert_eq!(first_row.trim_end(), "FRESH");
}

/// A pane-group member swapped back in from the stash is new to the
/// aggregator, and on tmux 3.2, where no `%layout-change` announces the swap,
/// the keys typed into it arrive before the list-panes row that places it.
/// Its screen comes from the capture alone: a grid built from what it printed
/// since showed the pane with every earlier line gone until the capture
/// landed.
#[test]
fn a_pane_that_appears_shows_no_screen_before_its_capture() {
    let mut agg = StateAggregator::new();
    let screen = |agg: &mut StateAggregator| -> String {
        agg.panes
            .get_mut("%3")
            .unwrap()
            .get_content()
            .iter()
            .map(|row| row.iter().map(|c| c.char.clone()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string()
    };
    let typed = |agg: &mut StateAggregator, keys: &[u8]| {
        agg.step(ControlModeEvent::Output {
            pane_id: pid("%3"),
            content: keys.to_vec(),
        })
    };

    typed(&mut agg, b"\r$ ALPHA");
    let appeared = listed(&mut agg, TmuxList::Panes, &pane_row("%3", "@0", false));
    assert!(
        appeared.effects.iter().any(|e| captures(e, "%3")),
        "a pane that appears is captured ({:?})",
        appeared.effects
    );
    typed(&mut agg, b"KEY");
    assert_eq!(screen(&mut agg), "", "no fragment before the capture");

    agg.step(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "3"), true));
    agg.step(response(
        "$ echo ALPHA_HOME\nALPHA_HOME\n$ ALPHAKEY\n",
        true,
    ));
    agg.step(response(&marked(&agg, CAPTURE_END_MARKER, ""), true));
    let captured = screen(&mut agg);
    assert!(
        captured.contains("ALPHA_HOME") && captured.contains("$ ALPHAKEY"),
        "the capture is the screen: {captured:?}"
    );

    typed(&mut agg, b"\r\nAFTER");
    assert!(
        screen(&mut agg).contains("AFTER"),
        "output after the capture reaches the pane"
    );
}
