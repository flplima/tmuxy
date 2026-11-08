use super::test_pane::sent;
use super::*;
use crate::constants::tmux_formats::{PaneColumn, RowBuilder, TmuxList, WindowColumn};
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
    pane.apply_capture(b"hello");
    pane.process_output(b"!");
    assert!(
        sent(&mut pane).cursor_hidden,
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
    assert_eq!(sent(&mut pane).images.len(), 1, "the frame was placed");
}

#[test]
fn inline_images_scroll_with_content_and_survive_primary_screen_resize() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    // Preceding text in the same chunk advances the cursor to row 2 before
    // the image is placed, and trailing newlines scroll the 10-row screen.
    pane.process_output(
        b"line0\r\nline1\r\n\x1b]1337;File=inline=1;width=10;height=3:iVBORw0KGgo=\x07",
    );
    assert_eq!(sent(&mut pane).images.len(), 1);
    assert_eq!(sent(&mut pane).images[0].row, 2);

    // Scrolling the pane by 5 lines (7 newlines reach row 9 + 5 scroll) shifts
    // the placement from row 2 to row -3 (into scrollback history).
    for _ in 0..12 {
        pane.process_output(b"\r\n");
    }
    assert_eq!(sent(&mut pane).images.len(), 1);
    assert_eq!(sent(&mut pane).images[0].row, -3);

    pane.resize(80, 24);
    assert_eq!(
        sent(&mut pane).images.len(),
        1,
        "primary-screen placement must survive pane zoom/resize"
    );

    // On the alternate screen, resize clears placements so the full-screen
    // application's SIGWINCH redraw starts clean.
    pane.process_output(b"\x1b[?1049h\x1b]1337;File=inline=1;width=10;height=3:iVBORw0KGgo=\x07");
    assert_eq!(sent(&mut pane).images.len(), 1);
    pane.resize(40, 10);
    assert!(
        sent(&mut pane).images.is_empty(),
        "alt-screen placement is retired on resize"
    );
    // Leaving the alternate screen restores the primary-screen placement.
    pane.process_output(b"\x1b[?1049l");
    assert_eq!(sent(&mut pane).images.len(), 1);
    assert_eq!(sent(&mut pane).images[0].row, -3);
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

    pane.apply_capture(
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

/// A pane seated in `window_id`, as if list-panes had placed it: output for
/// an unplaced pane is not processed.
pub(super) fn seed_pane(agg: &mut StateAggregator, pane_id: &str, window_id: &str) {
    let mut pane = PaneState::new(pid(pane_id), 80, 24);
    pane.window_id = Some(wid(window_id));
    agg.panes.insert(pid(pane_id), pane);
}

/// Stand in for the initial sync's list-panes and list-windows replies, so a
/// hand-seeded aggregator may emit (its first emission waits for them).
pub(super) fn mark_initial_sync_done(agg: &mut StateAggregator) {
    agg.panes_synced = true;
    agg.windows_synced = true;
}

/// A list-panes row as tmux prints one: `pane_id` in `window_id`, active,
/// 80x24 at the origin, a zsh with 100 rows of history, in no mode.
pub(super) fn pane_row_builder(pane_id: &str, window_id: &str) -> RowBuilder<PaneColumn> {
    use PaneColumn::*;
    [
        PaneIndex,
        Left,
        Top,
        CursorX,
        CursorY,
        Mode,
        CopyCursorX,
        CopyCursorY,
        ScrollPosition,
        AlternateOn,
        MouseAnyFlag,
        Marked,
        SelectionPresent,
        SelectionStartX,
        SelectionStartY,
    ]
    .into_iter()
    .fold(RowBuilder::new(), |row, column| row.set(column, 0))
    .set(PaneId, pane_id)
    .set(WindowId, window_id)
    .set(Width, 80)
    .set(Height, 24)
    .set(Active, 1)
    .set(Command, "zsh")
    .set(HistorySize, 100)
}

/// A list-panes row for `pane_id` in `window_id` (see `pane_row_builder`),
/// with the copy-mode column set from `in_mode` — the one source of a
/// pane's `in_mode` (see `PaneModeChanged`).
pub(super) fn pane_row(pane_id: &str, window_id: &str, in_mode: bool) -> String {
    pane_row_in_mode(pane_id, window_id, u8::from(in_mode))
}

/// A list-panes row with the mode column as tmux expands `PANE_MODE_FLAG`:
/// 0 for no mode, 1 for copy mode, 2 for view mode.
pub(super) fn pane_row_in_mode(pane_id: &str, window_id: &str, mode: u8) -> String {
    pane_row_builder(pane_id, window_id)
        .set(PaneColumn::Mode, mode)
        .build()
}

/// A list-windows row as tmux prints one: `window_id` at `index`, named
/// `name`, every `@tmuxy-*` option unset, not zoomed.
pub(super) fn window_row(
    window_id: &str,
    index: u32,
    active: bool,
    name: &str,
) -> RowBuilder<WindowColumn> {
    RowBuilder::new()
        .set(WindowColumn::WindowId, window_id)
        .set(WindowColumn::Index, index)
        .set(WindowColumn::Active, u8::from(active))
        .set(WindowColumn::Zoomed, 0)
        .set(WindowColumn::Name, name)
}

/// The three blocks of `agg`'s own marked `list`, answered with `rows`.
pub(super) fn list_blocks(
    agg: &StateAggregator,
    list: TmuxList,
    rows: &str,
) -> [ControlModeEvent; 3] {
    [
        response(&marked(agg, LIST_BEGIN_MARKER, list.name()), true),
        response(rows, true),
        response(&marked(agg, LIST_END_MARKER, ""), true),
    ]
}

/// Step `agg` through its own marked `list`, answered with `rows`, and
/// return what the rows' block did.
pub(super) fn listed(agg: &mut StateAggregator, list: TmuxList, rows: &str) -> StepResult {
    let [begin, body, end] = list_blocks(agg, list, rows);
    agg.step(begin);
    let result = agg.step(body);
    agg.step(end);
    result
}

/// Put `pane_id` in copy mode the way tmux reports it: a list-panes reply
/// with the copy-mode column set.
pub(super) fn enter_copy_mode(agg: &mut StateAggregator, pane_id: &str, window_id: &str) {
    listed(agg, TmuxList::Panes, &pane_row(pane_id, window_id, true));
    assert!(agg.panes[pane_id].in_mode, "{pane_id} is in copy mode");
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

/// An ack is not news: the empty block of a keystroke, or of any command
/// sent without a marker, changes nothing tmux will not announce itself,
/// so it neither rebuilds the state nor re-runs the layout pass.
#[test]
fn an_unmarked_ack_changes_nothing() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    for success in [true, false] {
        let r = agg.step(response("", success));
        assert!(r.effects.is_empty(), "an ack emitted {:?}", r.effects);
        assert_eq!(r.change_type, ChangeType::None);
    }
}

/// Arbitrary command output must not be mistaken for list-panes records.
///
/// A command's output arrives on the same channel as the list replies, so a
/// line holding a `%` and a comma could conjure ghost panes. Only a block a
/// list marker names is read as rows, even rows shaped like this session's.
#[test]
fn non_list_panes_output_does_not_create_panes() {
    let mut agg = StateAggregator::new();
    let before = agg.panes.len();

    agg.process_event(ControlModeEvent::CommandResponse {
        // Shapes that pass the old `contains('%') && contains(',')` sniff.
        output: "100% done, thanks\ncpu: 3%, mem: 40%\n[%foo,bar]".to_string(),
        success: true,
    });
    agg.step(response(&pane_row("%9", "@0", false), true));

    assert_eq!(agg.panes.len(), before, "no ghost panes may be created");
}

pub(super) fn response(output: &str, success: bool) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success,
    }
}

/// What a marker block of `agg`'s own prints: `name`, its token, `arg`.
pub(super) fn marked(agg: &StateAggregator, name: &str, arg: &str) -> String {
    format!("{} {arg}", agg.markers().tag(name))
        .trim_end()
        .to_string()
}

/// A reply-wrapped command's blocks come back whole, to the caller only.
#[test]
fn reply_markers_collect_the_blocks_between_them() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");

    let lines = agg
        .markers()
        .reply_wrapped_lines(7, "display-message -p HELLO");
    assert!(lines[0].contains(&marked(&agg, REPLY_BEGIN_MARKER, "7")));
    assert_eq!(lines[1], "display-message -p HELLO");
    assert!(lines[2].contains(&marked(&agg, REPLY_END_MARKER, "7")));

    let begin = agg.step(response(&marked(&agg, REPLY_BEGIN_MARKER, "7"), true));
    assert!(
        begin.effects.is_empty(),
        "the BEGIN marker is not an emission"
    );
    let body = agg.step(response("HELLO\n", true));
    assert!(
        body.effects.is_empty(),
        "a collected block is not an emission"
    );
    let end = agg.step(response(&marked(&agg, REPLY_END_MARKER, "7"), true));

    assert!(
        matches!(
            &end.effects[..],
            [SideEffect::Reply { id: 7, output, error: None }] if output == "HELLO\n"
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
    agg.step(response(&marked(&agg, REPLY_BEGIN_MARKER, "9"), true));
    agg.step(response("C-a", true));
    agg.step(response("", true));
    agg.step(response("bind-key -T prefix Space next-layout", true));
    let end = agg.step(response(&marked(&agg, REPLY_END_MARKER, "9"), true));
    assert!(
        matches!(
            &end.effects[..],
            [SideEffect::Reply { id: 9, output, error: None }]
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
    agg.step(response(&marked(&agg, REPLY_BEGIN_MARKER, "3"), true));
    agg.step(response("can't find window: @999\n", false));
    let end = agg.step(response(&marked(&agg, REPLY_END_MARKER, "3"), true));
    assert!(
        matches!(
            &end.effects[..],
            [SideEffect::Reply { id: 3, error: Some(msg), .. }]
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

    agg.step(response(&marked(&agg, REPLY_BEGIN_MARKER, "9"), true));
    // Two rows in `TmuxList::Panes` shape for panes of some other session.
    let rows = "%40,0,0,0,80,24,0,0,1,zsh,,0,0,0,0,@20,,0,0,0,0,0,10\n\
                    %41,1,0,0,80,24,0,0,0,zsh,,0,0,0,0,@20,,0,0,0,0,0,10\n";
    let body = agg.step(response(rows, true));
    let end = agg.step(response(&marked(&agg, REPLY_END_MARKER, "9"), true));

    assert_eq!(agg.panes.len(), before, "query rows must not become panes");
    assert!(
        body.effects.is_empty(),
        "no state emission for a collected block"
    );
    assert!(matches!(
        &end.effects[..],
        [SideEffect::Reply { id: 9, output, error: None }] if output.contains("%41,")
    ));
}

/// An END for a different id than the one in flight: the older reply is
/// lost (fail it), and the newer one must not inherit its output.
#[test]
fn a_mismatched_end_marker_fails_the_stale_reply() {
    let mut agg = StateAggregator::new();
    agg.step(response(&marked(&agg, REPLY_BEGIN_MARKER, "1"), true));
    agg.step(response("old\n", true));
    let end = agg.step(response(&marked(&agg, REPLY_END_MARKER, "2"), true));
    assert!(matches!(
        &end.effects[..],
        [SideEffect::Reply {
            id: 1,
            error: Some(_),
            ..
        }]
    ));
    assert!(agg.reply_in_flight.is_none());
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
    let images = sent(&mut pane).images;
    assert_eq!(images.len(), 1);
    let placement = &images[0];
    assert_eq!((placement.row, placement.col), (0, 0));
    assert_eq!((placement.width_cells, placement.height_cells), (2, 2));
    assert!(pane.image_store.contains_key(&placement.id));
}
