use super::*;

#[test]
fn sixel_decoded_to_png() {
    // Minimal valid SIXEL: 1 color, 1 sixel band.
    // Pq #0;2;100;0;0 -> palette entry; ~~ -> a column of 6 set pixels.
    let mut parser = ImageParser::new();
    let input = b"\x1bPq#0;2;100;0;0#0~~\x1b\\";
    let result = parser.process(input);

    assert!(result.clean_bytes.is_empty());
    // Unconditional: with the assertions previously guarded behind
    // `if !placements.is_empty()`, a total sixel-decode regression (every
    // image silently dropped) passed green.
    assert!(
        !parser.placements.is_empty(),
        "sixel input must produce a placement"
    );
    assert_eq!(parser.placements[0].protocol, ImageProtocol::Sixel);
    assert_eq!(result.new_images.len(), 1);
    assert!(result.new_images[0].1.data.starts_with(b"\x89PNG"));
}

const SIXEL: &[u8] = b"\x1bPq#0;2;100;0;0#0~~\x1b\\";

#[test]
fn a_terminal_query_that_holds_a_q_is_not_a_picture() {
    // nvim's startup capability query and a settings query: both are DCS
    // strings with a `q` in them, and both used to be decoded as Sixel.
    for query in [&b"\x1bP+q5463;524742\x1b\\"[..], b"\x1bP$qm\x1b\\"] {
        let mut parser = ImageParser::new();
        let result = parser.process(query);
        assert!(result.new_images.is_empty(), "{query:?} made an image");
        assert!(parser.placements.is_empty(), "{query:?} placed an image");
    }
}

#[test]
fn sixel_with_introducer_parameters_still_decodes() {
    let mut parser = ImageParser::new();
    let result = parser.process(b"\x1bP0;1;0q#0;2;100;0;0#0~~\x1b\\");
    assert_eq!(result.new_images.len(), 1);
    assert_eq!(parser.placements.len(), 1);
}

#[test]
fn clearing_the_screen_takes_its_pictures_away() {
    // `clear` sends home + ED 2; curses apps send home + ED 0. Either way
    // the screen is empty, and a picture left on it floated over whatever
    // was drawn next. The clear itself still reaches vt100.
    for clear in [&b"\x1b[H\x1b[2J\x1b[3J"[..], b"\x1b[H\x1b[J", b"\x1b[2J"] {
        let mut parser = ImageParser::new();
        parser.process(SIXEL);
        assert_eq!(parser.placements.len(), 1);
        let result = parser.process(clear);
        assert!(parser.placements.is_empty(), "{clear:?} left a picture");
        assert_eq!(result.clean_bytes, clear);
    }
}

#[test]
fn erasing_below_the_cursor_elsewhere_keeps_pictures() {
    // ED 0 from the middle of the screen is a partial erase, not a clear.
    let mut parser = ImageParser::new();
    parser.process(SIXEL);
    parser.process(b"\x1b[5;1H\x1b[J");
    assert_eq!(parser.placements.len(), 1);
}

#[test]
fn the_alternate_screen_neither_shows_nor_leaves_pictures() {
    // A picture in the shell must not show through an editor opened over
    // it, a picture the editor drew must not outlive it, and the shell's
    // picture is back when the editor quits.
    let mut parser = ImageParser::new();
    parser.process(SIXEL);
    let shell_picture = parser.placements.clone();

    parser.process(b"\x1b[?1049h");
    assert!(parser.placements.is_empty());
    parser.update_cursor(3, 4);
    parser.process(SIXEL);
    assert_eq!(parser.placements.len(), 1);

    parser.process(b"\x1b[?1049l");
    assert_eq!(parser.placements, shell_picture);
}

#[test]
fn a_full_reset_leaves_no_pictures_on_either_screen() {
    let mut parser = ImageParser::new();
    parser.process(SIXEL);
    parser.process(b"\x1b[?1049h");
    parser.process(SIXEL);
    parser.process(b"\x1bc");
    assert!(parser.placements.is_empty());
    parser.process(b"\x1b[?1049l");
    assert!(parser.placements.is_empty());
}

#[test]
fn mime_type_detection() {
    assert_eq!(detect_mime_type(b"\x89PNG\r\n\x1a\n"), "image/png");
    assert_eq!(detect_mime_type(b"\xFF\xD8\xFF\xE0"), "image/jpeg");
    assert_eq!(detect_mime_type(b"GIF89a"), "image/gif");
    assert_eq!(detect_mime_type(b"RIFF....WEBP"), "image/webp");
    assert_eq!(detect_mime_type(b"unknown"), "application/octet-stream");
}
