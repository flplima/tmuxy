//! A window tmux announces before any list could read its tags (A16).

use super::tests::*;
use super::*;
use crate::constants::tmux_formats::{TmuxList, WindowColumn};
use crate::ids::test_ids::{pid, wid};
use crate::WindowType;

/// The tab the stories start from: `root`, two panes side by side.
const TAB_LAYOUT: &str = "b25d,80x24,0,0{40x24,0,0,0,39x24,41,0,1}";

/// Every order of `items`, so a test holds for any order tmux could use.
fn orders<T: Clone>(items: &[T]) -> Vec<Vec<T>> {
    if items.len() <= 1 {
        return vec![items.to_vec()];
    }
    let mut all = Vec::new();
    for i in 0..items.len() {
        let mut rest = items.to_vec();
        let first = rest.remove(i);
        for mut tail in orders(&rest) {
            tail.insert(0, first.clone());
            all.push(tail);
        }
    }
    all
}

/// An aggregator that has listed the tab `@0` with `%0` and `%1`.
fn listed_tab() -> StateAggregator {
    let mut agg = StateAggregator::new();
    let panes = [pane_row("%0", "@0", false), pane_row("%1", "@0", false)].join("\n");
    listed(&mut agg, TmuxList::Panes, &panes);
    listed(
        &mut agg,
        TmuxList::Windows,
        &window_row("@0", 0, true, "root").build(),
    );
    agg
}

fn step_lines(agg: &mut StateAggregator, lines: &[&str]) {
    let mut parser = crate::control_mode::Parser::new();
    for line in lines {
        if let Some(event) = parser.parse_line(line) {
            agg.step(event);
        }
    }
}

/// Opening the dock sends one list, `split-window ; break-pane -d -n
/// __sidebar-right ; set-option -w … @tmuxy-window-type sidebar-right`, and
/// tmux announces the new window in the notifications that follow it. None
/// of them carries the tag the list set: only the list-windows the
/// `%window-add` asks for does. Whatever order the announcements come in,
/// no state shows the window until then: shown, it was a tab named
/// `__sidebar-right`, and the dock still said "starting…".
#[test]
fn a_dock_window_is_shown_only_once_listed_as_the_dock() {
    let layout = format!("%layout-change @0 {TAB_LAYOUT} {TAB_LAYOUT} *");
    let announcements = [
        layout.as_str(),
        "%window-add @1",
        "%window-renamed @1 __sidebar-right",
        "%output %2 root@tmuxy:~# ",
    ];
    for order in orders(&announcements) {
        let mut agg = listed_tab();
        for line in &order {
            step_lines(&mut agg, &[line]);
            let state = agg.to_tmux_state();
            assert_eq!(
                state
                    .windows
                    .iter()
                    .map(|w| w.id.clone())
                    .collect::<Vec<_>>(),
                vec![wid("@0")],
                "after {line:?} in {order:?}"
            );
        }

        // The relist the add asked for: panes first (M2), still untagged.
        let panes = [
            pane_row("%0", "@0", false),
            pane_row("%1", "@0", false),
            pane_row("%2", "@1", false),
        ]
        .join("\n");
        listed(&mut agg, TmuxList::Panes, &panes);
        let state = agg.to_tmux_state();
        assert_eq!(state.windows.len(), 1, "{order:?}");
        assert!(state.panes.iter().all(|p| p.window_id == wid("@0")));

        let windows = [
            window_row("@0", 0, true, "root").build(),
            window_row("@1", 1, false, "__sidebar-right")
                .set(WindowColumn::WindowType, "sidebar-right")
                .build(),
        ]
        .join("\n");
        // The list that names it is what shows it: its own step emits.
        let shown = listed(&mut agg, TmuxList::Windows, &windows);
        assert!(
            shown
                .effects
                .iter()
                .any(|e| matches!(e, SideEffect::Emit(_))),
            "{order:?}"
        );
        let state = agg.to_tmux_state();
        let dock = state.windows.iter().find(|w| w.id == wid("@1"));
        assert_eq!(
            dock.and_then(|w| w.window_type),
            Some(WindowType::SidebarRight),
            "{order:?}"
        );
        assert!(state
            .panes
            .iter()
            .any(|p| p.tmux_id == pid("%2") && p.window_id == wid("@1")));
    }
}

/// A new tab is `split-window ; break-pane` without `-d`: tmux makes it the
/// current window, and the window the user is on is shown as soon as it is
/// announced — keys typed into it go to tmux's current pane meanwhile.
#[test]
fn a_new_current_window_is_shown_before_it_is_listed() {
    let mut agg = listed_tab();
    step_lines(
        &mut agg,
        &["%window-add @1", "%session-window-changed $0 @1"],
    );
    let state = agg.to_tmux_state();
    assert_eq!(state.active_window_id, Some(wid("@1")));
    assert!(state.windows.iter().any(|w| w.id == wid("@1")));
}
