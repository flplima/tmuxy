use super::*;
use crate::ids::test_ids::pid;

/// Read back the text a pane's OSC 8 marks actually cover, as
/// `(url, text)` — the same join `extract_cells_with_urls` does, which is
/// what the frontend turns into `<a href>`.
fn linked_text(pane: &PaneState) -> Vec<(String, String)> {
    let screen = pane.terminal.screen();
    let (rows, cols) = screen.size();
    let mut out: Vec<(String, String)> = Vec::new();
    for row in 0..rows {
        let chars: Vec<String> = (0..cols)
            .map(|col| crate::screen_cell_char(screen, row, col))
            .collect();
        let urls = pane.osc_parser.row_urls(u32::from(row), &chars);
        let mut run: Option<(String, String)> = None;
        for col in 0..cols {
            let url = urls[usize::from(col)];
            let ch = chars[usize::from(col)].clone();
            match (url, &mut run) {
                (Some(u), Some((cur, text))) if cur == u => text.push_str(&ch),
                (Some(u), _) => {
                    if let Some(done) = run.take() {
                        out.push(done);
                    }
                    run = Some((u.to_string(), ch));
                }
                (None, _) => {
                    if let Some(done) = run.take() {
                        out.push(done);
                    }
                }
            }
        }
        if let Some(done) = run.take() {
            out.push(done);
        }
    }
    out
}

fn osc8(url: &str, label: &str) -> Vec<u8> {
    format!("\x1b]8;;{url}\x07{label}\x1b]8;;\x07").into_bytes()
}

#[test]
fn hyperlink_lands_on_its_own_text_after_a_cursor_move() {
    // Regression: the OSC parser used to advance a private cursor on \n,
    // \r and printable ASCII only. A CSI cursor move — which is most of
    // what a shell prompt emits — was invisible to it, so its rows drifted
    // and the URL attached to whatever text later occupied those cells.
    // Here CUP jumps to row 4 before the link is written.
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    let mut out = b"\x1b[5;1H".to_vec();
    out.extend_from_slice(&osc8("https://example.com/osc", "OSC-LINK"));
    out.extend_from_slice(b"\r\ntail-after-link");
    pane.process_output(&out);

    assert_eq!(
        linked_text(&pane),
        vec![(
            "https://example.com/osc".to_string(),
            "OSC-LINK".to_string()
        )],
        "the link must cover its own label, not the line after it"
    );
}

#[test]
fn hyperlink_follows_its_line_as_output_scrolls_it_up() {
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.process_output(&osc8("https://example.com/s", "LINK"));
    // Push the link's line up with more output than the pane is tall.
    pane.process_output(b"\r\na\r\nb\r\nc");

    assert_eq!(
        linked_text(&pane),
        vec![("https://example.com/s".to_string(), "LINK".to_string())],
        "the mark must travel with the line it was written on"
    );
}

#[test]
fn a_link_does_not_reattach_to_text_redrawn_over_it() {
    // The reported bug: a long underline over unrelated text in Claude
    // Code. An application that repaints in place moves no lines, so
    // nothing shifted or cleared the marks — the link's COORDINATES
    // outlived its text, and the next frame's characters inherited them.
    let mut pane = PaneState::new(pid("%1"), 40, 6);
    pane.process_output(b"\x1b[?1049h\x1b[1;1H");
    pane.process_output(&osc8("https://example.com/x", "CLICK-ME"));
    assert_eq!(
        linked_text(&pane),
        vec![("https://example.com/x".to_string(), "CLICK-ME".to_string())]
    );

    pane.process_output(b"\x1b[1;1HTOTALLY UNRELATED TEXT");
    assert!(
        linked_text(&pane).is_empty(),
        "the redrawn text must not inherit the link: {:?}",
        linked_text(&pane)
    );
}

#[test]
fn a_cleared_frame_drops_the_links_that_were_on_it() {
    // Erase-in-display writes blanks through vt100 without moving a line,
    // so it too left the marks where they were.
    let mut pane = PaneState::new(pid("%1"), 40, 6);
    pane.process_output(&osc8("https://example.com/y", "LINK-HERE"));
    pane.process_output(b"\x1b[2J\x1b[1;1HFRESH FRAME CONTENT");

    assert!(
        linked_text(&pane).is_empty(),
        "a link cleared off the screen must not come back on new text: {:?}",
        linked_text(&pane)
    );
}

#[test]
fn a_link_survives_output_that_leaves_its_text_alone() {
    // The other half of the rule: only the cells whose text changed lose
    // their link. A frame that redraws around a link keeps it clickable.
    let mut pane = PaneState::new(pid("%1"), 40, 6);
    pane.process_output(b"\x1b[?1049h\x1b[2;1H");
    pane.process_output(&osc8("https://example.com/z", "STILL-A-LINK"));
    pane.process_output(b"\x1b[1;1Hheader\x1b[3;1Hfooter");

    assert_eq!(
        linked_text(&pane),
        vec![(
            "https://example.com/z".to_string(),
            "STILL-A-LINK".to_string()
        )],
        "a redraw of other rows must not drop the link"
    );
}

#[test]
fn hyperlink_scrolled_off_the_top_is_dropped() {
    let mut pane = PaneState::new(pid("%1"), 40, 3);
    pane.process_output(&osc8("https://example.com/gone", "LINK"));
    pane.process_output(b"\r\na\r\nb\r\nc\r\nd\r\ne");

    assert!(
        linked_text(&pane).is_empty(),
        "a link scrolled off screen must not re-attach to a surviving row"
    );
}

#[test]
fn hyperlink_wrapping_the_right_edge_covers_both_rows() {
    let mut pane = PaneState::new(pid("%1"), 10, 6);
    pane.process_output(b"\x1b[1;9H");
    pane.process_output(&osc8("https://example.com/w", "ABCD"));

    let linked = linked_text(&pane);
    let joined: String = linked.iter().map(|(_, t)| t.as_str()).collect();
    assert_eq!(joined, "ABCD", "wrapped link lost cells: {linked:?}");
    assert!(linked.iter().all(|(u, _)| u == "https://example.com/w"));
}

#[test]
fn hyperlink_terminated_with_st_is_recorded() {
    // Real shells emit ST (ESC \\), not BEL, to close OSC 8.
    let mut pane = PaneState::new(pid("%1"), 40, 6);
    pane.process_output(b"\x1b]8;;https://example.com/st\x1b\\OSC-LINK\x1b]8;;\x1b\\\r\ntail");
    assert_eq!(
        linked_text(&pane),
        vec![("https://example.com/st".to_string(), "OSC-LINK".to_string())]
    );
}

#[test]
fn a_refill_keeps_the_alternate_screen_tmux_reports() {
    // A client that attaches while an application (vim, Claude Code) is
    // already on the alternate screen: list-panes says alternate_on=1,
    // then the capture refill rebuilds the parser. The rebuilt parser must
    // be on the alternate screen too, or every following %output flips
    // the flag back to false and the pane re-renders on each flap.
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.alternate_on = true;
    pane.reset_and_process_capture(b"drawn on the alternate screen\n");
    assert!(pane.terminal.screen().alternate_screen());
    pane.process_output(b"more");
    assert!(
        pane.alternate_on,
        "output after a refill must not drop alternate mode"
    );

    // And a pane on the main screen stays there.
    let mut main = PaneState::new(pid("%2"), 40, 4);
    main.alternate_on = false;
    main.reset_and_process_capture(b"shell\n");
    assert!(!main.terminal.screen().alternate_screen());
    main.process_output(b"x");
    assert!(!main.alternate_on);
}

#[test]
fn a_refill_keeps_the_mouse_tracking_tmux_reports() {
    // The same flap, on the other flag, and the reason one flick of a
    // trackpad reached a mouse-tracking app as BOTH SGR wheel reports and
    // arrow keys: list-panes says mouse_any_flag=1, the capture refill
    // rebuilds the parser without the mode, and each following %output
    // flips the flag false again. The frontend routes a wheel event by
    // that flag — SGR when it is set, arrow keys when the pane is merely
    // on the alternate screen — so events either side of a flap went out
    // as different things for a single gesture.
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.alternate_on = true;
    pane.mouse_any_flag = true;
    pane.reset_and_process_capture(b"a TUI that tracks the mouse\n");
    pane.process_output(b"redraw");
    assert!(
        pane.mouse_any_flag,
        "output after a refill must not drop mouse tracking"
    );

    // An application that turns tracking off is still believed: the
    // restored mode is a floor for what tmux reported, not a latch.
    pane.process_output(b"\x1b[?1000l");
    assert!(
        !pane.mouse_any_flag,
        "an explicit disable must still clear the flag"
    );

    // A pane that never had tracking does not acquire it from a refill.
    let mut plain = PaneState::new(pid("%2"), 40, 4);
    plain.mouse_any_flag = false;
    plain.reset_and_process_capture(b"shell\n");
    plain.process_output(b"x");
    assert!(!plain.mouse_any_flag);
}

#[test]
fn a_link_after_a_capture_refresh_is_still_recorded() {
    // Regression: the scroll counter belongs to one vt100 grid, and a
    // capture refresh builds a fresh parser whose counter restarts at 0.
    // Comparing the new counter against the old baseline produced a large
    // negative delta, which shifted every subsequent mark off the screen —
    // links silently stopped appearing after the first capture refresh.
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    // Scroll the grid so the counter is well past zero.
    pane.process_output(b"a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng");
    pane.reset_and_process_capture(b"fresh\n");

    pane.process_output(&osc8("https://example.com/after", "LINK"));

    assert_eq!(
        linked_text(&pane),
        vec![("https://example.com/after".to_string(), "LINK".to_string())]
    );
}

#[test]
fn links_do_not_leak_onto_the_alternate_screen() {
    // The alternate grid has its own scroll counter AND its own text, so a
    // mark taken on the normal screen must not survive the switch.
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.process_output(&osc8("https://example.com/main", "LINK"));
    assert!(!linked_text(&pane).is_empty());

    // Enter the alternate screen and paint over the same cells.
    pane.process_output(b"\x1b[?1049h\x1b[HVIMTEXT");

    assert!(
        linked_text(&pane).is_empty(),
        "a normal-screen URL must not attach to alternate-screen content"
    );
}

#[test]
fn plain_output_records_no_links() {
    // A URL in plain output is not an OSC 8 link; the frontend's own
    // detector decides whether to offer it (utils/urlDetect.ts).
    let mut pane = PaneState::new(pid("%1"), 40, 6);
    pane.process_output(b"https://example.com/not-osc8\r\nplain text");
    assert!(linked_text(&pane).is_empty());
}

#[test]
fn clear_from_home_erases_the_screen() {
    // The exact bytes zsh emits for `clear` (captured with pipe-pane):
    // an OSC title, then CUP home + ED with no parameter.
    let mut pane = PaneState::new(pid("%1"), 43, 10);
    pane.process_output(b"one\r\ntwo\r\nthree\r\n");
    pane.process_output(
            b"c\x08clear\x1b[?2004l\r\r\n\x1b]0;clear\x07\x1b[H\x1b[J\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m       \r \r\x1b]0;zsh\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[J\r\n\x1b[34m~\x1b[39m\r\n\x1b[35m\xe2\x9d\xaf\x1b[39m \x1b[K\x1b[?2004h",
        );
    let text = pane.terminal.screen().contents();
    assert!(
        !text.contains("one") && !text.contains("three"),
        "screen not cleared: {text:?}"
    );
}

/// `#{pane_marked}` rides in the tail of list-panes, between mouse_any_flag
/// and selection_present, after an escaped comma in the title.
#[test]
fn list_panes_carries_the_marked_flag() {
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(
        "%3,0,0,0,80,24,0,0,1,zsh,a%2C title,0,0,0,0,@4,,0,0,1,0,0,0,100,,,,,,",
    );
    let pane = agg.panes.get("%3").expect("pane parsed");
    assert!(pane.marked);
    assert_eq!(pane.title, "a, title");
    assert_eq!(pane.history_size, 100);

    agg.parse_list_panes_line(
        "%3,0,0,0,80,24,0,0,1,zsh,a%2C title,0,0,0,0,@4,,0,0,0,0,0,0,100,,,,,,",
    );
    assert!(!agg.panes.get("%3").expect("pane parsed").marked);
}
