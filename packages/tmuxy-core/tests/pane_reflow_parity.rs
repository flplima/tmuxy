//! Row-position parity between the live `%output` emulator and real tmux.
//!
//! tmuxy renders a live pane by feeding raw pty bytes through vt100 and never
//! re-reads tmux for every frame, so the emulator's grid has to agree with
//! tmux's grid *row for row*. Two things make that non-trivial:
//!
//!   * A resize emits NO application bytes. tmux reflows its own grid
//!     internally; the emulator has to reproduce that from `set_size` alone.
//!   * tmux anchors the BOTTOM of the screen on reflow — shrinking scrolls the
//!     top rows into scrollback, growing pulls them back. An emulator that
//!     truncates/appends at the bottom instead ends up offset by the height
//!     delta, and (with no scrollback) loses those rows for good. That is the
//!     "pane is one line off after moving panes, fixed by clearing" bug: a
//!     clear resets both grids so they agree again.
//!
//! The fixtures are recorded from a real tmux 3.7 by
//! `tests/fixtures/reflow/regenerate.sh`. They are committed so this runs in
//! CI's `rust-tests` job, which has no tmux installed.

use tmuxy_core::constants::REFLOW_SCROLLBACK_ROWS;
use tmuxy_core::extract_cells_from_screen;

const PANE_W: u16 = 80;
const PANE_H: u16 = 20;
const SHRUNK_H: u16 = 12;

/// The emulator's visible grid, as one string per row.
fn emulated(parser: &vt100::Parser) -> Vec<String> {
    extract_cells_from_screen(parser.screen())
        .iter()
        .map(|line| {
            line.iter()
                .map(|c| c.char.as_str())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

/// What tmux itself showed, from `capture-pane -p`.
fn tmux_truth(name: &str) -> Vec<String> {
    let raw = match name {
        "h20" => include_str!("fixtures/reflow/h20.txt"),
        "h12" => include_str!("fixtures/reflow/h12.txt"),
        "h20-again" => include_str!("fixtures/reflow/h20-again.txt"),
        other => panic!("unknown fixture {other}"),
    };
    raw.lines().map(|l| l.trim_end().to_string()).collect()
}

/// Assert every row index holds the same content in both grids. Reports the
/// first divergence with its row number, because an off-by-N shows up as every
/// row after the first being shifted.
fn assert_rows_match(stage: &str, got: &[String], want: &[String]) {
    for (i, expected) in want.iter().enumerate() {
        let actual = got.get(i).map(String::as_str).unwrap_or("<missing row>");
        assert_eq!(
            actual, expected,
            "{stage}: row {i} diverged from tmux.\n  tmux     : {expected:?}\n  emulator : {actual:?}\n\
             A uniform shift here means the reflow anchored the wrong edge."
        );
    }
    assert!(
        got.len() >= want.len(),
        "{stage}: emulator produced {} rows, tmux had {}",
        got.len(),
        want.len()
    );
}

/// Feed the recorded pty stream and reproduce the resize sequence tmux went
/// through, checking the grid against tmux at each step.
#[test]
fn live_output_matches_tmux_across_resizes() {
    let bytes = include_bytes!("fixtures/reflow/session.bin");
    let mut parser = vt100::Parser::new(PANE_H, PANE_W, REFLOW_SCROLLBACK_ROWS);
    parser.process(bytes);

    // 1. Steady state: pure %output rendering, no resize involved.
    assert_rows_match("baseline", &emulated(&parser), &tmux_truth("h20"));

    // 2. Shrink. tmux keeps the bottom of the screen and scrolls the top away.
    parser.screen_mut().set_size(SHRUNK_H, PANE_W);
    assert_rows_match("after shrink", &emulated(&parser), &tmux_truth("h12"));

    // 3. Grow back. tmux restores the rows it scrolled off, so the pane returns
    //    to exactly its pre-shrink contents.
    parser.screen_mut().set_size(PANE_H, PANE_W);
    assert_rows_match("after regrow", &emulated(&parser), &tmux_truth("h20-again"));
}

/// The regrown pane must be identical to the original, not merely
/// self-consistent — this is what the user sees as "it's one line off".
#[test]
fn resize_round_trip_restores_original_rows() {
    let bytes = include_bytes!("fixtures/reflow/session.bin");
    let mut parser = vt100::Parser::new(PANE_H, PANE_W, REFLOW_SCROLLBACK_ROWS);
    parser.process(bytes);
    let before = emulated(&parser);

    parser.screen_mut().set_size(SHRUNK_H, PANE_W);
    parser.screen_mut().set_size(PANE_H, PANE_W);
    let after = emulated(&parser);

    assert_eq!(
        before, after,
        "shrink+grow round trip changed the visible grid; content was lost or shifted"
    );
}

/// Reflow must anchor the bottom: after shrinking, the LAST row is unchanged
/// and the rows that disappeared came off the TOP.
#[test]
fn shrink_scrolls_off_the_top_not_the_bottom() {
    let bytes = include_bytes!("fixtures/reflow/session.bin");
    let mut parser = vt100::Parser::new(PANE_H, PANE_W, REFLOW_SCROLLBACK_ROWS);
    parser.process(bytes);
    let full = emulated(&parser);

    parser.screen_mut().set_size(SHRUNK_H, PANE_W);
    let shrunk = emulated(&parser);

    let dropped = full.len() - shrunk.len();
    assert_eq!(
        shrunk,
        full[dropped..],
        "shrink must retain the bottom {SHRUNK_H} rows; retaining the top instead \
         offsets every row by {dropped}"
    );
}

/// Un-zoom shrinks a mostly-empty pane whose cursor sits near the TOP. The rows
/// that must go are the blank ones BELOW the cursor — dropping from the top
/// instead discards the content and leaves the pane rendering empty, which is
/// what un-zooming used to do.
#[test]
fn shrinking_a_mostly_empty_pane_keeps_its_content() {
    let mut parser = vt100::Parser::new(16, 82, REFLOW_SCROLLBACK_ROWS);
    parser.process(b"line one\r\nline two\r\nline three\r\n");

    // Cursor is on row 3 of 16; rows 4..16 are blank.
    parser.screen_mut().set_size(8, 40);

    let rows = emulated(&parser);
    assert_eq!(rows[0], "line one", "content must survive the shrink");
    assert_eq!(rows[1], "line two");
    assert_eq!(rows[2], "line three");
}

/// The cursor must still be pushed off the top once there is nothing blank
/// left to discard below it — a full screen shrinks by scrolling.
#[test]
fn shrinking_a_full_pane_still_scrolls_off_the_top() {
    let mut parser = vt100::Parser::new(6, 20, REFLOW_SCROLLBACK_ROWS);
    parser.process(b"a\r\nb\r\nc\r\nd\r\ne\r\nf");

    parser.screen_mut().set_size(3, 20);

    let rows = emulated(&parser);
    assert_eq!(rows[0], "d", "a full screen keeps its bottom, not its top");
    assert_eq!(rows[2], "f");
}
