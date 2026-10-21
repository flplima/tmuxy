use super::tests::*;
use super::tests_panes::list_panes_line;
use super::*;
use crate::ids::test_ids::{gid, pid, wid};
use crate::WindowType;

#[test]
fn a_window_whose_index_moved_is_in_the_delta() {
    // move-window renumbers the windows behind the moved one; the strip
    // orders by index, so an index-only change must reach the client.
    let agg = StateAggregator::new();
    let before = crate::TmuxWindow {
        id: wid("@0"),
        index: 0,
        name: String::new(),
        active: false,
        window_type: None,
        float_parent: None,
        float_width: None,
        float_height: None,
        float_drawer: None,
        float_bg: None,
        float_noheader: false,
        sidebar_cols: None,
        sidebar_hidden: false,
        collapsible: false,
        zoomed: false,
        active_pane_id: None,
        pane_tree: None,
    };
    let mut after = before.clone();
    after.index = 3;
    after.active_pane_id = Some(pid("%7"));
    let delta = agg.compute_window_delta(&before, &after);
    assert_eq!(delta.index, Some(3));
    assert_eq!(delta.active_pane_id, Some(Some(pid("%7"))));
    assert!(!delta.is_empty());
    assert!(agg.compute_window_delta(&before, &before).is_empty());
}

#[test]
fn list_windows_carries_the_dock_rows_and_sizing_uses_them() {
    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@4,5,0,sidebar-right,,,,,,,,35,,,0,52,__sidebar-right");
    let w = agg.windows.get("@4").expect("window parsed");
    assert_eq!(w.sidebar_rows, Some(52));
    assert_eq!(w.name, "__sidebar-right");
    let (_, sidebars) = agg.window_ids_by_sizing();
    assert_eq!(sidebars, vec![(wid("@4"), 35, Some(52))]);
    // A row without the trailing column: the name is still the last field.
    agg.parse_list_windows_line("@4,5,0,sidebar-right,,,,,,,,35,,,0,__sidebar-right");
    let w = agg.windows.get("@4").expect("window parsed");
    assert_eq!(w.sidebar_rows, None);
    assert_eq!(w.name, "__sidebar-right");
}

#[test]
fn list_windows_carries_the_sidebar_hidden_flag() {
    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@4,5,0,sidebar-right,,,,,,,,35,1,,0,__sidebar-right");
    let w = agg.windows.get("@4").expect("window parsed");
    assert_eq!(w.window_type, Some(WindowType::SidebarRight));
    assert_eq!(w.sidebar_cols, Some(35));
    assert!(w.sidebar_hidden);
    assert_eq!(w.name, "__sidebar-right");

    agg.parse_list_windows_line("@4,5,0,sidebar-right,,,,,,,,35,,,0,__sidebar-right");
    assert!(!agg.windows.get("@4").expect("window parsed").sidebar_hidden);
}

/// The group id rides in the final `list-panes` tail field.
/// SEC-18. The `__TMUXY_WIDGET__:` marker is pane OUTPUT, so the client
/// needs something the output cannot forge before it replaces a pane with
/// a widget. `tmuxy-widget` writes this option; the marker alone means
/// nothing.
#[test]
fn list_panes_reads_the_widget_authorisation_tail() {
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,bash,,0,0,0,0,@4, ,0,0,0,0,0,0,100,,,,,tree,");
    assert_eq!(
        agg.panes
            .get("%3")
            .expect("pane parsed")
            .pane_widget
            .as_deref(),
        Some("tree")
    );
}

#[test]
fn list_panes_leaves_an_untagged_pane_unauthorised_for_any_widget() {
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line("zsh", "@4", ""));
    assert_eq!(agg.panes.get("%3").expect("pane parsed").pane_widget, None);
}

#[test]
fn list_panes_reads_the_group_position_and_a_restore_line_with_commas() {
    let mut agg = StateAggregator::new();
    // tail: alt,mouse,marked,sel,sx,sy,hist,gid,pos,state,ask,widget,restore
    agg.parse_list_panes_line(
        "%3,0,0,0,80,24,0,0,1,zsh,t,0,0,0,0,@4,,0,0,0,0,0,0,100,g5,2,idle,,,claude --resume x%2C y",
    );
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.group_id, Some(gid("g5")));
    assert_eq!(pane.group_pos, Some(2));
    assert_eq!(pane.pane_state.as_deref(), Some("idle"));
    assert_eq!(pane.pane_restore.as_deref(), Some("claude --resume x, y"));
    assert_eq!(pane.history_size, 100);
}

#[test]
fn list_panes_parses_group_id() {
    let mut agg = StateAggregator::new();
    // id,idx,x,y,w,h,cx,cy,active,cmd,title,in_mode,cx,cy,scroll,WIN,BORDER,alt,mouse,marked,sel,sx,sy,hist,GID,POS,STATE,ASK,WIDGET,RESTORE
    agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,zsh,vis,0,0,0,0,@4,,0,0,0,0,0,0,100,g5,,,,,");
    assert_eq!(
        agg.panes.get("%3").expect("pane parsed").group_id.clone(),
        Some(gid("g5"))
    );

    // Empty tail → no group.
    agg.parse_list_panes_line("%4,0,0,0,80,24,0,0,1,zsh,plain,0,0,0,0,@4,,0,0,0,0,0,0,100,,,,,,");
    assert_eq!(agg.panes.get("%4").expect("pane parsed").group_id, None);
}

/// A `stashmember,` block rebuilds hidden members without conjuring real
/// panes or windows into the active-session plane.
#[test]
fn stash_block_does_not_create_real_panes() {
    let mut agg = StateAggregator::new();
    agg.handle_command_response("stashmember,%7,@9,g5,,vim,editing");
    assert!(
        agg.panes.is_empty(),
        "stash rows must not become real panes"
    );
    assert!(agg.windows.is_empty(), "stash rows must not become windows");
    assert_eq!(agg.stash_members.len(), 1);
}

/// A title announced over OSC 2 reaches the pane from its own output, with
/// no tmux round trip.
///
/// `pane_title` only comes back on a metadata sync or the 15-second idle
/// heartbeat, so the header kept showing the old title for as long as
/// fifteen seconds after a program renamed itself.
#[test]
fn an_osc_title_updates_the_pane_at_once() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");

    let (changed, _, _) = agg.handle_output(&pid("%0"), b"\x1b]2;My Process Title\x07");
    assert!(changed);
    assert_eq!(agg.panes.get("%0").expect("pane").title, "My Process Title");

    // OSC 0 sets icon AND title, so it counts too.
    agg.handle_output(&pid("%0"), b"\x1b]0;Second Title\x07");
    assert_eq!(agg.panes.get("%0").expect("pane").title, "Second Title");

    // OSC 1 is the icon name alone and must NOT rename the pane.
    agg.handle_output(&pid("%0"), b"\x1b]1;just-an-icon\x07");
    assert_eq!(agg.panes.get("%0").expect("pane").title, "Second Title");
}

/// A graphics probe read as a title is still not a title, on this path too.
#[test]
fn an_osc_graphics_probe_does_not_become_the_title() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    agg.handle_output(&pid("%0"), b"\x1b]2;Real Title\x07");
    agg.handle_output(&pid("%0"), b"\x1b]2;Ga=q,f=32,s=1,v=1,i=31;AAAAAA==\x07");
    assert_eq!(agg.panes.get("%0").expect("pane").title, "");
}

/// A parked member gets the same graphics-payload guard a visible pane
/// gets. It streams no content, so tmux's `pane_title` is the ONLY thing
/// its tab in the group strip has to show — which is exactly where a Kitty
/// graphics probe lands when tmux reads the APC as a title. The strip
/// labelled the member `Ga=q,f=32,s=1,…` while the visible pane running the
/// same program was labelled properly.
#[test]
fn a_parked_members_title_is_not_a_graphics_payload() {
    let mut agg = StateAggregator::new();
    agg.handle_command_response("stashmember,%7,@9,g5,,agy,Ga=q,f=32,s=1,v=1,i=31;AAAAAA==");
    let member = agg.stash_members.get("%7").expect("member parsed");
    assert_eq!(member.title, "");
    // ...and the process name is still there to fall back on.
    assert_eq!(member.command, "agy");
}

/// ...and a real title is still a real title, however it starts.
#[test]
fn a_parked_members_real_title_survives() {
    let mut agg = StateAggregator::new();
    agg.handle_command_response("stashmember,%7,@9,g5,,go,Go build ./...");
    assert_eq!(
        agg.stash_members.get("%7").expect("member parsed").title,
        "Go build ./..."
    );
}

/// Hidden members are emitted as stubs only for groups that still have a
/// visible member; orphans (no visible pane) are pruned.
#[test]
fn stash_members_emit_stubs_only_for_active_groups() {
    let mut agg = StateAggregator::new();
    // Visible member of g5 in window @4.
    agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,zsh,vis,0,0,0,0,@4,,0,0,0,0,0,0,100,g5,,,,,");
    // Hidden member of g5, plus an orphan in g6 (no visible member).
    agg.handle_command_response(
        "stashmember,%7,@9,g5,,vim,hidden-title\nstashmember,%8,@9,g6,,top,orphan",
    );

    let state = agg.to_tmux_state();
    let ids: Vec<&str> = state.panes.iter().map(|p| p.tmux_id.as_str()).collect();
    assert!(ids.contains(&"%3"), "visible member emitted");
    assert!(
        ids.contains(&"%7"),
        "hidden member of an active group emitted"
    );
    assert!(!ids.contains(&"%8"), "orphan pruned");

    let stub = state
        .panes
        .iter()
        .find(|p| p.tmux_id == "%7")
        .expect("stub");
    assert_eq!(stub.group_id, Some(gid("g5")));
    assert_eq!(
        stub.window_id, "@9",
        "stub keeps its stash window id (never the active one)"
    );
    assert_eq!(stub.title, "hidden-title");
}

/// An untagged window (a native `tmux neww` / foreign window) carries no
/// `@tmuxy-window-type` marker but still surfaces as a tab, and the setup
/// pass enforces its pane border without tagging it.
#[test]
fn untagged_window_is_a_tab_and_gets_only_border_enforcement() {
    let mut agg = StateAggregator::new();
    // @id,index,active,type(empty),float*,zoomed,name
    agg.parse_list_windows_line("@5,0,1,,,,,,,,,,,,0,shell");

    let cmds = agg.collect_window_tag_commands();
    assert!(
        cmds.iter().any(|c| c.contains("pane-border-status top")),
        "tab needs pane-border enforcement: {cmds:?}"
    );
    assert!(
        !cmds.iter().any(|c| c.contains("@tmuxy-window-type")),
        "a tab must never be tagged: {cmds:?}"
    );
    // Idempotent — already enforced, so nothing new.
    assert!(agg.collect_window_tag_commands().is_empty());

    // Emitted as a tab despite carrying no marker.
    let state = agg.to_tmux_state();
    let w = state.windows.iter().find(|w| w.id == "@5").expect("window");
    assert_eq!(w.window_type, Some(WindowType::Tab));
}

/// What the resize pass judges itself against. A pane row carries the
/// pane's own box; the window's grid is one past the furthest edge, the
/// same extent the frontend computes in `gridExtent`.
#[test]
fn window_extent_is_one_past_the_furthest_pane_edge() {
    // id,idx,x,y,w,h,... — two panes split side by side in @1, and one
    // pane of another window that must not count towards it.
    let row = |id: &str, x: u32, y: u32, w: u32, h: u32, win: &str| {
        format!("{id},0,{x},{y},{w},{h},0,0,1,zsh,t,0,0,0,0,{win},,0,0,0,0,0,0,100,,,,,,")
    };
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&row("%1", 0, 1, 80, 49, "@1"));
    agg.parse_list_panes_line(&row("%2", 81, 1, 119, 49, "@1"));
    agg.parse_list_panes_line(&row("%3", 0, 1, 200, 20, "@2"));

    assert_eq!(agg.window_extent(&wid("@1")), Some((200, 50)));
    assert_eq!(agg.window_extent(&wid("@2")), Some((200, 21)));
}

/// Before any pane of a window has been seen there is no extent — which is
/// not the same as a zero-sized window, and must not read as "already the
/// size we want".
#[test]
fn window_extent_is_none_for_a_window_with_no_panes() {
    let agg = StateAggregator::new();
    assert_eq!(agg.window_extent(&wid("@9")), None);
}
