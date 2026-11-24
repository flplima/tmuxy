//! A layout cell and the pane in it, under `pane-border-status top`
//! (`border_row`), and the re-list a title change asks for.

use super::tests::*;
use super::tests_capture::captures;
use super::*;
use crate::constants::tmux_formats::{PaneColumn, TmuxList};
use crate::ids::test_ids::{pid, wid};

/// Two panes side by side in `@0`, 80x30, as tmux lists them with the
/// border row on top: each a row lower and shorter than its cell.
fn listed_with_the_row_on_top(agg: &mut StateAggregator) {
    let row = |id: &str, x: u32, w: u32| {
        pane_row_builder(id, "@0")
            .set(PaneColumn::Left, x)
            .set(PaneColumn::Top, 1)
            .set(PaneColumn::Width, w)
            .set(PaneColumn::Height, 29)
            .build()
    };
    let rows = format!("{}\n{}", row("%0", 0, 40), row("%1", 41, 39));
    listed(agg, TmuxList::Panes, &rows);
    // The captures the new panes asked for land: a pane asked for again
    // while one is on its way is not captured twice (`queue_captures`).
    for pane in ["0", "1"] {
        agg.step(response(&marked(agg, CAPTURE_BEGIN_MARKER, pane), true));
        agg.step(response("$ ", true));
        agg.step(response(&marked(agg, CAPTURE_END_MARKER, ""), true));
    }
}

fn layout_change(cells: &str) -> ControlModeEvent {
    let layout = format!("{:04x},{cells}", crate::layout::checksum(cells));
    ControlModeEvent::LayoutChange {
        window_id: wid("@0"),
        layout: layout.clone(),
        visible_layout: layout,
        flags: "*".to_string(),
    }
}

fn geometry(agg: &StateAggregator, pane: &str) -> (u32, u32, u32, u32) {
    let p = &agg.panes[&pid(pane)];
    (p.x, p.y, p.width, p.height)
}

/// tmux announced the cells (40x30) and listed the panes (40x29, a row
/// down): read as they came, each report resized the top panes and asked a
/// capture of them, at attach and after every resize.
#[test]
fn a_layout_names_the_pane_its_cell_holds_under_the_top_border_row() {
    let mut agg = StateAggregator::new();
    listed_with_the_row_on_top(&mut agg);
    let same = agg.step(layout_change("80x30,0,0{40x30,0,0,0,39x30,41,0,1}"));
    assert!(
        !same
            .effects
            .iter()
            .any(|e| captures(e, "%0") || captures(e, "%1")),
        "the layout says what the list did: {:?}",
        same.effects
    );
    assert_eq!(geometry(&agg, "%0"), (0, 1, 40, 29));

    // A real change of size is one, top pane or not.
    let taller = agg.step(layout_change("80x40,0,0[80x20,0,0,0,80x19,0,21,1]"));
    assert!(taller.effects.iter().any(|e| captures(e, "%0")));
    assert!(taller.effects.iter().any(|e| captures(e, "%1")));
    assert_eq!(geometry(&agg, "%0"), (0, 1, 80, 19));
    assert_eq!(geometry(&agg, "%1"), (0, 21, 80, 19));
}

/// What tmux has is only known from a list: before one, and on a window
/// tmuxy is about to set to something else, the cell is taken as the pane,
/// and a list that says otherwise asks the capture.
#[test]
fn a_border_row_no_list_has_shown_is_not_assumed() {
    let mut agg = StateAggregator::new();
    agg.step(layout_change("80x30,0,0{40x30,0,0,0,39x30,41,0,1}"));
    assert_eq!(geometry(&agg, "%0"), (0, 0, 40, 30));

    let mut agg = StateAggregator::new();
    listed_with_the_row_on_top(&mut agg);
    let float = window_row("@0", 0, true, "f")
        .set(
            crate::constants::tmux_formats::WindowColumn::WindowType,
            "float",
        )
        .build();
    let setup = listed(&mut agg, TmuxList::Windows, &float);
    assert!(setup
        .effects
        .iter()
        .any(|e| matches!(e, SideEffect::Send { commands, .. }
            if commands.iter().any(|c| c.ends_with("pane-border-status off")))));
    agg.step(layout_change("80x30,0,0{40x30,0,0,0,39x30,41,0,1}"));
    assert_eq!(geometry(&agg, "%0"), (0, 0, 40, 30));
}

/// A title rides `list-panes`; the pane's screen changes only with its
/// output. tmux reports every subscription once when it is made, and a
/// capture per title was a capture of every pane right after the attach.
#[test]
fn a_title_change_lists_the_panes_and_captures_none() {
    let mut agg = StateAggregator::new();
    listed_with_the_row_on_top(&mut agg);
    let changed = agg.step(ControlModeEvent::SubscriptionChanged {
        name: crate::constants::tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME.to_string(),
        pane_id: pid("%0"),
    });
    let sent: Vec<&String> = changed
        .effects
        .iter()
        .flat_map(|e| match e {
            SideEffect::Send { commands, .. } => commands.iter().collect(),
            _ => Vec::new(),
        })
        .collect();
    assert!(sent
        .iter()
        .any(|c| **c == agg.markers().list_command(TmuxList::Panes)));
    assert!(!sent.iter().any(|c| c.contains("capture-pane")), "{sent:?}");
}
