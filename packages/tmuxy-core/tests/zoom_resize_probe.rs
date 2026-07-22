//! Headless reproduction of the zoom/un-zoom resize cycle.
//!
//! Zooming grows a pane to the full window and un-zooming shrinks it back. The
//! reported symptom is that the pane renders empty afterwards, so this replays
//! exactly that geometry sequence through the emulator and checks the content
//! survives — no browser, no tmux, nothing that can drift mid-test.

use tmuxy_core::extract_cells_from_screen;

fn rows(parser: &vt100::Parser) -> Vec<String> {
    extract_cells_from_screen(parser.screen())
        .iter()
        .map(|l| {
            l.iter()
                .map(|c| c.char.as_str())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

fn non_blank(parser: &vt100::Parser) -> Vec<String> {
    rows(parser).into_iter().filter(|r| !r.is_empty()).collect()
}

/// A shell pane with a few lines of scrollback, zoomed then un-zoomed.
/// Un-zoomed geometry is the bottom-right pane of a 3-pane split.
#[test]
fn zoom_then_unzoom_keeps_pane_content() {
    let (unzoomed_w, unzoomed_h) = (40u16, 8u16);
    let (zoomed_w, zoomed_h) = (82u16, 16u16);

    let mut parser = vt100::Parser::new(unzoomed_h, unzoomed_w, 256);
    parser.process(b"$ echo CONTENT-A\r\nCONTENT-A\r\n$ ");

    let before = non_blank(&parser);
    assert!(
        before.iter().any(|r| r.contains("CONTENT-A")),
        "precondition: content must be on screen before zooming, got {before:?}"
    );

    // Zoom: grow to the full window.
    parser.screen_mut().set_size(zoomed_h, zoomed_w);
    let zoomed = non_blank(&parser);
    assert!(
        zoomed.iter().any(|r| r.contains("CONTENT-A")),
        "content vanished while ZOOMED, got {zoomed:?}"
    );

    // Un-zoom: shrink back to the split geometry.
    parser.screen_mut().set_size(unzoomed_h, unzoomed_w);
    let after = non_blank(&parser);
    assert!(
        after.iter().any(|r| r.contains("CONTENT-A")),
        "content vanished after UN-ZOOMING — this is the blank-pane bug. rows: {after:?}"
    );
}
