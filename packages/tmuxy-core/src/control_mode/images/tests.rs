use super::*;
use base64::Engine;

#[test]
fn iterm2_inline_image_strips_and_stores() {
    let mut parser = ImageParser::new();
    let b64 = "iVBORw0KGgo="; // truncated PNG header
    let input = format!("\x1b]1337;File=inline=1;width=10;height=5:{}\x07", b64);
    let result = parser.process(input.as_bytes());

    assert!(result.clean_bytes.is_empty());
    assert_eq!(parser.placements.len(), 1);
    assert_eq!(parser.placements[0].protocol, ImageProtocol::ITerm2);
    assert_eq!(parser.placements[0].width_cells, 10);
    assert_eq!(parser.placements[0].height_cells, 5);
    assert_eq!(result.new_images.len(), 1);
}

#[test]
fn iterm2_preserve_aspect_ratio_zero_fills_its_cells() {
    let mut parser = ImageParser::new();
    parser.process(
        b"\x1b]1337;File=inline=1;width=10;height=5;preserveAspectRatio=0:iVBORw0KGgo=\x07",
    );
    assert!(parser.placements[0].stretch);
    let mut parser = ImageParser::new();
    parser.process(b"\x1b]1337;File=inline=1;width=10;height=5:iVBORw0KGgo=\x07");
    assert!(
        !parser.placements[0].stretch,
        "fitting is the protocol's default"
    );
}

/// A picture moved within the pane (re-centred after a resize) replaces the
/// one it is drawn over, rather than stacking beside it.
#[test]
fn a_picture_drawn_over_another_replaces_it() {
    let mut parser = ImageParser::new();
    parser.update_cursor(1, 30);
    parser.process(b"\x1b]1337;File=inline=1;width=20;height=10:iVBORw0KGgo=\x07");
    parser.update_cursor(1, 25);
    parser.process(b"\x1b]1337;File=inline=1;width=20;height=10:iVBORw0KGgo=\x07");
    assert_eq!(parser.placements.len(), 1, "the covered picture is retired");
    assert_eq!(parser.placements[0].col, 25);

    // One beside it, sharing no cell, stays.
    parser.update_cursor(1, 60);
    parser.process(b"\x1b]1337;File=inline=1;width=5;height=5:iVBORw0KGgo=\x07");
    assert_eq!(parser.placements.len(), 2);
}

#[test]
fn iterm2_non_inline_consumed_but_not_stored() {
    let mut parser = ImageParser::new();
    let input = b"\x1b]1337;File=name=dGVzdA==:iVBORw0KGgo=\x07";
    let result = parser.process(input);
    assert!(result.clean_bytes.is_empty());
    assert!(parser.placements.is_empty());
    assert!(result.new_images.is_empty());
}

#[test]
fn iterm2_mixed_with_text() {
    let mut parser = ImageParser::new();
    let input = b"Hello \x1b]1337;File=inline=1;width=5;height=3:iVBORw0KGgo=\x07 World";
    let result = parser.process(input);
    assert_eq!(result.clean_bytes, b"Hello  World");
    assert_eq!(parser.placements.len(), 1);
}

#[test]
fn iterm2_image_split_across_chunks_is_buffered_not_torn() {
    // Regression: a payload larger than one %output read used to have its
    // header leaked into vt100 as garbage and the image dropped.
    let mut parser = ImageParser::new();
    let out1 = parser.process(b"\x1b]1337;File=inline=1;width=5;height=3:iVBORw");
    // Incomplete — buffered, nothing leaked to vt100 yet.
    assert!(out1.clean_bytes.is_empty());
    assert!(parser.placements.is_empty());
    let out2 = parser.process(b"0KGgo=\x07done");
    assert_eq!(out2.clean_bytes, b"done");
    assert_eq!(parser.placements.len(), 1);
    assert_eq!(out2.new_images.len(), 1);
}

#[test]
fn non_image_and_oversized_single_chunk_uploads_are_dropped() {
    let mut parser = ImageParser::new();
    for payload in [
        &b"<html><script>alert(1)</script></html>"[..],
        &b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..],
        &b"\x00\x00\x00"[..],
    ] {
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload);
        let iterm = format!("\x1b]1337;File=inline=1:{b64}\x07");
        assert!(parser.process(iterm.as_bytes()).new_images.is_empty());
        let kitty = format!("\x1b_Ga=T,f=100;{b64}\x1b\\");
        assert!(parser.process(kitty.as_bytes()).new_images.is_empty());
    }
    assert!(parser.placements.is_empty());

    // A PNG-headed payload is a picture the parser keeps, so only the size cap
    // can refuse the oversized one below (zeros alone would already be
    // dropped as "not an image").
    let picture = |len: usize| {
        let mut raw = b"\x89PNG\r\n\x1a\n".to_vec();
        raw.resize(len, 0);
        base64::engine::general_purpose::STANDARD.encode(raw)
    };
    let small = picture(64);
    let iterm = format!("\x1b]1337;File=inline=1:{small}\x07");
    assert_eq!(parser.process(iterm.as_bytes()).new_images.len(), 1);
    let kitty = format!("\x1b_Ga=T,f=100;{small}\x1b\\");
    assert_eq!(parser.process(kitty.as_bytes()).new_images.len(), 1);

    let oversized = picture(MAX_CHUNKED_IMAGE);
    assert!(oversized.len() > MAX_CHUNKED_IMAGE);
    let iterm = format!("\x1b]1337;File=inline=1:{oversized}\x07");
    assert!(parser.process(iterm.as_bytes()).new_images.is_empty());
    let kitty = format!("\x1b_Ga=T,f=100;{oversized}\x1b\\");
    assert!(parser.process(kitty.as_bytes()).new_images.is_empty());
}

#[test]
fn complete_osc8_hyperlink_passes_through_image_parser() {
    // A complete non-image ESC ] sequence (OSC 8) has a terminator, so it
    // must NOT be buffered — it passes through to reach the OSC parser.
    let mut parser = ImageParser::new();
    let out = parser.process(b"\x1b]8;;https://example.com\x07hi");
    assert_eq!(out.clean_bytes, b"\x1b]8;;https://example.com\x07hi");
    assert!(parser.placements.is_empty());
}

#[test]
fn kitty_png_single_chunk() {
    let mut parser = ImageParser::new();
    // Minimal PNG-magic prefix so detect_mime_type returns image/png.
    let png = b"\x89PNG\r\n\x1a\n";
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let input = format!("\x1b_Ga=T,f=100,i=1,c=4,r=2;{}\x1b\\", b64);
    let result = parser.process(input.as_bytes());

    assert!(
        result.clean_bytes.is_empty(),
        "kitty bytes must be stripped"
    );
    assert_eq!(parser.placements.len(), 1);
    let p = &parser.placements[0];
    assert_eq!(p.protocol, ImageProtocol::Kitty);
    assert_eq!(p.width_cells, 4);
    assert_eq!(p.height_cells, 2);
    assert_eq!(result.new_images.len(), 1);
    assert_eq!(result.new_images[0].1.mime_type, "image/png");
}

#[test]
fn a_kitty_frame_wrapped_in_tmux_passthrough_still_renders() {
    // What an application inside tmux actually sends: the escape wrapped
    // for tmux to relay, with every ESC in the payload doubled. Sent bare
    // instead, tmux reads the APC as a pane title and the title turns into
    // base64 while the picture draws.
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let inner = format!("\x1b_Ga=T,f=100,c=4,r=2;{b64}\x1b\\");
    let wrapped = format!("\x1bPtmux;{}\x1b\\", inner.replace('\x1b', "\x1b\x1b"));

    let result = parser.process(wrapped.as_bytes());

    assert!(
        result.clean_bytes.is_empty(),
        "the whole wrapper is consumed: {:?}",
        String::from_utf8_lossy(&result.clean_bytes)
    );
    assert_eq!(parser.placements.len(), 1);
    assert_eq!(parser.placements[0].protocol, ImageProtocol::Kitty);
    assert_eq!(result.new_images.len(), 1);
}

#[test]
fn text_inside_a_passthrough_survives_unwrapping() {
    let mut parser = ImageParser::new();
    let result = parser.process(b"\x1bPtmux;hello\x1b\\ world");
    assert_eq!(String::from_utf8_lossy(&result.clean_bytes), "hello world");
}

#[test]
fn a_passthrough_split_across_reads_is_held_until_it_completes() {
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let inner = format!("\x1b_Ga=T,f=100,c=4,r=2;{b64}\x1b\\");
    let wrapped = format!("\x1bPtmux;{}\x1b\\", inner.replace('\x1b', "\x1b\x1b"));
    let (head, tail) = wrapped.as_bytes().split_at(wrapped.len() / 2);

    let first = parser.process(head);
    assert!(first.new_images.is_empty(), "nothing yet");
    assert!(
        first.clean_bytes.is_empty(),
        "a torn wrapper must not leak into the screen: {:?}",
        String::from_utf8_lossy(&first.clean_bytes)
    );

    let second = parser.process(tail);
    assert_eq!(
        second.new_images.len(),
        1,
        "the frame lands once it is whole"
    );
    assert!(second.clean_bytes.is_empty());
}

#[test]
fn kitty_delete_clears_placements_so_a_repaint_does_not_stack() {
    // A live preview repaints by deleting, then transmitting the next
    // frame. Ignoring the delete left one placement per frame on screen.
    let mut parser = ImageParser::new();
    let png = b"\x89PNG\r\n\x1a\n";
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let frame = format!("\x1b_Ga=T,f=100,c=4,r=2;{}\x1b\\", b64);

    parser.process(frame.as_bytes());
    parser.cursor_row = 10; // a second picture elsewhere on the screen
    parser.process(frame.as_bytes());
    assert_eq!(parser.placements.len(), 2, "two pictures on screen");

    // The delete an application sends before its next frame.
    let result = parser.process(b"\x1b_Ga=d,q=2\x1b\\");
    assert!(
        result.clean_bytes.is_empty(),
        "the delete must be stripped from the text stream"
    );
    assert!(parser.placements.is_empty(), "a=d drops every placement");

    parser.cursor_row = 0;
    parser.process(frame.as_bytes());
    assert_eq!(parser.placements.len(), 1, "the repaint leaves one frame");
}

#[test]
fn a_frame_redrawn_at_the_same_anchor_replaces_the_old_one() {
    // A preview loop homes the cursor and sends the next frame at the same
    // spot. Appending each one stacked the pane full of dead frames.
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let frame = format!("\x1b_Ga=T,f=100,c=4,r=2;{}\x1b\\", b64);

    for _ in 0..5 {
        parser.cursor_row = 0;
        parser.cursor_col = 0;
        parser.process(frame.as_bytes());
    }
    assert_eq!(parser.placements.len(), 1, "one frame on screen, not five");

    // A picture somewhere else is its own placement, not a replacement.
    parser.cursor_row = 12;
    parser.process(frame.as_bytes());
    assert_eq!(parser.placements.len(), 2);
}

#[test]
fn kitty_delete_by_id_is_left_alone() {
    // Narrow selectors are left alone: dropping the wrong picture is worse
    // than keeping it.
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    parser.process(format!("\x1b_Ga=T,f=100,c=4,r=2;{}\x1b\\", b64).as_bytes());
    parser.process(b"\x1b_Ga=d,d=i,i=7,q=2\x1b\\");
    assert_eq!(parser.placements.len(), 1);
}

#[test]
fn kitty_rgba_converted_to_png() {
    let mut parser = ImageParser::new();
    // 2x1 RGBA pixels: red, green
    let pixels: Vec<u8> = vec![255, 0, 0, 255, 0, 255, 0, 255];
    let b64 = base64::engine::general_purpose::STANDARD.encode(&pixels);
    let input = format!("\x1b_Ga=T,f=32,i=2,s=2,v=1;{}\x1b\\", b64);
    let result = parser.process(input.as_bytes());

    assert_eq!(parser.placements.len(), 1);
    let stored = &result.new_images[0].1;
    assert_eq!(stored.mime_type, "image/png");
    assert!(stored.data.starts_with(b"\x89PNG"));
}

#[test]
fn kitty_chunked_transfer_assembles() {
    let mut parser = ImageParser::new();
    // 4x1 RGBA payload split into two chunks.
    let pixels: Vec<u8> = vec![
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ];
    let full_b64 = base64::engine::general_purpose::STANDARD.encode(&pixels);
    let mid = full_b64.len() / 2;
    let (a, b) = full_b64.split_at(mid);

    let chunk1 = format!("\x1b_Ga=T,f=32,i=7,s=4,v=1,m=1;{}\x1b\\", a);
    let chunk2 = format!("\x1b_Gi=7,m=0;{}\x1b\\", b);

    let r1 = parser.process(chunk1.as_bytes());
    assert!(r1.new_images.is_empty(), "first chunk emits nothing yet");
    assert!(parser.placements.is_empty());

    let r2 = parser.process(chunk2.as_bytes());
    assert_eq!(r2.new_images.len(), 1);
    assert_eq!(parser.placements.len(), 1);
    assert_eq!(parser.placements[0].protocol, ImageProtocol::Kitty);
    assert_eq!(r2.new_images[0].1.mime_type, "image/png");
}

/// Pane output is untrusted: a program opening ids with `m=1` and never
/// sending `m=0` must not grow the map for the life of the pane.
#[test]
fn unfinished_chunked_transfers_are_bounded_in_number() {
    let mut parser = ImageParser::new();
    // Far more ids than the cap, none of them ever finished.
    for id in 1..=(MAX_INFLIGHT_CHUNKED as u32 * 4) {
        let chunk = format!("\x1b_Ga=T,f=32,i={id},s=1,v=1,m=1;AAAA\x1b\\");
        parser.process(chunk.as_bytes());
    }
    assert!(
        parser.kitty_chunks.len() <= MAX_INFLIGHT_CHUNKED,
        "{} transfers in flight, over the {MAX_INFLIGHT_CHUNKED} cap",
        parser.kitty_chunks.len()
    );
}

#[test]
fn one_chunked_transfer_cannot_grow_without_end() {
    let mut parser = ImageParser::new();
    // One id, fed far past the cap and never finished.
    let filler = "A".repeat(64 * 1024);
    let opening = format!("\x1b_Ga=T,f=32,i=1,s=1,v=1,m=1;{filler}\x1b\\");
    parser.process(opening.as_bytes());
    for _ in 0..((MAX_CHUNKED_IMAGE / filler.len()) + 4) {
        let more = format!("\x1b_Gi=1,m=1;{filler}\x1b\\");
        parser.process(more.as_bytes());
    }
    let held = parser
        .kitty_chunks
        .get(&1)
        .map_or(0, |entry| entry.payload.len());
    assert!(
        held <= MAX_CHUNKED_IMAGE,
        "holding {held} bytes for one transfer, over the {MAX_CHUNKED_IMAGE} cap"
    );
}

/// A transfer that stopped sending is not kept for the life of the pane:
/// once it is older than the age cap it goes on the next chunk.
#[test]
fn an_abandoned_transfer_is_dropped_once_it_is_old() {
    let mut parser = ImageParser::default();
    parser.process(b"\x1b_Ga=T,f=100,i=1,m=1;AAAA\x1b\\");
    assert_eq!(parser.kitty_chunks.len(), 1);
    // Not yet: a transfer opened a moment ago is still streaming.
    parser.expire_stale_chunked(Instant::now());
    assert_eq!(parser.kitty_chunks.len(), 1);
    // Past the cap it is gone, and so is its place in the eviction order.
    parser.expire_stale_chunked(Instant::now() + MAX_CHUNKED_AGE);
    assert!(parser.kitty_chunks.is_empty());
    assert!(parser.kitty_chunk_order.is_empty());
}

/// The bounds must not cost a real image: one transfer at a time, finished
/// properly, is what a terminal actually sends.
#[test]
fn a_finished_transfer_leaves_nothing_in_flight() {
    let mut parser = ImageParser::new();
    let pixels: Vec<u8> = vec![255, 0, 0, 255];
    let full_b64 = base64::engine::general_purpose::STANDARD.encode(&pixels);
    let (a, b) = full_b64.split_at(full_b64.len() / 2);
    parser.process(format!("\x1b_Ga=T,f=32,i=9,s=1,v=1,m=1;{a}\x1b\\").as_bytes());
    parser.process(format!("\x1b_Gi=9,m=0;{b}\x1b\\").as_bytes());
    assert!(parser.kitty_chunks.is_empty());
    assert!(parser.kitty_chunk_order.is_empty());
}

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
    assert_eq!(whole, (b"ab".to_vec(), 1, 1));
    let failing: Vec<usize> = (1..bytes.len())
        .filter(|&cut| read(&[&bytes[..cut], &bytes[cut..]]) != whole)
        .collect();
    assert!(
        failing.is_empty(),
        "cuts that differ: {failing:?} of {}",
        bytes.len()
    );
}
