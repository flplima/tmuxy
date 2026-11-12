use std::collections::HashMap;

use super::*;
use crate::host::socket_watch::PaneRow;
use crate::PaneStateName;

fn row(pane: &str, state: &str) -> PaneRow {
    PaneRow {
        pane_id: pane.into(),
        state: state.into(),
        ..PaneRow::default()
    }
}

/// A turn spans the agent's questions: answering one goes on with it.
#[test]
fn a_pane_entering_working_begins_a_turn_and_one_at_rest_again_ends_it() {
    let waiting = PaneStateName::NeedsInput.as_str();
    let before: HashMap<String, String> = [
        ("%1", ""),
        ("%2", "working"),
        ("%3", "working"),
        ("%4", waiting),
        ("%6", "working"),
        ("%7", waiting),
    ]
    .into_iter()
    .map(|(pane, state)| (pane.to_string(), state.to_string()))
    .collect();
    let rows = [
        row("%1", "working"),
        row("%2", "working"),
        row("%3", "idle"),
        row("%4", "working"),
        row("%5", "working"),
        row("%6", waiting),
        row("%7", "unread"),
    ];
    assert_eq!(
        transitions(&before, &rows),
        [
            ("%1".to_string(), Transition::Began),
            ("%3".to_string(), Transition::Ended),
            ("%5".to_string(), Transition::Began),
            ("%7".to_string(), Transition::Ended),
        ]
    );
}
