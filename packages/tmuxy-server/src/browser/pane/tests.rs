use chromiumoxide::cdp::browser_protocol::input::MouseButton;

use super::input::{
    cell_to_page, decode_button, key_name, on_picture, take_inputs, wheel_delta_y, ButtonMeaning,
    Inputs,
};
use super::ui::{
    header_line, is_page, restore_tag_args, url_tag_args, widget_tag_args, Navigation,
};
use super::*;

#[test]
fn the_picture_covers_everything_under_the_toolbar_row() {
    let size = PaneSize {
        cols: 80,
        rows: 24,
        cell_w: 8,
        cell_h: 16,
    };
    assert_eq!(
        size.image_rows(),
        23,
        "the toolbar row is the app's; the status row is under the picture"
    );
    assert_eq!(layout(size, Viewport::Auto).page_w, 640);
    assert_eq!(layout(size, Viewport::Auto).page_h, 368);
}

/// A one-row pane would otherwise ask for a zero-height viewport, which
/// makes Chromium stop painting entirely.
#[test]
fn a_tiny_pane_still_asks_for_a_usable_viewport() {
    let size = PaneSize {
        cols: 1,
        rows: 1,
        cell_w: 8,
        cell_h: 16,
    };
    assert_eq!(size.image_rows(), 1);
    assert!(layout(size, Viewport::Auto).page_h > 0);
    assert!(layout(size, Viewport::Mobile).rows > 0);
}

#[test]
fn a_frame_is_drawn_home_so_it_replaces_the_last_one() {
    let size = PaneSize {
        cols: 10,
        rows: 5,
        cell_w: 8,
        cell_h: 16,
    };
    let drawn =
        String::from_utf8(draw_frame(b"\xff\xd8\xff", layout(size, Viewport::Auto))).unwrap();
    assert!(
        drawn.starts_with("\x1b[?25l\x1b[2;1H"),
        "the cursor must be at the picture's corner, or tmuxy anchors the picture somewhere new each time"
    );
    assert!(drawn.contains("width=10;height=4"), "{drawn}");
    assert!(drawn.ends_with('\x07'), "the OSC must be terminated");
    assert!(drawn.contains("inline=1"), "{drawn}");
    assert!(
        drawn.contains("preserveAspectRatio=0"),
        "a letterboxed picture puts clicks where the page is not: {drawn}"
    );
}

#[test]
fn a_whole_mouse_report_is_one_input() {
    let mut buf = b"\x1b[<0;12;7M".to_vec();
    assert_eq!(
        take_inputs(&mut buf),
        vec![Input::Mouse {
            button: 0,
            col: 12,
            row: 7,
            pressed: true
        }]
    );
    assert!(buf.is_empty());
}

#[test]
fn a_release_is_told_from_a_press() {
    let mut buf = b"\x1b[<0;1;1m".to_vec();
    assert_eq!(
        take_inputs(&mut buf),
        vec![Input::Mouse {
            button: 0,
            col: 1,
            row: 1,
            pressed: false
        }]
    );
}

/// The bug this guards: half a mouse report read as keys types its digits
/// and semicolons into the page.
#[test]
fn a_split_mouse_report_waits_for_its_rest() {
    let mut buf = b"\x1b[<0;12".to_vec();
    assert!(take_inputs(&mut buf).is_empty(), "nothing is complete yet");
    buf.extend_from_slice(b";7M");
    assert_eq!(
        take_inputs(&mut buf),
        vec![Input::Mouse {
            button: 0,
            col: 12,
            row: 7,
            pressed: true
        }]
    );
}

#[test]
fn keys_and_mouse_interleave_without_losing_either() {
    let mut buf = b"a\x1b[<0;2;3Mb".to_vec();
    assert_eq!(
        take_inputs(&mut buf),
        vec![
            Input::Key(b"a".to_vec()),
            Input::Mouse {
                button: 0,
                col: 2,
                row: 3,
                pressed: true
            },
            Input::Key(b"b".to_vec()),
        ]
    );
}

/// An arrow key is one key, not `[` followed by `A`.
#[test]
fn an_escape_sequence_arrives_as_one_key() {
    let mut buf = b"\x1b[A".to_vec();
    assert_eq!(take_inputs(&mut buf), vec![Input::Key(b"\x1b[A".to_vec())]);
}

/// A bare ESC is held back: its sequence may still be arriving, and
/// splitting it would type `[` and `A` into the page.
#[test]
fn a_lone_escape_waits() {
    let mut buf = b"\x1b".to_vec();
    assert!(take_inputs(&mut buf).is_empty());
    buf.extend_from_slice(b"[D");
    assert_eq!(take_inputs(&mut buf), vec![Input::Key(b"\x1b[D".to_vec())]);
}

#[test]
fn a_multibyte_character_is_not_split() {
    let mut buf = "é".as_bytes().to_vec();
    buf.truncate(1);
    assert!(take_inputs(&mut buf).is_empty(), "half a character waits");
    buf.extend_from_slice(&"é".as_bytes()[1..]);
    assert_eq!(
        take_inputs(&mut buf),
        vec![Input::Key("é".as_bytes().to_vec())]
    );
}

/// The centre of the cell, so a click aimed at a link lands in it.
#[test]
fn a_cell_maps_to_the_middle_of_itself() {
    let size = PaneSize {
        cols: 80,
        rows: 24,
        cell_w: 8,
        cell_h: 16,
    };
    // Row 2 is the picture's first: row 1 is the toolbar's.
    let page = layout(size, Viewport::Auto);
    assert_eq!(cell_to_page(1, 2, page), (4.0, 8.0));
    assert_eq!(cell_to_page(2, 4, page), (12.0, 40.0));
}

/// A fixed size keeps its own aspect: a phone page is a narrow column in
/// the middle of a wide pane, and a click maps through that column only.
#[test]
fn a_fixed_viewport_is_drawn_at_its_own_aspect_and_clicked_through_it() {
    let size = PaneSize {
        cols: 160,
        rows: 41,
        cell_w: 8,
        cell_h: 16,
    };
    let phone = layout(size, Viewport::Mobile);
    assert_eq!((phone.page_w, phone.page_h), (400, 800));
    assert_eq!(phone.rows, 40, "as tall as the picture area");
    // 40 rows of 16px is 640px for 800px of page: 400px is 320px, 40 cells.
    assert_eq!(phone.cols, 40);
    assert_eq!(phone.col, 61, "centred: 60 columns of margin each side");
    assert!(!on_picture(60, 10, phone), "the margin is not the page");
    assert!(on_picture(61, 10, phone));
    // The middle of the column is the middle of the page.
    let (x, y) = cell_to_page(80, 21, phone);
    assert!(
        (x - 195.0).abs() < 10.0 && (y - 390.0).abs() < 20.0,
        "{x},{y}"
    );
    let drawn = String::from_utf8(draw_frame(b"\xff", phone)).unwrap();
    assert!(drawn.contains("\x1b[2;61H"), "{drawn}");
    assert!(drawn.contains("width=40;height=40"), "{drawn}");
}

#[test]
fn the_sgr_button_codes_mean_what_they_say() {
    assert_eq!(
        decode_button(0),
        ButtonMeaning::Button {
            button: MouseButton::Left,
            dragging: false
        }
    );
    assert_eq!(
        decode_button(2),
        ButtonMeaning::Button {
            button: MouseButton::Right,
            dragging: false
        }
    );
    // 32 is the motion bit: a drag, not a fresh press.
    assert_eq!(
        decode_button(32),
        ButtonMeaning::Button {
            button: MouseButton::Left,
            dragging: true
        }
    );
    assert_eq!(decode_button(64), ButtonMeaning::Wheel { up: true });
    assert_eq!(decode_button(65), ButtonMeaning::Wheel { up: false });
    assert_eq!(decode_button(3), ButtonMeaning::Release);
}

/// Wheel up scrolled the page DOWN: the sign was inverted against CDP,
/// whose `deltaY` follows the DOM (positive = towards the bottom).
#[test]
fn wheel_up_scrolls_towards_the_top() {
    assert!(wheel_delta_y(true) < 0.0);
    assert!(wheel_delta_y(false) > 0.0);
}

/// `text` present means the key TYPES. Sending it for a named key inserts
/// the word "ArrowLeft" into whatever has focus.
#[test]
fn only_a_printable_key_carries_text() {
    assert_eq!(key_name("a"), ("a".to_string(), Some("a".to_string())));
    assert_eq!(key_name("\x1b[D"), ("ArrowLeft".to_string(), None));
    assert_eq!(key_name("\t"), ("Tab".to_string(), None));
    assert_eq!(key_name("\x7f"), ("Backspace".to_string(), None));
    assert_eq!(key_name("\r").0, "Enter");
}

/// A whole line typed fast arrives as ONE read, and every input in it must
/// survive. The bug this guards cost the rest of the line: the key loop
/// drained the chunk into a list, saw the `:`, and handed control to the
/// command line — which then read from an empty buffer and waited, while the
/// `goto example.com` it was waiting for sat in a list nobody would look at
/// again. Typing slowly worked; typing at speed, or pasting, did not.
#[tokio::test]
async fn a_whole_line_in_one_chunk_survives_a_handover() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let mut inputs = Inputs::from_rx(rx);
    tx.send(b":goto example.com\r".to_vec()).expect("send");
    drop(tx);

    let mut seen = Vec::new();
    while let Some(Input::Key(key)) = inputs.next().await {
        seen.push(String::from_utf8_lossy(&key).to_string());
    }
    assert_eq!(seen.first().map(String::as_str), Some(":"));
    assert_eq!(
        seen[1..].concat(),
        "goto example.com\r",
        "the rest of the line must still be there after the `:` is taken"
    );
}

/// The tag is handed to the CLI, which is what makes it a run-shell write,
/// and it carries the page: that is what a snapshot hands back.
#[test]
fn the_restore_tag_is_handed_to_the_cli_with_the_page() {
    let argv = restore_tag_args(
        "%7",
        Some("notes"),
        true,
        Viewport::Mobile,
        Some("https://example.com/a b"),
    );
    assert_eq!(argv[0], "pane");
    assert_eq!(argv[1], "restore-cmd");
    assert_eq!(argv[3], "%7");
    assert_eq!(
        argv[2],
        "tmuxy browser --session 'notes' --color-filter --viewport mobile 'https://example.com/a b'"
    );
    let bare = restore_tag_args("%1", None, false, Viewport::Auto, None);
    assert_eq!(
        bare[2], "tmuxy browser",
        "a pane's own session is not carried over"
    );
}

/// The tag is what lets the app draw a toolbar over row 1; it is set and
/// cleared through the CLI (`run-shell`), never by pane output.
/// The address bar reads the page's address from its own tag; the CLI
/// quotes it, so `&` and `#` in a URL stay one argument.
#[test]
fn the_address_is_tagged_and_untagged_through_the_cli() {
    assert_eq!(
        url_tag_args("%3", Some("https://example.com/?a=1&b#c")),
        [
            "run",
            "set-option",
            "-p",
            "-t",
            "%3",
            "@tmuxy-pane-url",
            "https://example.com/?a=1&b#c"
        ]
    );
    assert_eq!(
        url_tag_args("%3", None),
        [
            "run",
            "set-option",
            "-p",
            "-u",
            "-t",
            "%3",
            "@tmuxy-pane-url"
        ]
    );
}

#[test]
fn the_live_tag_is_set_and_cleared_through_the_cli() {
    assert_eq!(
        widget_tag_args("%3", true),
        [
            "run",
            "set-option",
            "-p",
            "-t",
            "%3",
            "@tmuxy-pane-widget",
            "browser-live"
        ]
    );
    assert_eq!(
        widget_tag_args("%3", false),
        [
            "run",
            "set-option",
            "-p",
            "-u",
            "-t",
            "%3",
            "@tmuxy-pane-widget"
        ]
    );
}

/// The UI reads this row (`browserLiveHeader` in tmuxy-ui); the two must agree.
#[test]
fn the_toolbar_row_says_which_way_history_goes() {
    let nav = Navigation {
        url: "https://example.com/".into(),
        title: "Example Domain".into(),
        can_go_back: true,
        can_go_forward: false,
    };
    assert_eq!(
        header_line(&nav, false, Viewport::Auto, false),
        "tmuxy:browser 100a0"
    );
    assert_eq!(
        header_line(&nav, true, Viewport::Mobile, true),
        "tmuxy:browser 101m1"
    );
    assert!(
        header_line(&nav, true, Viewport::Desktop, false).len() < 20,
        "short enough never to wrap into the picture"
    );
}

/// A click on the toolbar row is the app's, not the page's; the status
/// row is under the picture, so a click there is the page's.
#[test]
fn the_toolbar_row_takes_no_clicks_through_to_the_page() {
    let size = PaneSize {
        cols: 80,
        rows: 10,
        cell_w: 8,
        cell_h: 16,
    };
    let page = layout(size, Viewport::Auto);
    assert_eq!(size.image_rows(), 9);
    assert!(!on_picture(1, 1, page), "row 1 is the toolbar's");
    assert!(on_picture(1, 2, page));
    assert!(
        on_picture(80, 10, page),
        "the status row is under the picture"
    );
    assert!(
        !on_picture(81, 5, page),
        "past the last column is off the page"
    );
}

/// Every tab starts on `about:blank`; the first real page has nowhere to
/// go back to.
#[test]
fn a_blank_start_is_not_somewhere_to_go_back_to() {
    assert!(!is_page("about:blank"));
    assert!(!is_page(""));
    assert!(is_page("https://example.com/"));
}

#[test]
fn the_cell_size_override_is_read_as_wxh() {
    assert_eq!(parse_cell_px("9x18"), Some((9, 18)));
    assert_eq!(parse_cell_px("10X20"), Some((10, 20)));
    assert_eq!(parse_cell_px("nonsense"), None);
    assert_eq!(parse_cell_px(""), None);
}
