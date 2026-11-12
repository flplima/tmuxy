use std::time::Duration;

use super::super::tests::{mark_initial_sync_done, seed_pane};
use super::super::*;
use super::*;
use crate::ids::test_ids::{pid, wid};

/// Two tabs, `@0` shown with `%0`, `@1` hidden with `%1`, the first update sent.
fn two_tabs(t0: Instant) -> StateAggregator {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    seed_pane(&mut agg, "%1", "@1");
    agg.windows
        .insert(wid("@0"), WindowState::new(wid("@0"), 0));
    agg.windows
        .insert(wid("@1"), WindowState::new(wid("@1"), 1));
    agg.active_window_id = Some(wid("@0"));
    mark_initial_sync_done(&mut agg);
    assert!(matches!(
        agg.to_state_update_at(t0),
        Some(crate::StateUpdate::Full { .. })
    ));
    agg
}

fn print(agg: &mut StateAggregator, pane: &str, text: &str) {
    agg.step(ControlModeEvent::Output {
        pane_id: pid(pane),
        content: text.as_bytes().to_vec(),
    });
}

/// The panes a delta carries, and the first line of each, as text.
fn carried(update: Option<crate::StateUpdate>) -> Vec<(String, String)> {
    let Some(crate::StateUpdate::Delta { delta }) = update else {
        return Vec::new();
    };
    let mut panes: Vec<(String, String)> = delta
        .panes
        .unwrap_or_default()
        .into_iter()
        .map(|(id, pane)| {
            let line = pane
                .and_then(|pane| pane.content)
                .and_then(|content| content.get(&0).cloned())
                .map(|cells| cells.iter().map(|c| c.char.clone()).collect::<String>())
                .unwrap_or_default();
            (id.to_string(), line.trim_end().to_string())
        })
        .collect();
    panes.sort();
    panes
}

const MS: Duration = Duration::from_millis(1);

/// A hidden pane's first frame goes at once, the next ones wait, and the
/// latest of them goes when the interval ends: none is lost, frames between
/// are skipped. The shown pane is never held.
#[test]
fn a_hidden_pane_sends_its_latest_frame_once_a_second() {
    let t0 = Instant::now();
    let mut agg = two_tabs(t0);

    print(&mut agg, "%1", "\rframe 1");
    assert_eq!(
        carried(agg.to_state_update_at(t0 + 10 * MS)),
        [("%1".into(), "frame 1".into())]
    );
    print(&mut agg, "%1", "\rframe 2");
    assert_eq!(carried(agg.to_state_update_at(t0 + 20 * MS)), []);
    assert_eq!(
        agg.hidden_panes_due(),
        Some(t0 + 10 * MS + HIDDEN_PANE_EVERY)
    );
    print(&mut agg, "%1", "\rframe 3");
    print(&mut agg, "%0", "typed");
    assert_eq!(
        carried(agg.to_state_update_at(t0 + 500 * MS)),
        [("%0".into(), "typed".into())],
        "the shown pane goes at once; the hidden one still waits"
    );

    let due = agg.hidden_panes_due().expect("the held frame is due");
    assert_eq!(
        carried(agg.to_state_update_at(due)),
        [("%1".into(), "frame 3".into())],
        "the latest frame, when due"
    );
    assert_eq!(agg.hidden_panes_due(), None);
}

/// Shown again, a held pane goes at once, with all it held.
#[test]
fn a_held_pane_goes_at_once_when_its_tab_is_shown() {
    let t0 = Instant::now();
    let mut agg = two_tabs(t0);
    print(&mut agg, "%1", "\rframe 1");
    agg.to_state_update_at(t0 + 10 * MS);
    print(&mut agg, "%1", "\rframe 2");
    assert_eq!(carried(agg.to_state_update_at(t0 + 20 * MS)), []);

    agg.active_window_id = Some(wid("@1"));
    let update = agg.to_state_update_at(t0 + 30 * MS);
    assert_eq!(carried(update), [("%1".into(), "frame 2".into())]);
}

/// What is not drawn inside the pane (its state, a question it asks) is
/// never held: a tab's badge says at once that its agent needs the user.
#[test]
fn only_a_hidden_screen_change_may_wait() {
    let t0 = Instant::now();
    let mut held = HiddenPanes::default();
    let screen = crate::PaneDelta {
        cursor_x: Some(3),
        ..Default::default()
    };
    let state = crate::PaneDelta {
        pane_state: Some(Some(crate::PaneStateName::NeedsInput.as_str().into())),
        ..Default::default()
    };
    let pane = pid("%1");
    assert!(held.send_now(&pane, true, &screen, t0));
    assert!(!held.send_now(&pane, true, &screen, t0 + MS));
    assert!(held.send_now(&pane, true, &state, t0 + 2 * MS));
    assert!(held.send_now(&pane, false, &screen, t0 + 3 * MS), "shown");
}
