//! The image parser reads a pane's output in the pieces tmux cut it into,
//! wherever its reads ended: the same bytes cut anywhere must read as they
//! do whole. The parser fuzzer's split-output property found each case here.

use base64::Engine as _;

use super::*;

/// An escape string is cut short by any escape but ST, as a terminal reads
/// it: what comes after is the terminal's, never held as part of a picture.
/// Found by the parser fuzzer (`ESC ] ESC T M` showed `M` or nothing,
/// depending on where tmux's `%output` lines happened to end).
#[test]
fn an_escape_string_cut_short_holds_back_nothing_after_it() {
    // What reached the terminal, then what is still held for the next
    // chunk: the same bytes in the same order however the input was cut.
    let passed = |chunks: &[&[u8]]| {
        let mut parser = ImageParser::new();
        let mut out = Vec::new();
        for chunk in chunks {
            let result = parser.process(chunk);
            assert!(result.new_images.is_empty());
            out.extend(result.clean_bytes);
        }
        out.extend(&parser.held);
        out.extend(&parser.pending);
        out
    };
    let fuzzed: &[u8] = b"\x1b]\x1bTM";
    assert_eq!(passed(&[fuzzed]), fuzzed);
    // An escape before a wrapper cut off at the line's end keeps its place
    // ahead of the wrapper when both are held (fuzzer: ESC ] ESC Ptmux;0 ESC \).
    let before_wrapper: &[u8] = b"\x1b]\x1bPtmux;0\x1b\\";
    let whole = passed(&[before_wrapper]);
    for cut in 1..before_wrapper.len() {
        let split = passed(&[&before_wrapper[..cut], &before_wrapper[cut..]]);
        assert_eq!(split, whole, "cut at {cut}");
    }
    // A stray OSC start, then colored output with no BEL or ST anywhere.
    let stray: &[u8] = b"\x1b]\x1b[31mhello\x1b[0m";
    assert_eq!(passed(&[stray]), stray);
    assert_eq!(passed(&[&stray[..2], &stray[2..]]), stray);
    // CAN cancels a string as an ESC does (fuzzer: ESC ] CAN TAB ESC Ptmux;).
    let cancelled: &[u8] = b"\x1b]\x18\t\x1bPtmux;";
    let whole = passed(&[cancelled]);
    assert!(whole.starts_with(b"\x1b]\x18\t"));
    for cut in 1..cancelled.len() {
        let split = passed(&[&cancelled[..cut], &cancelled[cut..]]);
        assert_eq!(split, whole, "cut at {cut}");
    }
    // A held escape that came out of a wrapper is not unwrapped again when
    // the next chunk arrives (fuzzer: ; ESC Ptmux; ESC Ptmux; ESC \ ESC c).
    let unwrapped_twice: &[u8] = b";\x1bPtmux;\x1bPtmux;\x1b\\\x1bc";
    let whole = passed(&[unwrapped_twice]);
    assert!(whole.ends_with(b"\x1bc"), "{whole:?}");
    for cut in 1..unwrapped_twice.len() {
        let split = passed(&[&unwrapped_twice[..cut], &unwrapped_twice[cut..]]);
        assert_eq!(split, whole, "cut at {cut}");
    }
    // A sixel and a kitty picture cut short: their text reaches the terminal.
    let sixel: &[u8] = b"\x1bPq#0;2;0;0;0\x1b[31mtext\x1b\\";
    assert!(passed(&[sixel]).windows(4).any(|w| w == b"text"));
    let kitty: &[u8] = b"\x1b_Ga=T,f=100;\x1b[31mtext\x1b\\";
    assert!(passed(&[kitty]).windows(4).any(|w| w == b"text"));
}

/// tmux's passthrough wrapper doubles every ESC inside it, so a wrapped
/// picture is full of ESC ESC: none of them may count as cutting the
/// string short. Cut anywhere, it reads as if it came whole.
#[test]
fn a_wrapped_picture_cut_at_any_byte_reads_as_if_whole() {
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let inner = format!("\x1b_Ga=T,f=100,c=4,r=2;{b64}\x1b\\");
    let wrapped = format!("a\x1bPtmux;{}\x1b\\b", inner.replace('\x1b', "\x1b\x1b"));
    let bytes = wrapped.as_bytes();
    let read = |chunks: &[&[u8]]| {
        let mut parser = ImageParser::new();
        let (mut clean, mut images) = (Vec::new(), 0);
        for chunk in chunks {
            let result = parser.process(chunk);
            clean.extend(result.clean_bytes);
            images += result.new_images.len();
        }
        (clean, images, parser.placements.len())
    };
    let whole = read(&[bytes]);
    assert_eq!(whole, (b"a\x1b\\b".to_vec(), 1, 1));
    let failing: Vec<usize> = (1..bytes.len())
        .filter(|&cut| read(&[&bytes[..cut], &bytes[cut..]]) != whole)
        .collect();
    assert!(
        failing.is_empty(),
        "cuts that differ: {failing:?} of {}",
        bytes.len()
    );
}

/// A chunk that ends on the ESC of a wrapper's start, after an escape held
/// from an earlier wrapper, keeps that ESC with the raw bytes: the next
/// chunk's `Ptmux;` completes the wrapper and the picture inside it draws,
/// as when the whole stream comes at once.
#[test]
fn a_wrapper_started_at_a_chunk_end_after_a_held_escape_still_unwraps() {
    let wrap = |inner: &str| format!("\x1bPtmux;{}\x1b\\", inner.replace('\x1b', "\x1b\x1b"));
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let picture = wrap(&format!("\x1b_Ga=T,f=100,c=4,r=2;{b64}\x1b\\"));
    let first = wrap("\x1b]1");
    let second = "; a\x1b";
    let third = &picture[1..];
    let read = |chunks: &[&[u8]]| {
        let mut parser = ImageParser::new();
        let images: usize = chunks
            .iter()
            .map(|chunk| parser.process(chunk).new_images.len())
            .sum();
        (images, parser.placements.len())
    };
    let whole = format!("{first}{second}{third}");
    assert_eq!(read(&[whole.as_bytes()]), (1, 1));
    assert_eq!(
        read(&[first.as_bytes(), second.as_bytes(), third.as_bytes()]),
        (1, 1)
    );
}

/// A picture's escape taken out of the stream still ends the sequence the
/// terminal was in when it came, as its own ESC would have: what follows it
/// is text, not the end of that sequence. Found by the parser fuzzer (an ESC
/// then a DCS ate the `;` after it when the output came whole, and printed it
/// when tmux cut the line after the BEL).
#[test]
fn a_stripped_escape_ends_the_sequence_it_cut_short() {
    let screen = |chunks: &[&[u8]]| {
        let mut parser = ImageParser::new();
        let mut terminal = vt100::Parser::new(4, 20, 0);
        for chunk in chunks {
            terminal.process(&parser.process(chunk).clean_bytes);
        }
        (
            terminal.screen().contents(),
            terminal.screen().cursor_position(),
        )
    };
    let cases: [(&[u8], &str); 3] = [
        // The fuzzer's: ESC, then a DCS that is no picture, then text.
        (b"\x1b\x1bP\x07\x1b\\;", ";"),
        // A CSI's parameters, then a kitty command: `m` is text, not SGR.
        (b"\x1b[1\x1b_Ga=d\x1b\\m", "m"),
        // An iTerm2 escape between a character and REP: nothing to repeat.
        (b"x\x1b]1337;Custom=1\x07\x1b[3b", "x"),
    ];
    for (bytes, shown) in cases {
        let whole = screen(&[bytes]);
        assert_eq!(whole.0, shown, "{bytes:?}");
        for cut in 1..bytes.len() {
            let split = screen(&[&bytes[..cut], &bytes[cut..]]);
            assert_eq!(split, whole, "{bytes:?} cut at {cut}");
        }
    }
}

/// A DCS ends at a C1 ST (the one byte 0x9C) once its introducer's final
/// byte has opened its data, as vt100 reads it, so the text after it is
/// printed. Read as part of the picture, that text was dropped when the
/// output came whole and printed when tmux cut it after the ST (fuzzer:
/// ESC P q 1000… NUL 0x9C … BEL … SP ESC \, the space printed or not).
#[test]
fn a_dcs_ends_at_a_c1_st_as_the_terminal_reads_it() {
    let screen = |chunks: &[&[u8]]| {
        let mut images = ImageParser::new();
        let mut terminal = vt100::Parser::new(4, 20, 0);
        for chunk in chunks {
            terminal.process(&images.process(chunk).clean_bytes);
        }
        terminal.screen().contents()
    };
    // The picture's row, then the text on the line below it.
    let ended: &[u8] = b"\x1bPq#0~~\x9chi\x07!\x1b\\";
    assert_eq!(screen(&[ended]), "\nhi!");
    for cut in 1..ended.len() {
        assert_eq!(
            screen(&[&ended[..cut], &ended[cut..]]),
            "\nhi!",
            "cut at {cut}"
        );
    }
    // In the introducer it ends nothing; nor in an OSC or an APC.
    for not_ended in [
        &b"\x1bP1\x9cq#0~~hi\x1b\\"[..],
        b"\x1b]1337;File=:\x9chi\x1b\\",
        b"\x1b_Ga=T;\x9chi\x1b\\",
    ] {
        assert_eq!(screen(&[not_ended]), "", "{not_ended:?}");
    }
}

/// A BEL ends an OSC, not a DCS: a Sixel cut after a BEL in its body is held
/// for the rest and read whole, so the picture takes its row however tmux cut
/// the output (fuzzer: ESC P q BEL NUL CR LF ESC \, cut after the BEL).
#[test]
fn a_sixel_cut_after_a_bel_is_read_whole() {
    let screen = |chunks: &[&[u8]]| {
        let mut images = ImageParser::new();
        let mut terminal = vt100::Parser::new(4, 20, 0);
        for chunk in chunks {
            terminal.process(&images.process(chunk).clean_bytes);
        }
        (
            terminal.screen().contents(),
            terminal.screen().cursor_position(),
        )
    };
    let sixel: &[u8] = b"\x1bPq#0~~\x07~~\x1b\\hi";
    let whole = screen(&[sixel]);
    assert_eq!(whole, ("\nhi".to_string(), (1, 2)));
    for cut in 1..sixel.len() {
        let split = screen(&[&sixel[..cut], &sixel[cut..]]);
        assert_eq!(split, whole, "cut at {cut}");
    }
}
