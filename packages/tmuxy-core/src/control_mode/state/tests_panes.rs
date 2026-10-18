use super::tests::*;
use super::*;
use crate::ids::test_ids::{pid, wid};
use crate::WindowType;

/// Build a LIST_PANES_CMD line with the given title and border_title, in the
/// exact field order of `constants::tmux_formats::LIST_PANES_CMD`.
pub(super) fn list_panes_line(title: &str, window_id: &str, border_title: &str) -> String {
    // group_id, pane_state, ask and widget (the last four tail fields) are
    // left empty here; each has its own test below.
    format!(
            // id,idx,x,y,w,h,cx,cy,active,command,TITLE,in_mode,copy_x,copy_y,scroll,WIN,BORDER,alt,mouse,marked,sel,sx,sy,hist,gid,pos,state,ask,widget,restore,url
            "%3,0,0,0,80,24,0,0,1,zsh,{title},0,0,0,0,{window_id},{border_title},0,0,0,0,0,0,100,,,,,,,"
        )
}

#[test]
fn list_panes_plain_title_parses_window_id() {
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line("nvim", "@4", ""));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.window_id, Some(wid("@4")));
    assert_eq!(pane.title, "nvim");
    assert_eq!(pane.history_size, 100);
}

#[test]
fn a_kitty_graphics_query_is_not_a_pane_title() {
    // What a pane running agy is called while it probes for graphics
    // support: tmux takes the unwrapped APC string for a title. The pane
    // keeps the process name instead of being named after a protocol.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line(
        "Ga=q,f=32,s=1,v=1,i=31;AAAAAA==",
        "@4",
        "",
    ));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.title, "");

    // A query with no payload is the same thing.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line("Ga=q,i=31", "@4", ""));
    assert_eq!(agg.panes.get("%3").expect("pane parsed").title, "");
}

#[test]
fn a_real_title_that_starts_with_g_is_kept() {
    // The guard above must not eat an application's own title, however it
    // starts — only the shape of a Kitty escape counts.
    for title in [
        "Go build ./...",
        "G",
        "Gemini",
        "Ga=q, and then some prose",
        "Gruvbox: colors=8",
    ] {
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line(&list_panes_line(title, "@4", ""));
        let pane = agg.panes.get("%3").expect("pane parsed");
        assert_eq!(
            pane.title, title,
            "{title} is a title, not a graphics payload"
        );
    }
}

#[test]
fn list_panes_parses_rows_captured_from_a_real_tmux() {
    // Verbatim `list-panes -s -F LIST_PANES_CMD` output from tmux 3.7c: one
    // pane whose app set no title (empty title field) and one that set a
    // comma-laden one over OSC 2. Unlike `list_panes_line`, this carries
    // tmux's real habit of leaving the copy-mode/selection numerics EMPTY
    // rather than zero — the anchor scan has to tolerate both around a
    // blank title.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line("%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,");
    agg.parse_list_panes_line(
        "%1,1,0,13,80,11,0,0,0,sleep,✳ Add tests, docs, and CI,0,,,,@0, ,0,0,0,,,,0,,,,,,",
    );

    let untitled = agg.panes.get("%0").expect("untitled pane parsed");
    assert_eq!(untitled.title, "", "no app title means an empty field");
    assert_eq!(untitled.window_id, Some(wid("@0")));
    assert_eq!(untitled.command, "sleep");

    let titled = agg.panes.get("%1").expect("titled pane parsed");
    assert_eq!(titled.title, "✳ Add tests, docs, and CI");
    assert_eq!(titled.window_id, Some(wid("@0")));
}

#[test]
fn list_panes_empty_title_keeps_fields_aligned() {
    // LIST_PANES_CMD asks tmux for the APP-SET title only, so a pane whose
    // app never set one arrives with an EMPTY title field. The anchor scan
    // must still find window_id rather than treating the blank as a shift.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line("", "@4", ""));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.window_id, Some(wid("@4")));
    assert_eq!(pane.title, "");
    assert_eq!(pane.command, "zsh");
    assert_eq!(pane.history_size, 100);
}

#[test]
fn list_panes_reads_the_pane_state_tail() {
    // The new tail field is counted from the END, like group_id, so the
    // free-text title and border in the middle can still carry commas.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(
        "%3,0,0,0,80,24,0,0,1,claude,,0,0,0,0,@4, ,0,0,0,0,0,0,100,,,needs-input,,,,",
    );
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.pane_state.as_deref(), Some("needs-input"));
    // The fields before it still land where they did.
    assert_eq!(pane.window_id, Some(wid("@4")));
    assert_eq!(pane.command, "claude");
    assert_eq!(pane.history_size, 100);
}

#[test]
fn list_panes_leaves_an_undeclared_pane_stateless() {
    // The common case: nothing set `@tmuxy-pane-state`, so the field
    // arrives empty. Empty must stay None rather than becoming an
    // empty-string state the client would have to special-case.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line("nvim", "@4", ""));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.pane_state, None);
}

#[test]
fn list_panes_reads_the_ask_tail() {
    // `tmuxy pane send -t` writes base64, so the payload is inert to the
    // comma-split even when the question itself is full of commas.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(
        "%3,0,0,0,80,24,0,0,1,zsh,,0,0,0,0,@4, ,0,0,0,0,0,0,100,,,,eyJ0b2tlbiI6ImExIn0=,,,",
    );
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.pane_ask.as_deref(), Some("eyJ0b2tlbiI6ImExIn0="));
    // The tail field before it is still read as its own.
    assert_eq!(pane.pane_state, None);
    assert_eq!(pane.history_size, 100);
}

#[test]
fn list_panes_leaves_an_unasked_pane_without_a_question() {
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line("nvim", "@4", ""));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.pane_ask, None);
}

#[test]
fn pane_delta_carries_a_changed_ask() {
    // The question appearing and being answered both have to reach the
    // client through the delta pass — the overlay is drawn from it.
    let agg = StateAggregator::new();
    let prev = tmux_pane("%3");
    let mut asking = prev.clone();
    asking.pane_ask = Some("eyJ0b2tlbiI6ImExIn0=".to_string());

    assert_eq!(
        agg.compute_pane_delta(&prev, &asking).pane_ask,
        Some(Some("eyJ0b2tlbiI6ImExIn0=".to_string()))
    );
    // Answering unsets the option, which must clear it on the client.
    assert_eq!(
        agg.compute_pane_delta(&asking, &prev).pane_ask,
        Some(None),
        "an answered question has to clear, not linger"
    );
    assert_eq!(agg.compute_pane_delta(&asking, &asking).pane_ask, None);
}

#[test]
fn pane_delta_carries_a_changed_pane_state() {
    // An agent moving from working to needs-input has to reach the client
    // through the delta pass, not just the initial snapshot.
    let agg = StateAggregator::new();
    let mut prev = tmux_pane("%3");
    prev.pane_state = Some("working".to_string());
    let mut curr = prev.clone();
    curr.pane_state = Some("needs-input".to_string());

    let delta = agg.compute_pane_delta(&prev, &curr);
    assert_eq!(delta.pane_state, Some(Some("needs-input".to_string())));

    // An agent clearing the option on exit clears it on the client too.
    let mut cleared = curr.clone();
    cleared.pane_state = None;
    let clearing = agg.compute_pane_delta(&curr, &cleared);
    assert_eq!(clearing.pane_state, Some(None));

    // ...and an unchanged pane puts nothing on the wire.
    assert_eq!(agg.compute_pane_delta(&curr, &curr).pane_state, None);
}

#[test]
fn pane_delta_carries_a_changed_title() {
    // A pane header shows the app's own title, so a title change has to
    // survive the delta pass — it used to be dropped, leaving the client
    // stuck on whatever title the initial snapshot carried.
    let agg = StateAggregator::new();
    let mut prev = tmux_pane("%3");
    prev.title = "old".to_string();
    let mut curr = prev.clone();
    curr.title = "✳ new title".to_string();

    let delta = agg.compute_pane_delta(&prev, &curr);
    assert_eq!(delta.title.as_deref(), Some("✳ new title"));

    let unchanged = agg.compute_pane_delta(&curr, &curr);
    assert_eq!(
        unchanged.title, None,
        "an unchanged title stays off the wire"
    );
}

#[test]
fn list_panes_title_with_commas_keeps_window_id() {
    // Regression: a pane title containing commas used to shift the
    // comma-split fields, parsing window_id as "" and blanking the tab.
    let title = "✳ Add Storybook, tests, PWA support and deploy Backstage";
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line(title, "@4", ""));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(
        pane.window_id,
        Some(wid("@4")),
        "window_id must survive a comma title"
    );
    assert_eq!(pane.title, title);
    assert_eq!(pane.scroll_position, 0);
    assert_eq!(pane.history_size, 100);
}

#[test]
fn list_panes_commas_in_both_title_and_border_title() {
    let title = "feat: a, b, c";
    let border = "x, y, z";
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&list_panes_line(title, "@9", border));
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert_eq!(pane.window_id, Some(wid("@9")));
    assert_eq!(pane.title, title);
    assert_eq!(pane.border_title, border);
    assert_eq!(pane.history_size, 100);
}

#[test]
fn list_windows_name_with_commas_keeps_fields_aligned() {
    // Regression: window_name is free text; placing it LAST (see
    // LIST_WINDOWS_CMD) means a name like "build, test" stays in the
    // trailing field and can't shift window_active/@tmuxy-window-type/floats.
    let name = "build, test";
    // @id,index,active,type,float_parent,fw,fh,drawer,bg,noheader,focus,cols,hidden,collapsible,zoomed,rows,name
    let line = format!("@7,3,1,tab,,,,,,,,,,,0,,{name}");
    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line(&line);
    let w = agg.windows.get("@7").expect("window parsed");
    assert_eq!(w.index, 3, "index must not be shifted by the comma name");
    assert_eq!(w.name, name);
    assert!(w.active);
    assert_eq!(w.window_type, Some(WindowType::Tab));
    assert!(!w.zoomed);
    assert_eq!(agg.active_window_id, Some(wid("@7")));
}

/// Zoom has to come from `list-windows`, not only from `%layout-change`
/// flags: window state is rebuilt from list-windows on every fresh client
/// connect, which is exactly when a client attaching to an already-zoomed
/// window would otherwise render it un-zoomed.
#[test]
fn list_windows_carries_the_zoom_flag() {
    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@9,2,1,tab,,,,,,,,,,,1,editor");
    assert!(agg.windows.get("@9").expect("window parsed").zoomed);

    // ...and clears it again when the window is no longer zoomed.
    agg.parse_list_windows_line("@9,2,1,tab,,,,,,,,,,,0,editor");
    assert!(!agg.windows.get("@9").expect("window parsed").zoomed);
}

/// A closed sidebar column keeps its window (the dock's shell survives a
/// close), so "hidden" has to travel as its own flag — read from the same
/// poll as the width, and cleared when the option is unset.
#[test]
fn a_collapsible_window_keeps_only_the_active_row_expanded() {
    let mut agg = StateAggregator::new();
    agg.parse_list_windows_line("@1,0,1,tab,,,,,,,,,,1,0,shell");
    // Three stacked rows, the middle one active.
    let layout = "0000,80x32,0,0[80x10,0,0,1,80x10,0,11,2,80x10,0,22,3]";
    let r = agg.process_event(ControlModeEvent::LayoutChange {
        window_id: wid("@1"),
        layout: layout.into(),
        visible_layout: layout.into(),
        flags: String::new(),
    });
    assert!(
        r.commands.is_empty(),
        "no active pane known yet: nothing to reshape"
    );

    let r = agg.process_event(ControlModeEvent::WindowPaneChanged {
        window_id: wid("@1"),
        pane_id: pid("%2"),
    });
    assert_eq!(r.commands.len(), 1);
    assert!(r.commands[0].starts_with("select-layout -t @1 '"));
    let sent = r.commands[0]
        .trim_start_matches("select-layout -t @1 '")
        .trim_end_matches('\'');
    // The top row asks for two: one of them is the status line tmux draws
    // on a pane's top border, which for that row comes out of the pane.
    assert_eq!(
        crate::layout::first_level_heights(sent),
        Some(vec![2, 27, 1])
    );

    // tmux applies it and reports the new layout: already in shape, no echo.
    let r = agg.process_event(ControlModeEvent::LayoutChange {
        window_id: wid("@1"),
        layout: sent.to_string(),
        visible_layout: sent.to_string(),
        flags: String::new(),
    });
    assert!(r.commands.is_empty());

    // The flag drops: the rows are evened back out on the next poll.
    agg.parse_list_windows_line("@1,0,1,tab,,,,,,,,,,,0,shell");
    let cmds = agg.collapsible_layout_commands(None);
    assert_eq!(cmds.len(), 1);
    let sent = cmds[0]
        .trim_start_matches("select-layout -t @1 '")
        .trim_end_matches('\'');
    assert_eq!(
        crate::layout::first_level_heights(sent),
        Some(vec![10, 10, 10])
    );
}
