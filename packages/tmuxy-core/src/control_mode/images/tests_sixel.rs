use super::*;
use proptest::prelude::*;

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

/// A raster attribute is a size the decoder allocates up front: icy_sixel's
/// own cap is 256 MiB, which 8000x8000 reaches from a 30-byte escape.
#[test]
fn a_sixel_declaring_a_canvas_past_the_cap_is_dropped_unallocated() {
    let mut parser = ImageParser::new();
    let result = parser.process(b"\x1bPq\"1;1;8000;8000#0~\x1b\\");
    assert!(result.new_images.is_empty());
    assert!(parser.placements.is_empty());
    assert!(result.clean_bytes.is_empty(), "the escape is consumed");
}

/// Drawing reaches the same allocation without declaring it: a repeat of
/// 65535 columns, over enough bands.
#[test]
fn a_sixel_drawing_a_canvas_past_the_cap_is_dropped() {
    let mut payload = b"\x1bPq#0;2;100;0;0#0!65535~".to_vec();
    payload.extend(std::iter::repeat_n(b'-', 60));
    payload.extend_from_slice(b"~\x1b\\");
    let mut parser = ImageParser::new();
    let result = parser.process(&payload);
    assert!(result.new_images.is_empty());
    assert!(parser.placements.is_empty());
}

#[test]
fn a_sixel_extent_counts_repeats_bands_and_the_raster() {
    assert_eq!(sixel_and_iterm::sixel_extent(b"#0;2;100;0;0#0~~"), (2, 6));
    assert_eq!(sixel_and_iterm::sixel_extent(b"!10~$~~-~"), (10, 12));
    assert_eq!(sixel_and_iterm::sixel_extent(b"\"1;1;640;480~"), (640, 480));
}

/// icy_sixel keeps a `!n` repeat until the next sixel byte uses it, across
/// whitespace, colour selections, raster attributes, `$`, `-` and any byte it
/// ignores. The extent has to charge the repeat to that byte too.
#[test]
fn a_sixel_extent_charges_a_repeat_to_the_next_sixel_whatever_comes_between() {
    for payload in [
        &b"!1000 ~"[..],
        b"!1000\n~",
        b"!1000\r\n\t~",
        b"!1000#0~",
        b"!1000#0;2;100;0;0~",
        b"!1000\"1;1~",
        b"!1000$~",
        b"!1000%&~",
    ] {
        let (width, _) = sixel_and_iterm::sixel_extent(payload);
        assert_eq!(width, 1000, "{:?}", String::from_utf8_lossy(payload));
    }
    // The repeat is spent by the sixel it applies to, and a later `!`
    // replaces an unspent one.
    assert_eq!(sixel_and_iterm::sixel_extent(b"!10 ~~"), (11, 6));
    assert_eq!(sixel_and_iterm::sixel_extent(b"!10 !20 ~"), (20, 6));
    // Carried over a band break, it widens the band it lands in.
    assert_eq!(sixel_and_iterm::sixel_extent(b"~-!300 ~"), (300, 12));
}

/// A 200-byte escape whose repeats sit one space from their sixels: icy_sixel
/// drew it on a 983,025 x 66 canvas (about 260 MB of RGBA, before the PNG
/// encode), while the extent saw 15 x 66 and let it through.
#[test]
fn a_sixel_whose_repeats_are_spaced_from_their_sixels_is_dropped() {
    let mut payload = b"\x1bPq#0;2;100;0;0#0".to_vec();
    payload.extend(b"!65535 ~".repeat(15));
    payload.extend(std::iter::repeat_n(b'-', 10));
    payload.extend_from_slice(b"~\x1b\\");
    assert!(payload.len() < 200);
    let mut parser = ImageParser::new();
    let result = parser.process(&payload);
    assert!(result.new_images.is_empty());
    assert!(parser.placements.is_empty());
    assert!(result.clean_bytes.is_empty(), "the escape is consumed");
}

/// An image arriving in many chunks is buffered without its earlier chunks
/// being scanned again, and still decodes once its terminator arrives.
#[test]
fn a_sixel_split_over_many_chunks_still_decodes() {
    let mut parser = ImageParser::new();
    let mut payload = b"\x1bPq#0;2;100;0;0#0".to_vec();
    payload.extend(std::iter::repeat_n(b'~', 4000));
    payload.extend_from_slice(b"\x1b\\after");
    let mut images = Vec::new();
    let mut clean = Vec::new();
    for chunk in payload.chunks(7) {
        let result = parser.process(chunk);
        images.extend(result.new_images);
        clean.extend(result.clean_bytes);
    }
    assert_eq!(images.len(), 1);
    assert_eq!(clean, b"after");
}

/// The terminator split between two chunks — ESC at the end of one, `\` at
/// the start of the next — still ends the escape.
#[test]
fn a_terminator_split_across_chunks_ends_the_escape() {
    let mut parser = ImageParser::new();
    let first = parser.process(b"\x1bPq#0;2;100;0;0#0~~\x1b");
    assert!(first.new_images.is_empty());
    let second = parser.process(b"\\tail");
    assert_eq!(second.new_images.len(), 1);
    assert_eq!(second.clean_bytes, b"tail");
}

/// A run of escapes that never end, then one terminator: each used to scan
/// the rest of the chunk for a terminator, which made the chunk quadratic.
/// The bytes still reach vt100 unchanged.
#[test]
fn a_run_of_unterminated_escapes_passes_through_once() {
    let mut parser = ImageParser::new();
    let mut input = b"\x1b_X".repeat(20_000);
    input.push(0x07);
    let result = parser.process(&input);
    assert_eq!(result.clean_bytes, input);
}

/// One Sixel token, with numbers small enough to keep each decode cheap.
fn sixel_token() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        (0x3Fu8..=0x7E).prop_map(|b| vec![b]),
        (0usize..300).prop_map(|n| format!("!{n}").into_bytes()),
        Just(b"!".to_vec()),
        Just(b"$".to_vec()),
        Just(b"-".to_vec()),
        prop::sample::select(vec![b' ', b'\n', b'\r', b'\t', b'%', b';', b'7'])
            .prop_map(|b| vec![b]),
        (0usize..300).prop_map(|n| format!("#{n}").into_bytes()),
        (0usize..300).prop_map(|n| format!("#{n};2;10;20;30").into_bytes()),
        (0usize..4, 0usize..4, 0usize..300, 0usize..300)
            .prop_map(|(a, b, w, h)| format!("\"{a};{b};{w};{h}").into_bytes()),
        (0usize..300).prop_map(|w| format!("\"1;1;{w}").into_bytes()),
    ]
}

proptest! {
    /// Whatever icy_sixel draws, its canvas fits inside the extent the cap
    /// is checked against.
    #[test]
    fn icy_sixel_never_draws_past_the_extent(
        tokens in prop::collection::vec(sixel_token(), 0..40),
    ) {
        let payload = tokens.concat();
        let (width, height) = sixel_and_iterm::sixel_extent(&payload);
        let settings = icy_sixel::decoder::DcsSettings::new(None, None, None);
        if let Ok(img) = icy_sixel::SixelImage::decode_from_dcs(&payload, settings) {
            prop_assert!(
                img.width <= width.max(1) && img.height <= height,
                "{:?}: drew {}x{}, extent {}x{}",
                String::from_utf8_lossy(&payload),
                img.width,
                img.height,
                width,
                height,
            );
        }
    }
}
