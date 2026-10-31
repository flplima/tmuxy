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
    // Still exactly one row after all the wrapping.
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

#[test]
fn one_by_one_pane_does_not_panic() {
    let mut parser = vt100::Parser::new(1, 1, 0);
    parser.process(b"abcdefghij");
    assert_eq!(extract_cells_from_screen(parser.screen()).len(), 1);
}

/// Row 0 of the screen as text.
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
