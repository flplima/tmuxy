//! The emulator must never panic on a degenerately small pane grid.
//!
//! A collapsed stacked pane is one row tall, so the server sizes its vt100
//! grid to a single row and feeds it whatever the shell emits. Output that
//! reaches the right edge of a one-row grid used to underflow the wrap
//! bookkeeping (`prev_pos.row -= scrolled` with `scrolled == 1` and
//! `prev_pos.row == 0`) and panic the tokio worker, taking the whole server
//! down. These replay that geometry through the real emulator path.

use tmuxy_core::extract_cells_from_screen;

#[test]
fn single_row_pane_wrapping_output_does_not_panic() {
    // One-row grid, output far wider than the grid so it wraps repeatedly.
    let mut parser = vt100::Parser::new(1, 20, 0);
    parser.process(b"the quick brown fox jumps over the lazy dog 0123456789");
    assert_eq!(extract_cells_from_screen(parser.screen()).len(), 1);
}

#[test]
fn single_column_pane_wide_chars_do_not_panic() {
    // A wide (2-cell) glyph cannot fit a one-column grid; it must clamp, not
    // reach for a continuation cell that does not exist.
    let mut parser = vt100::Parser::new(4, 1, 0);
    parser.process("￥漢字ＡＢ".as_bytes());
    assert_eq!(extract_cells_from_screen(parser.screen()).len(), 4);
}

/// Every escape that moves the cursor, scrolls, erases, inserts or resizes
/// text, for the size tests below.
const EVERY_EDGE: &[&[u8]] = &[
    b"abcdefghij\r\nklmnop\r\n\r\n\r\n",
    "漢字ＡＢ漢字e\u{301}x\u{200d}y👍🏽".as_bytes(),
    b"\x1b[999L\x1b[999M\x1b[999@\x1b[999P\x1b[999X\x1b[999S\x1b[999T",
    b"\x1b[1;1r\x1b[2;1r\x1b[0;0r\x1b[999;999r\x1bM\x1bM\x1bD\x1bE\n\n",
    b"\x1b#3\x1b#4\x1b#6\x1b#5\x1b#8abc",
    b"\x1b[999;999H\x1b[999A\x1b[999B\x1b[999C\x1b[999D\x1b[999E\x1b[999F\x1b[999G\x1b[999d",
    b"\x1b[J\x1b[1J\x1b[2J\x1b[K\x1b[1K\x1b[2K\x1b[3J",
    b"\t\t\t\x1b[999I\x1b[999Z\x1b[5b",
    b"\x1b[?1049h\x1b[?47habc\x1b[?1049l\x1b[?6h\x1b[?6l\x1b[?7l",
    b"\x1b]66;s=3:w=2;\xe6\xbc\xa2x\x07\x1b]66;s=7;ab\x07",
    b"\x1b7\x1b8\x1bc\x08\x08\x08",
];

/// A zero side is a one-cell side, so no caller has to guard against one:
/// every cursor clamp and scroll region in the grid is `side - 1`. Each size
/// is also reached by resizing, from and to the others, with the view
/// scrolled back.
#[test]
fn zero_and_one_cell_grids_take_every_escape() {
    let sizes = [(0, 0), (0, 5), (5, 0), (1, 1), (2, 1), (1, 2)];
    for &(rows, cols) in &sizes {
        for input in EVERY_EDGE {
            let mut parser = vt100::Parser::new(rows, cols, 10);
            assert_eq!(parser.screen().size(), (rows.max(1), cols.max(1)));
            parser.process(input);
            for &(r, c) in &sizes {
                parser.screen_mut().set_size(r, c);
                assert_eq!(parser.screen().size(), (r.max(1), c.max(1)));
                parser.process(input);
                parser.screen_mut().set_scrollback(5);
                parser.process(input);
                parser.screen_mut().set_scrollback(0);
                assert_eq!(
                    extract_cells_from_screen(parser.screen()).len(),
                    usize::from(r.max(1))
                );
            }
        }
    }
}

#[test]
fn one_by_one_pane_does_not_panic() {
    let mut parser = vt100::Parser::new(1, 1, 0);
    parser.process(b"abcdefghij");
    assert_eq!(extract_cells_from_screen(parser.screen()).len(), 1);
}

fn first_row(parser: &vt100::Parser) -> String {
    parser
        .screen()
        .contents()
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

#[test]
fn wide_char_cut_by_a_column_shrink_is_dropped_and_can_be_overwritten() {
    // `漢` sits in the last two columns; shrinking by one cuts it in half.
    // The half that is left must go, not stay a wide cell whose continuation
    // no longer exists for the next write to reach for.
    let mut parser = vt100::Parser::new(2, 4, 0);
    parser.process("ab漢".as_bytes());
    parser.screen_mut().set_size(2, 3);
    assert_eq!(first_row(&parser), "ab");
    assert!(!parser.screen().cell(0, 2).unwrap().is_wide());

    parser.process(b"\x1b[1;3Hx");
    assert_eq!(first_row(&parser), "abx");
}

#[test]
fn wide_char_cut_by_a_column_shrink_can_be_erased() {
    let mut parser = vt100::Parser::new(2, 4, 0);
    parser.process("ab漢".as_bytes());
    parser.screen_mut().set_size(2, 3);
    parser.process(b"\x1b[1;3H\x1b[K");
    assert_eq!(first_row(&parser), "ab");
}

#[test]
fn wide_char_in_a_single_column_pane_can_be_overwritten_and_erased() {
    // The width clamp draws `漢` into the only column; the cell must not
    // claim a continuation half in a column that does not exist.
    let mut parser = vt100::Parser::new(2, 1, 0);
    parser.process("漢".as_bytes());
    assert_eq!(first_row(&parser), "漢");
    assert!(!parser.screen().cell(0, 0).unwrap().is_wide());

    parser.process(b"\rx");
    assert_eq!(first_row(&parser), "x");

    parser.process("\r漢\r\x1b[K".as_bytes());
    assert_eq!(first_row(&parser), "");

    parser.process("\x1b[H漢\x1b[H\x1b[J".as_bytes());
    assert_eq!(parser.screen().contents(), "");
}

#[test]
fn growing_a_pane_scrolled_into_its_history_does_not_underflow() {
    // Three rows of history, viewed from all the way back; growing the pane
    // by two pulls two of them back onto the screen, leaving one above it.
    let mut parser = vt100::Parser::new(2, 5, 10);
    parser.process(b"1\r\n2\r\n3\r\n4\r\n5");
    parser.screen_mut().set_scrollback(3);
    parser.screen_mut().set_size(4, 5);
    assert_eq!(parser.screen().scrollback(), 1);
    assert_eq!(parser.screen().contents(), "1\n2\n3\n4");
}

#[test]
fn capture_taller_or_wider_than_a_u16_grid_does_not_panic() {
    // A `capture-pane` of a pane with a deep history can return 65,536 lines
    // or more; the height must not wrap to a zero-row grid.
    let cells = tmuxy_core::parse_ansi_to_cells("x", 1, 65_536);
    assert_eq!(cells.len(), usize::from(u16::MAX));
    assert_eq!(cells[0][0].char, "x");

    let cells = tmuxy_core::parse_ansi_to_cells("x", 65_536, 1);
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0][0].char, "x");
}

#[test]
fn a_tab_at_the_widest_grid_stops_at_the_edge() {
    // 65,535 columns is the widest grid a capture can ask for; a tab from the
    // last tab stop used to add past `u16::MAX`.
    let cells = tmuxy_core::parse_ansi_to_cells("\x1b[65530G\tx", 65_536, 1);
    assert_eq!(cells[0][usize::from(u16::MAX) - 1].char, "x");
}

#[test]
fn huge_insert_and_scroll_counts_end_at_the_region() {
    // `CSI 65535 @`, `CSI 65535 L` and `CSI 65535 T` do what a count the size
    // of the region does, without 65,535 passes over the row or the grid.
    let mut parser = vt100::Parser::new(4, 10, 0);
    parser.process(b"abcdefghij\r\n2\r\n3\r\n4\x1b[1;3H");
    parser.process(b"\x1b[65535@");
    assert_eq!(first_row(&parser), "ab");
    parser.process(b"\x1b[2;1H\x1b[65535L\x1b[1;1H\x1b[65535T");
    assert_eq!(parser.screen().contents(), "");
}
