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
