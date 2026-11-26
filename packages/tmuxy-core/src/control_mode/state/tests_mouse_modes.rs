//! The mouse modes a program asks for (`?1003h` any motion, `?1016h`
//! SGR-Pixels) reach the pane's state, survive a parser rebuild, and leave
//! with the program.

use super::test_pane::sent;
use super::tests::*;
use super::*;
use crate::constants::tmux_formats::PaneColumn;
use crate::ids::test_ids::pid;

#[test]
fn sgr_pixels_and_any_motion_reach_the_pane_from_its_output() {
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.process_output(b"\x1b[?1003h\x1b[?1006h\x1b[?1016h");
    assert!(pane.mouse_any_flag);
    assert!(pane.mouse_all_flag);
    assert!(pane.mouse_pixels_flag);
    let wire = sent(&mut pane);
    assert!(wire.mouse_all_flag && wire.mouse_pixels_flag);

    // `?1016l` goes back to cells; tracking stays on.
    pane.process_output(b"\x1b[?1016l");
    assert!(!pane.mouse_pixels_flag);
    assert!(pane.mouse_all_flag);

    // `?1003l` ends any motion and with it all tracking.
    pane.process_output(b"\x1b[?1003l");
    assert!(!pane.mouse_all_flag);
    assert!(!pane.mouse_any_flag);
}

#[test]
fn sgr_pixels_leaves_a_plain_sgr_program_alone() {
    // A program that asks for 1000 and 1006, as most do, gets neither flag.
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.process_output(b"\x1b[?1000h\x1b[?1006h");
    assert!(pane.mouse_any_flag);
    assert!(!pane.mouse_all_flag);
    assert!(!pane.mouse_pixels_flag);

    // 1006 after 1016 picks cells again: one encoding at a time.
    pane.process_output(b"\x1b[?1016h\x1b[?1006h");
    assert!(!pane.mouse_pixels_flag);
    // Clearing 1006 while 1016 is the encoding leaves 1016 alone.
    pane.process_output(b"\x1b[?1016h\x1b[?1006l");
    assert!(pane.mouse_pixels_flag);
}

#[test]
fn a_refill_keeps_any_motion_and_sgr_pixels() {
    // The capture refill rebuilds the parser from the screen, which holds
    // no modes. Without them the next output would clear both flags, and
    // the UI would flap between cells and pixels, hover and no hover.
    let mut pane = PaneState::new(pid("%1"), 40, 4);
    pane.process_output(b"\x1b[?1003h\x1b[?1006h\x1b[?1016h");
    pane.apply_capture(b"a picture\n");
    pane.process_output(b"redraw");
    assert!(pane.mouse_any_flag);
    assert!(pane.mouse_all_flag, "a refill must not drop any-motion");
    assert!(pane.mouse_pixels_flag, "a refill must not drop SGR-Pixels");

    // The restored modes are still the program's to clear.
    pane.process_output(b"\x1b[?1003l\x1b[?1016l");
    assert!(!pane.mouse_any_flag);
    assert!(!pane.mouse_pixels_flag);
}

#[test]
fn list_panes_reads_any_motion_and_drops_pixels_when_tracking_ends() {
    let mut agg = StateAggregator::new();
    let row = |any: u8, all: u8| {
        pane_row_builder("%3", "@4")
            .set(PaneColumn::MouseAnyFlag, any)
            .set(PaneColumn::MouseAllFlag, all)
            .build()
    };
    agg.parse_list_panes_line(&row(1, 1));
    {
        let pane = agg.panes.get_mut("%3").expect("pane parsed");
        assert!(pane.mouse_all_flag, "tmux's mouse_all_flag is read");
        pane.process_output(b"\x1b[?1003h\x1b[?1016h");
        assert!(pane.mouse_pixels_flag);
    }

    // tmux still tracks: the pixels stay, since tmux never knows of 1016.
    agg.parse_list_panes_line(&row(1, 1));
    assert!(agg.panes.get("%3").expect("pane").mouse_pixels_flag);

    // tmux says the pane tracks nothing (the program reset its modes or a
    // new one took over): pixels go, and the next output does not bring
    // them back for a program that never asked.
    agg.parse_list_panes_line(&row(0, 0));
    let pane = agg.panes.get_mut("%3").expect("pane");
    assert!(!pane.mouse_all_flag);
    assert!(!pane.mouse_pixels_flag);
    pane.process_output(b"\x1b[?1000h\x1b[?1006h");
    assert!(pane.mouse_any_flag);
    assert!(
        !pane.mouse_pixels_flag,
        "the next program gets cells unless it asks for pixels"
    );
}
