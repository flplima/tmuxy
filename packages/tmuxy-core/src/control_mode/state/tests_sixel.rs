//! A Sixel picture takes the rows it is drawn on: the text after it starts
//! on the line below, as tmux built with Sixel and xterm print it.

use super::test_pane::{sent, sent_text};
use super::*;
use crate::ids::test_ids::pid;

/// Six bands of six pixels: a picture 36 pixels tall, two rows or more.
const TALL_SIXEL: &[u8] = b"\x1bPq#0;2;100;0;0#0~~~~-~~~~-~~~~-~~~~-~~~~-~~~~\x1b\\";

fn rows(pane: &mut PaneState) -> Vec<String> {
    sent_text(pane).lines().map(str::to_string).collect()
}

#[test]
fn the_text_after_a_sixel_is_printed_on_the_line_below_it() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    pane.process_output(&[&b"$ show\r\nab"[..], TALL_SIXEL, b"hi!"].concat());

    let shown = sent(&mut pane);
    let picture = &shown.images[0];
    assert_eq!((picture.row, picture.col), (1, 2), "drawn at the cursor");
    assert!(picture.height_cells >= 2, "{picture:?}");
    let below = picture.row + i32::from(picture.height_cells);

    let rows = rows(&mut pane);
    assert_eq!(
        rows[1], "ab",
        "the picture's rows hold only the text before it"
    );
    for covered in 2..below {
        assert_eq!(
            rows[covered as usize], "",
            "row {covered} under the picture"
        );
    }
    assert_eq!(rows[below as usize], "hi!");
    assert_eq!((shown.cursor_y, shown.cursor_x), (below as u32, 3));
}

#[test]
fn a_sixel_at_the_bottom_scrolls_the_screen_to_make_room() {
    let mut pane = PaneState::new(pid("%1"), 40, 10);
    for line in 0..9 {
        pane.process_output(format!("line{line}\r\n").as_bytes());
    }
    pane.process_output(&[TALL_SIXEL, b"hi!"].concat());

    let shown = sent(&mut pane);
    let picture = &shown.images[0];
    assert_eq!(
        picture.row + i32::from(picture.height_cells),
        9,
        "the picture ends on the row above the last: {picture:?}"
    );
    assert_eq!(rows(&mut pane)[9], "hi!");
    assert_eq!((shown.cursor_y, shown.cursor_x), (9, 3));
}
