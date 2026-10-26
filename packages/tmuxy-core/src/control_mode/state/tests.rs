use super::*;
use crate::ids::test_ids::{pid, wid};
use crate::TmuxPane;

/// A program that hid its cursor long before a capture refill keeps it
/// hidden after one: the refill rebuilds the parser, and capture-pane
/// replays the screen, not the modes.
#[test]
fn a_capture_refill_keeps_a_hidden_cursor_hidden() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    pane.process_output(b"\x1b[?25lhello");
    assert!(pane.cursor_hidden);
    pane.reset_and_process_capture(b"hello");
    assert!(
        pane.terminal.screen().hide_cursor(),
        "the rebuilt parser lost the hidden cursor"
    );
}

/// A program that redraws a picture on SIGWINCH is in the
/// middle of writing a frame when the resize reaches the pane. Dropping the
/// half already read left vt100 printing the rest of the base64 as text,
/// over the rows the picture was meant to cover.
#[test]
fn a_resize_mid_frame_does_not_spill_the_frame_as_text() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    pane.process_output(b"\x1b]1337;File=inline=1;width=20;height=5:iVBORw0K");
    pane.resize(30, 10);
    pane.process_output(b"GgoAAAANSUhEUg==\x07");

    let content = pane.get_content();
    let text: String = content
        .iter()
        .flat_map(|row| row.iter().map(|c| c.char.clone()))
        .collect();
    assert!(
        !text.contains("GgoAAAANSUhEUg"),
        "the frame's tail reached the grid as text: {text:?}"
    );
    assert_eq!(
        pane.image_parser.placements.len(),
        1,
        "the frame was placed"
    );
}

#[test]
fn inline_images_scroll_with_content_and_survive_primary_screen_resize() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    // Preceding text in the same chunk advances the cursor to row 2 before
    // the image is placed, and trailing newlines scroll the 10-row screen.
    pane.process_output(
        b"line0\r\nline1\r\n\x1b]1337;File=inline=1;width=10;height=3:iVBORw0KGgo=\x07",
    );
    assert_eq!(pane.image_parser.placements.len(), 1);
    assert_eq!(pane.image_parser.placements[0].row, 2);

    // Scrolling the pane by 5 lines (7 newlines reach row 9 + 5 scroll) shifts
    // the placement from row 2 to row -3 (into scrollback history).
    for _ in 0..12 {
        pane.process_output(b"\r\n");
    }
    assert_eq!(pane.image_parser.placements.len(), 1);
    assert_eq!(pane.image_parser.placements[0].row, -3);

    // Zooming/resizing on the primary screen preserves placements.
    pane.resize(80, 24);
    assert_eq!(
        pane.image_parser.placements.len(),
        1,
        "primary-screen placement must survive pane zoom/resize"
    );

    // On the alternate screen, resize clears placements so the full-screen
    // application's SIGWINCH redraw starts clean.
    pane.process_output(b"\x1b[?1049h\x1b]1337;File=inline=1;width=10;height=3:iVBORw0KGgo=\x07");
    assert_eq!(pane.image_parser.placements.len(), 1);
    pane.resize(40, 10);
    assert!(
        pane.image_parser.placements.is_empty(),
        "alt-screen placement is retired on resize"
    );
    // Leaving the alternate screen restores the primary-screen placement.
    pane.process_output(b"\x1b[?1049l");
    assert_eq!(pane.image_parser.placements.len(), 1);
    assert_eq!(pane.image_parser.placements[0].row, -3);
}

/// A capture rebuilds the screen from what tmux shows now; the rows that
/// scrolled off before are kept, so a later reflow still has them to pull
/// back down.
#[test]
fn a_capture_keeps_the_history_that_scrolled_off_before_it() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    for n in 0..80 {
        pane.process_output(format!("line {n}\r\n").as_bytes());
    }
    let (_, before) = pane.scrollback_cells(-1, -1);
    assert!(
        before >= 70,
        "80 lines on a 10-row screen leave history: {before}"
    );

    pane.reset_and_process_capture(
        b"line 71\nline 72\nline 73\nline 74\nline 75\nline 76\nline 77\nline 78\nline 79\n",
    );

    let (rows, after) = pane.scrollback_cells(-3, -1);
    assert_eq!(
        after, before,
        "the capture replaced the screen, not the history"
    );
    let text: String = rows[0].iter().map(|c| c.char.clone()).collect();
    assert!(
        text.starts_with("line "),
        "the rows above the screen are still the lines that scrolled off: {text:?}"
    );
}

/// A range that starts below `i64::MIN`'s negation reads as much history as
/// exists instead of overflowing.
#[test]
fn a_scrollback_range_from_i64_min_reads_all_history() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    for n in 0..30 {
        pane.process_output(format!("line {n}\r\n").as_bytes());
    }
    let (rows, depth) = pane.scrollback_cells(i64::MIN, -1);
    assert_eq!(rows.len(), depth, "every history row, once");
}

/// The geometry walk over `layout::parse` yields the same panes, in the
/// same order, as the parser it replaced (output captured from the old
/// one before it was deleted). Only the body is passed: the call sites
/// strip the checksum first.
#[test]
fn layout_panes_match_the_previous_parser() {
    fn dump(layout: &str) -> Vec<(String, u32, u32, u32, u32, u32)> {
        parse_layout_panes(layout)
            .iter()
            .map(|p| (p.id.to_string(), p.index, p.x, p.y, p.width, p.height))
            .collect()
    }
    let nested = "200x50,0,0{100x50,0,0,1,99x50,101,0[99x25,101,0,2,99x24,101,26{49x24,101,26,3,49x24,151,26,4}]}";
    assert_eq!(
        dump(nested),
        vec![
            ("%1".to_string(), 1, 0, 0, 100, 50),
            ("%2".to_string(), 2, 101, 0, 99, 25),
            ("%3".to_string(), 3, 101, 26, 49, 24),
            ("%4".to_string(), 4, 151, 26, 49, 24),
        ]
    );
    assert_eq!(
        dump("80x24,0,0,7"),
        vec![("%7".to_string(), 7, 0, 0, 80, 24)]
    );
    assert_eq!(
        dump("80x24,0,0[80x11,0,0,1,80x12,0,12,2]"),
        vec![
            ("%1".to_string(), 1, 0, 0, 80, 11),
            ("%2".to_string(), 2, 0, 12, 80, 12),
        ]
    );
    assert!(dump("garbage").is_empty());
}

/// A pane as the client sees it, placed in window `@0`.
pub(super) fn tmux_pane(id: &str) -> TmuxPane {
    let mut pane = PaneState::new(pid(id), 80, 24);
    pane.window_id = Some(wid("@0"));
    pane.build_tmux_pane().expect("placed")
}

/// Manually seat a pane in the aggregator so handle_output() processes it
/// (handle_output rejects panes that haven't been seen in list-panes).
pub(super) fn seed_pane(agg: &mut StateAggregator, pane_id: &str, window_id: &str) {
    let mut pane = PaneState::new(pid(pane_id), 80, 24);
    pane.window_id = Some(wid(window_id));
    agg.panes.insert(pid(pane_id), pane);
}

/// Seed a pane and make it the one a keystroke would reach — what the
/// clipboard gate asks about.
pub(super) fn seed_active_pane(agg: &mut StateAggregator, pane_id: &str, window_id: &str) {
    seed_pane(agg, pane_id, window_id);
    let mut window = WindowState::new(wid(window_id), 0);
    window.active_pane_id = Some(pid(pane_id));
    agg.windows.insert(wid(window_id), window);
    agg.active_window_id = Some(wid(window_id));
}

/// A version-pinned launcher must not name the pane after its version.
///
/// `#{pane_current_command}` is the resolved executable's file name, so
/// Claude Code — installed as `.../claude/versions/<version>` — reports
/// `2.1.280`. Every surface that names a pane by its command showed that.
#[test]
fn a_bare_version_command_is_named_claude() {
    assert_eq!(normalize_pane_command("2.1.280"), "claude");
    assert_eq!(normalize_pane_command("0.9"), "claude");

    // Anything a real executable is plausibly called stays untouched,
    // including names that merely contain digits or a single dot.
    for command in [
        "zsh", "nvim", "python3", "node", "a.out", "2", "1.2.x", "v1.2.3", "",
    ] {
        assert_eq!(normalize_pane_command(command), command);
    }
}

/// The grid the client sizes itself against is the active window's, not
/// the tallest window in the session. A hidden window at another size
/// (a group member, a float, a tab left behind by an older viewport) used
/// to inflate the total, and the client — never seeing the size it asked
/// for — kept requesting a resize and never re-enabled its animations.
#[test]
fn the_grid_size_is_the_active_windows_extent() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    let mut tall = PaneState::new(pid("%3"), 35, 43);
    tall.window_id = Some(wid("@3"));
    agg.panes.insert(pid("%3"), tall);
    agg.active_window_id = Some(wid("@0"));

    let state = agg.to_tmux_state();
    assert_eq!((state.total_width, state.total_height), (80, 24));

    // No active window known yet: any pane is better than none.
    agg.active_window_id = None;
    let state = agg.to_tmux_state();
    assert_eq!((state.total_width, state.total_height), (80, 43));
}

/// Empty command acks MUST keep reporting a Full change.
///
/// This pins the revert of an attempted optimization (empty acks →
/// `ChangeType::None`): the frontend's pane-group swap convergence rides
/// on ack-driven emissions, and silencing them routed the first
/// post-click keystroke to the stale pane (7-regression group-click
/// E2E). Do not silence empty acks until command completions are
/// marker-routed and can be classified exactly.
#[test]
fn empty_command_ack_still_emits_full_change() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");

    let r = agg.process_event(ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        output: String::new(),
        success: true,
    });
    assert!(r.state_changed, "empty ack must still emit");
    assert!(matches!(r.change_type, ChangeType::Full));
}

/// Arbitrary command output must not be mistaken for list-panes records.
///
/// `RunCommand` output flows through the same response channel, so a line
/// that merely contains a `%` and a comma used to be fed to the pane
/// parser and could conjure ghost panes.
#[test]
fn non_list_panes_output_does_not_create_panes() {
    let mut agg = StateAggregator::new();
    let before = agg.panes.len();

    agg.process_event(ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        // Shapes that pass the old `contains('%') && contains(',')` sniff.
        output: "100% done, thanks\ncpu: 3%, mem: 40%\n[%foo,bar]".to_string(),
        success: true,
    });

    assert_eq!(agg.panes.len(), before, "no ghost panes may be created");
}

pub(super) fn response(output: &str, success: bool) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success,
    }
}

/// A reply-wrapped command's blocks come back whole, to the caller only.
#[test]
fn reply_markers_collect_the_blocks_between_them() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");

    let lines = reply_wrapped_lines(7, "display-message -p HELLO");
    assert!(lines[0].contains("TMUXY_RPY_BEGIN 7"));
    assert_eq!(lines[1], "display-message -p HELLO");
    assert!(lines[2].contains("TMUXY_RPY_END 7"));

    let begin = agg.step(response("TMUXY_RPY_BEGIN 7\n", true));
    assert!(
        begin.effects.is_empty(),
        "the BEGIN marker is not an emission"
    );
    let body = agg.step(response("HELLO\n", true));
    assert!(
        body.effects.is_empty(),
        "a collected block is not an emission"
    );
    let end = agg.step(response("TMUXY_RPY_END 7\n", true));

    assert!(
        matches!(
            &end.effects[..],
            [SideEffect::CommandReply { id: 7, output, error: None }] if output == "HELLO\n"
        ),
        "got {:?}",
        end.effects
    );
}

/// A command list answers one block per command, each without its last
/// newline (that is how the parser hands blocks over): the reply keeps
/// them on separate lines, or the first command's last line would run
/// into the second's first.
#[test]
fn a_command_lists_blocks_stay_on_their_own_lines() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    agg.step(response("TMUXY_RPY_BEGIN 9", true));
    agg.step(response("C-a", true));
    agg.step(response("", true));
    agg.step(response("bind-key -T prefix Space next-layout", true));
    let end = agg.step(response("TMUXY_RPY_END 9", true));
    assert!(
        matches!(
            &end.effects[..],
            [SideEffect::CommandReply { id: 9, output, error: None }]
                if output == "C-a\nbind-key -T prefix Space next-layout"
        ),
        "got {:?}",
        end.effects
    );
}

/// tmux stops a list at its first `%error`; the END marker is its own
/// line so it still arrives, and the reply reports the failure.
#[test]
fn a_failed_block_fails_the_reply_and_still_closes_it() {
    let mut agg = StateAggregator::new();
    agg.step(response("TMUXY_RPY_BEGIN 3\n", true));
    agg.step(response("can't find window: @999\n", false));
    let end = agg.step(response("TMUXY_RPY_END 3\n", true));
    assert!(
        matches!(
            &end.effects[..],
            [SideEffect::CommandReply { id: 3, error: Some(msg), .. }]
                if msg == "can't find window: @999"
        ),
        "the reply carries tmux's message: {:?}",
        end.effects
    );
}

/// The reason replies are routed by marker: a `list-panes -a` query
/// prints rows shaped exactly like the aggregator's own poll, and those
/// rows must never be taken for this session's panes.
#[test]
fn a_query_between_markers_never_reaches_the_pane_parser() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    let before = agg.panes.len();

    agg.step(response("TMUXY_RPY_BEGIN 9\n", true));
    // Two rows in LIST_PANES_CMD shape for panes of some other session.
    let rows = "%40,0,0,0,80,24,0,0,1,zsh,,0,0,0,0,@20,,0,0,0,0,0,10\n\
                    %41,1,0,0,80,24,0,0,0,zsh,,0,0,0,0,@20,,0,0,0,0,0,10\n";
    let body = agg.step(response(rows, true));
    let end = agg.step(response("TMUXY_RPY_END 9\n", true));

    assert_eq!(agg.panes.len(), before, "query rows must not become panes");
    assert!(
        body.effects.is_empty(),
        "no state emission for a collected block"
    );
    assert!(matches!(
        &end.effects[..],
        [SideEffect::CommandReply { id: 9, output, error: None }] if output.contains("%41,")
    ));
}

/// An END for a different id than the one in flight: the older reply is
/// lost (fail it), and the newer one must not inherit its output.
#[test]
fn a_mismatched_end_marker_fails_the_stale_reply() {
    let mut agg = StateAggregator::new();
    agg.step(response("TMUXY_RPY_BEGIN 1\n", true));
    agg.step(response("old\n", true));
    let end = agg.step(response("TMUXY_RPY_END 2\n", true));
    assert!(matches!(
        &end.effects[..],
        [SideEffect::CommandReply {
            id: 1,
            error: Some(_),
            ..
        }]
    ));
    assert!(agg.reply_in_flight.is_none());
}

/// Unmarked responses keep today's behaviour: they fall through to the
/// pane/window parsers and report a Full change.
#[test]
fn unmarked_responses_still_fall_through() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    let r = agg.step(response("", true));
    assert!(r.effects.iter().any(|e| matches!(
        e,
        SideEffect::EmitState {
            change: ChangeType::Full
        }
    )));
}

#[test]
fn is_list_panes_line_matches_only_real_pane_records() {
    assert!(is_list_panes_line("%0,1,0,0,80,24"));
    assert!(is_list_panes_line("%12,3,"));
    assert!(!is_list_panes_line("100% done, thanks"));
    assert!(!is_list_panes_line("%foo,bar"));
    assert!(!is_list_panes_line("%0"));
    assert!(!is_list_panes_line("x%0,1"));
    assert!(!is_list_panes_line(""));
}

#[test]
fn kitty_tmux_passthrough_placeholders_render_as_an_image() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    let b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        b"\x89PNG\r\n\x1a\n",
    );
    let apc = format!("\x1b_Ga=T,U=1,f=100,i=42,c=2,r=2;{b64}\x1b\\");
    let passthrough = format!("\x1bPtmux;{}\x1b\\", apc.replace('\x1b', "\x1b\x1b"));
    pane.process_output(passthrough.as_bytes());
    pane.process_output(
        "\x1b[38;2;0;0;42m\u{10eeee}\u{0305}\u{0305}\u{10eeee}\u{0305}\u{030d}\r\n\
         \u{10eeee}\u{030d}\u{0305}\u{10eeee}\u{030d}\u{030d}\x1b[39m"
            .as_bytes(),
    );

    let content = pane.get_content();
    let text: String = content
        .iter()
        .flat_map(|row| row.iter().map(|cell| cell.char.clone()))
        .collect();
    assert!(
        !text.contains('\u{10eeee}'),
        "placeholders stay out of text"
    );
    assert_eq!(pane.image_parser.placements.len(), 1);
    let placement = &pane.image_parser.placements[0];
    assert_eq!((placement.row, placement.col), (0, 0));
    assert_eq!((placement.width_cells, placement.height_cells), (2, 2));
    assert!(pane.image_store.contains_key(&placement.id));
}
