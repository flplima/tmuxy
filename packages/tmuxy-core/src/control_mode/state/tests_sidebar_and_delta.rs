use super::tests::*;
use super::*;
use crate::ids::test_ids::{pid, wid};
use crate::{WindowId, WindowType};

/// Each sidebar is docked beside the pane grid, so the client-size pass must
/// size it to its own narrow column — sizing it to the viewport makes its
/// shell wrap at a width the UI never draws. The two columns differ in
/// width, so they cannot share one size.
#[test]
fn window_ids_by_sizing_splits_both_sidebars_off() {
    use crate::constants::sidebar_dock;

    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@1,0,1,tab,,,,,,,,,,,0,shell");
    agg.parse_list_windows_line("@2,1,0,float,,,,,,,,,,,0,float");
    agg.parse_list_windows_line("@3,2,0,sidebar-left,,,,,,,,,,,0,tree");
    agg.parse_list_windows_line("@4,3,0,sidebar-right,,,,,,,,,,,0,term");

    let (mut viewport, mut sidebars) = agg.window_ids_by_sizing();
    viewport.sort_by_key(WindowId::number);
    sidebars.sort_by_key(|(w, _, _)| w.number());
    assert_eq!(viewport, vec![wid("@1"), wid("@2")]);
    assert_eq!(
        sidebars,
        vec![
            (wid("@3"), sidebar_dock::LEFT_COLS, None),
            (wid("@4"), sidebar_dock::RIGHT_COLS, None),
        ],
        "each column carries its own width, not a shared one"
    );

    // A sidebar keeps the viewport's rows — it runs the full height of the
    // app body and draws no header of its own.
    assert_eq!(
        sidebar_dock::size(WindowType::SidebarLeft, None, 50),
        Some((sidebar_dock::LEFT_COLS, 50))
    );
    // ...and never collapses to zero rows on a degenerate viewport.
    assert_eq!(
        sidebar_dock::size(WindowType::SidebarRight, None, 0),
        Some((sidebar_dock::RIGHT_COLS, 1))
    );
    // Everything else is viewport-sized, so it has no column width.
    assert_eq!(sidebar_dock::size(WindowType::Tab, None, 50), None);
    assert_eq!(sidebar_dock::size(WindowType::Float, None, 50), None);
}

/// A dragged column width replaces the default, and is clamped so a drag
/// can neither squeeze the column below legibility nor swallow the grid.
#[test]
fn sidebar_width_honours_the_user_drag_within_limits() {
    use crate::constants::sidebar_dock;

    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@3,2,0,sidebar-left,,,,,,,,48,,,0,tree");
    let (_, sidebars) = agg.window_ids_by_sizing();
    assert_eq!(sidebars, vec![(wid("@3"), 48, None)]);

    assert_eq!(
        sidebar_dock::cols(WindowType::SidebarLeft, Some(2)),
        Some(sidebar_dock::MIN_COLS),
        "a drag past the floor stops at it"
    );
    assert_eq!(
        sidebar_dock::cols(WindowType::SidebarRight, Some(9999)),
        Some(sidebar_dock::MAX_COLS),
        "...and past the ceiling likewise"
    );
    // A width set on a non-sidebar window is meaningless, not a size.
    assert_eq!(sidebar_dock::cols(WindowType::Tab, Some(48)), None);
}

/// `%window-add` lands before the `@tmuxy-window-type` marker is readable,
/// so a sidebar's window is first adopted as a tab and given the tab-only
/// pane-border row. The next pass, once the type is known, has to take it
/// back — a sidebar is sized without that row.
#[test]
fn sidebar_loses_the_pane_border_a_tab_gets() {
    let mut agg = StateAggregator::new();
    // The window as `%window-add` / the first list-windows sees it: no
    // marker yet, because the create command's `set-option` has not been
    // read back.
    agg.parse_list_windows_line("@4,2,0,,,,,,,,,,,0,side");
    let adopted = agg.collect_window_tag_commands();
    assert!(
        adopted
            .iter()
            .any(|c| c == "set-option -w -t @4 pane-border-status top"),
        "an untyped new window is adopted as a tab: {adopted:?}"
    );

    // The list-windows response carries the marker the create command set.
    agg.parse_list_windows_line("@4,2,0,sidebar-right,,,,,,,,,,,0,side");
    let corrected = agg.collect_window_tag_commands();
    assert!(
        corrected
            .iter()
            .any(|c| c == "set-option -w -t @4 pane-border-status off"),
        "the border must be taken back once the type lands: {corrected:?}"
    );
    // ...exactly once, and never re-enforced afterwards.
    assert!(agg.collect_window_tag_commands().is_empty());
}

/// The monitor re-lists windows right behind a create command, so a
/// sidebar can be typed before it was ever adopted as a tab. The global
/// `pane-border-status top` still applies to it, so the border must come
/// off in that case too — it used to be skipped, leaving the pane a row short.
#[test]
fn sidebar_typed_on_arrival_still_loses_the_pane_border() {
    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@4,2,0,sidebar-left,,,,,,,,,,,0,__sidebar-left");
    let cmds = agg.collect_window_tag_commands();
    assert!(
        cmds.iter()
            .any(|c| c == "set-option -w -t @4 pane-border-status off"),
        "a sidebar typed on arrival must still drop the border row: {cmds:?}"
    );
    assert!(agg.collect_window_tag_commands().is_empty());
}

#[test]
fn window_add_assigns_provisional_index_past_the_highest() {
    // The tmuxy guest snapshot already has window id and index diverged:
    // root @0 sits at positional index 1.
    let mut agg = StateAggregator::new();
    agg.windows
        .insert(wid("@0"), WindowState::new(wid("@0"), 1));

    // `tmuxy tab create` allocates window @1; %window-add carries only the
    // id. The new window must land at index 2 (one past the highest), NOT
    // the id-derived guess of 1 — which would collide with root and render
    // the wrong tab number until the delayed list-windows arrives.
    agg.step(ControlModeEvent::WindowAdd {
        window_id: wid("@1"),
    });

    let new_window = agg.windows.get("@1").expect("window @1 created");
    assert_eq!(new_window.index, 2);
}

#[test]
fn window_renamed_creating_a_window_also_gets_provisional_index() {
    let mut agg = StateAggregator::new();
    agg.windows
        .insert(wid("@0"), WindowState::new(wid("@0"), 1));

    // A rename can arrive before the add and creates the window; it must
    // get the same provisional index, not the id-derived guess.
    agg.step(ControlModeEvent::WindowRenamed {
        window_id: wid("@1"),
        name: "build".to_string(),
    });

    let w = agg.windows.get("@1").expect("window @1 created by rename");
    assert_eq!(w.index, 2);
    assert_eq!(w.name, "build");
}

/// A metadata-only change (window rename) must produce a delta carrying NO
/// pane content: untouched grids are Arc-shared between snapshots, so the
/// diff skips them by pointer identity instead of walking every cell — the
/// fix for "a one-field delta costs as much as a full sync".
#[test]
fn metadata_delta_shares_content_and_omits_grids() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    agg.windows
        .insert(wid("@0"), WindowState::new(wid("@0"), 0));
    agg.step(ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"hello world\r\n".to_vec(),
    });

    // First update is the full snapshot.
    assert!(matches!(
        agg.to_state_update(),
        Some(crate::StateUpdate::Full { .. })
    ));

    // Consecutive snapshots share one grid allocation (refcount bump,
    // not a per-cell deep copy).
    let s1 = agg.to_tmux_state();
    let s2 = agg.to_tmux_state();
    assert!(
        std::sync::Arc::ptr_eq(&s1.panes[0].content, &s2.panes[0].content),
        "unchanged pane content must be shared, not rebuilt"
    );

    // A rename-only change yields a delta with the window change and no
    // pane entries at all.
    agg.step(ControlModeEvent::WindowRenamed {
        window_id: wid("@0"),
        name: "renamed".to_string(),
    });
    match agg.to_state_update() {
        Some(crate::StateUpdate::Delta { delta }) => {
            assert!(
                delta.panes.is_none(),
                "rename must not resend or re-diff pane content"
            );
            let windows = delta.windows.expect("window delta present");
            let w = windows
                .get("@0")
                .expect("@0 in delta")
                .as_ref()
                .expect("modified, not removed");
            assert_eq!(w.name.as_deref(), Some("renamed"));
        }
        other => panic!("expected Delta, got {other:?}"),
    }
}

#[test]
fn list_windows_still_corrects_a_wrong_provisional_index() {
    // Provisional is just a good default for the gap; the authoritative
    // list-windows must always win (e.g. an insert-in-the-middle case).
    let mut agg = StateAggregator::new();
    agg.windows
        .insert(wid("@0"), WindowState::new(wid("@0"), 1));
    agg.step(ControlModeEvent::WindowAdd {
        window_id: wid("@1"),
    });
    assert_eq!(agg.windows.get("@1").unwrap().index, 2);

    // tmux reports @1 actually at index 5 — drive the correction through
    // the real parser (a list-windows line arriving as a command
    // response), not by hand-assigning the field.
    agg.process_event(ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        output: "@1,5,1,tab,,,,,,,,,,,shell".to_string(),
        success: true,
    });
    assert_eq!(
        agg.windows.get("@1").unwrap().index,
        5,
        "authoritative list-windows index must overwrite the provisional"
    );
}
