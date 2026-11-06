use super::tests::*;
use super::*;
use crate::constants::tmux_formats::{TmuxList, WindowColumn};
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
    agg.parse_list_windows_line(
        &window_row("@1", 0, true, "shell")
            .set(WindowColumn::WindowType, "tab")
            .build(),
    );
    agg.parse_list_windows_line(
        &window_row("@2", 1, false, "float")
            .set(WindowColumn::WindowType, "float")
            .build(),
    );
    agg.parse_list_windows_line(
        &window_row("@3", 2, false, "tree")
            .set(WindowColumn::WindowType, "sidebar-left")
            .build(),
    );
    agg.parse_list_windows_line(
        &window_row("@4", 3, false, "term")
            .set(WindowColumn::WindowType, "sidebar-right")
            .build(),
    );

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
    agg.parse_list_windows_line(
        &window_row("@3", 2, false, "tree")
            .set(WindowColumn::WindowType, "sidebar-left")
            .set(WindowColumn::SidebarCols, "48")
            .build(),
    );
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
    agg.parse_list_windows_line(
        &window_row("@4", 2, false, "side")
            .set(WindowColumn::Collapsible, "0")
            .build(),
    );
    let adopted = agg.collect_window_tag_commands();
    assert!(
        adopted
            .iter()
            .any(|c| c == "set-option -w -t @4 pane-border-status top"),
        "an untyped new window is adopted as a tab: {adopted:?}"
    );

    // The list-windows response carries the marker the create command set.
    agg.parse_list_windows_line(
        &window_row("@4", 2, false, "side")
            .set(WindowColumn::WindowType, "sidebar-right")
            .build(),
    );
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
    agg.parse_list_windows_line(
        &window_row("@4", 2, false, "__sidebar-left")
            .set(WindowColumn::WindowType, "sidebar-left")
            .build(),
    );
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
    mark_initial_sync_done(&mut agg);
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
    // the real parser (the aggregator's own list-windows, answered), not by
    // hand-assigning the field.
    listed(
        &mut agg,
        TmuxList::Windows,
        &window_row("@1", 5, true, "shell")
            .set(WindowColumn::WindowType, "tab")
            .build(),
    );
    assert_eq!(
        agg.windows.get("@1").unwrap().index,
        5,
        "authoritative list-windows index must overwrite the provisional"
    );
}

/// The stream opens with the picture `GetState` waits for. A state emitted
/// before the initial sync's lists and captures land has no panes, no
/// windows and no content: a client reconnecting to a restarted monitor had
/// its page blanked by it until the deltas and captures landed.
#[test]
fn the_first_emission_waits_for_the_initial_sync_and_its_captures() {
    let mut agg = StateAggregator::new();
    assert!(agg.to_state_update().is_none(), "nothing to show yet");

    // list-panes lists a new pane, which asks for its capture; list-windows
    // follows. Neither is the whole picture while that capture is in flight.
    let panes = listed(&mut agg, TmuxList::Panes, &pane_row("%0", "@0", false));
    assert!(
        panes.effects.iter().any(
            |e| matches!(e, SideEffect::RefreshPanes { pane_ids } if pane_ids == &[pid("%0")])
        ),
        "a new pane is captured ({:?})",
        panes.effects
    );
    agg.queue_captures(&[pid("%0")]);
    assert!(
        agg.to_state_update().is_none(),
        "panes listed, capture pending"
    );
    listed(
        &mut agg,
        TmuxList::Windows,
        &window_row("@0", 0, true, "shell")
            .set(WindowColumn::WindowType, "tab")
            .build(),
    );
    assert!(
        agg.to_state_update().is_none(),
        "windows listed, capture pending"
    );

    // The capture lands: the first emission is a Full with the pane's content.
    agg.step(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0"), true));
    agg.step(response("hello\n", true));
    agg.step(response(&marked(&agg, CAPTURE_END_MARKER, ""), true));
    match agg.to_state_update() {
        Some(crate::StateUpdate::Full { state }) => {
            assert_eq!(state.seq, 1);
            assert_eq!(state.windows.len(), 1);
            assert_eq!(state.panes.len(), 1);
            let first_row: String = state.panes[0].content[0]
                .iter()
                .map(|c| c.char.clone())
                .collect();
            assert_eq!(first_row.trim_end(), "hello");
        }
        other => panic!("expected the first emission to be a Full, got {other:?}"),
    }
}

/// A theme picked on another client reaches this one only through the theme
/// subscription: tmux announces no option change. Its value is the delta's
/// `theme_rev`, the same value again sends nothing, and a pane subscription
/// of the same shape is not mistaken for it.
#[test]
fn a_theme_picked_anywhere_rides_the_next_delta() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    agg.windows
        .insert(wid("@0"), WindowState::new(wid("@0"), 0));
    mark_initial_sync_done(&mut agg);
    assert!(matches!(
        agg.to_state_update(),
        Some(crate::StateUpdate::Full { .. })
    ));

    let theme = |value: &str| ControlModeEvent::SessionSubscriptionChanged {
        name: crate::constants::tmux_formats::THEME_SUBSCRIPTION_NAME.to_string(),
        value: value.to_string(),
    };
    agg.step(theme("nord:dark"));
    match agg.to_state_update() {
        Some(crate::StateUpdate::Delta { delta }) => {
            assert_eq!(delta.theme_rev.as_deref(), Some("nord:dark"));
        }
        other => panic!("expected Delta, got {other:?}"),
    }

    agg.step(theme("nord:dark"));
    assert!(
        agg.to_state_update().is_none(),
        "an unchanged theme sends nothing"
    );

    agg.step(ControlModeEvent::SessionSubscriptionChanged {
        name: "someone-else".to_string(),
        value: "gruvbox:light".to_string(),
    });
    assert!(agg.to_state_update().is_none());
    assert_eq!(agg.to_tmux_state().theme_rev.as_deref(), Some("nord:dark"));
}
