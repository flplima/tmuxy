//! DEC line sizes (`ESC # 3..6`, a row's) and kitty OSC 66 text sizes (a
//! cell's), as the extraction reports them and as a capture refill keeps them.

use super::*;
use crate::ids::test_ids::pid;

#[test]
fn dec_line_size_escapes_tag_rows_and_survive_capture_refresh() {
    let mut pane = PaneState::new(pid("%0"), 20, 6);
    pane.process_output(b"\x1b#3TOP\r\n\x1b#4TOP\r\n\x1b#6WIDE\r\n\x1b#6\x1b#5PLAIN");

    let content = pane.get_content();
    assert_eq!(
        content[0][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightTop)
    );
    assert_eq!(content[0].len(), 3);
    assert_eq!(
        content[1][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightBottom)
    );
    assert_eq!(
        content[2][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleWidth)
    );
    assert_eq!(content[3][0].style, None);

    // Simulate tmux capture-pane (which strips ESC # 3..6)
    pane.apply_capture(b"TOP\nTOP\nWIDE\nPLAIN");
    let after = pane.get_content();
    assert_eq!(
        after[0][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightTop)
    );
    assert_eq!(
        after[1][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightBottom)
    );
    assert_eq!(
        after[2][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleWidth)
    );
}

#[test]
fn osc66_scales_double_height_and_double_width_and_survives_capture() {
    let mut pane = PaneState::new(pid("%0"), 20, 6);
    pane.process_output(b"\x1b]66;s=2;BIG\x07\r\n\r\n\x1b]66;s=1:w=2;WIDE\x07");

    let content = pane.get_content();
    assert_eq!(content[0].len(), 3);
    assert_eq!(content[0][0].char, "B");
    assert_eq!(
        content[0][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightTop)
    );
    // Row 1 mirrors "BIG" with DoubleHeightBottom even though vt100 left row 1 blank
    assert_eq!(content[1].len(), 3);
    assert_eq!(content[1][0].char, "B");
    assert_eq!(
        content[1][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightBottom)
    );
    // Row 2 has "WIDE" with DoubleWidth
    assert_eq!(content[2].len(), 4);
    assert_eq!(
        content[2][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleWidth)
    );

    // Survives capture-pane refresh when the top-row text still matches
    pane.apply_capture(b"BIG\n\nWIDE");
    let after = pane.get_content();
    assert_eq!(
        after[0][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightTop)
    );
    assert_eq!(
        after[1][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleHeightBottom)
    );
    assert_eq!(
        after[2][0].style.as_ref().and_then(|s| s.size),
        Some(crate::CellSize::DoubleWidth)
    );
}
