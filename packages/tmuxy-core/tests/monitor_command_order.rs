//! The order of the tmux commands the runtime sends for one side effect —
//! M2 and M3 in `docs/INVARIANTS.md`.
//!
//! The monitor talks to a real `tmux -CC` and cannot be driven here, so the
//! command lists it sends are built by pure functions in `control_mode::state`
//! that the wasm host shares. The order is the point of each one: a window
//! listed before its panes is emitted with panes missing, and a capture placed
//! before `list-panes` refreshes the cursor lands on a stale position.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use tmuxy_core::constants::tmux_formats;
use tmuxy_core::control_mode::{pane_refresh_commands, window_relist_commands};
use tmuxy_core::PaneId;

fn position(commands: &[String], command: &str) -> usize {
    commands
        .iter()
        .position(|c| c == command)
        .unwrap_or_else(|| panic!("{command} is not sent at all: {commands:?}"))
}

/// M2: a window add, close, or the initial sync lists panes, then windows,
/// then the stash — and nothing else.
#[test]
fn a_window_relist_sends_panes_before_windows_and_the_stash_last() {
    let cmds = window_relist_commands();
    assert_eq!(
        cmds,
        [
            tmux_formats::LIST_PANES_CMD.to_string(),
            tmux_formats::LIST_WINDOWS_CMD.to_string(),
            tmux_formats::LIST_STASH_PANES_CMD.to_string(),
        ]
    );
}

proptest! {
    /// M3: whatever panes are queued, `list-panes` goes out before every
    /// capture, each queued pane is captured exactly once, and nothing is
    /// captured that was not queued.
    #[test]
    fn a_pane_refresh_lists_panes_before_every_capture(
        queued in prop::collection::vec(
            prop::sample::select(vec!["%0", "%1", "%2", "%3", "%4"])
                .prop_map(|p| p.parse::<PaneId>().unwrap()),
            0..6,
        ),
    ) {
        let cmds = pane_refresh_commands(&queued);
        let list_at = position(&cmds, tmux_formats::LIST_PANES_CMD);
        let captures: Vec<&String> = cmds.iter().filter(|c| c.contains("capture-pane")).collect();
        prop_assert_eq!(captures.len(), queued.len(), "one capture per queued pane: {:?}", cmds);
        for (i, cmd) in cmds.iter().enumerate() {
            if cmd.contains("capture-pane") {
                prop_assert!(i > list_at, "a capture before list-panes: {:?}", cmds);
            }
        }
        for pane in &queued {
            let target = format!("capture-pane -t {pane} ");
            prop_assert!(captures.iter().any(|c| c.contains(&target)),
                "{} queued but not captured: {:?}", pane, cmds);
        }
    }
}
