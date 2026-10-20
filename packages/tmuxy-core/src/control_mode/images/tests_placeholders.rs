//! Kitty Unicode placeholders, tmux passthrough chunking, and the cost
//! bounds on both.

use super::*;
use base64::Engine;

#[test]
fn kitty_unicode_placeholders_resolve_virtual_placements() {
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let image = format!(
        "\x1b_Ga=T,U=1,f=100,i=1258291242,c=2,r=2,m=1;{}\x1b\\",
        &b64[..4]
    );
    let mut terminal = vt100::Parser::new(4, 8, 0);
    let first = parser.process(image.as_bytes());
    assert!(first.clean_bytes.is_empty());
    assert!(first.new_images.is_empty());
    let parsed = parser.process(format!("\x1b_Ga=T;{}\x1b\\", &b64[4..]).as_bytes());
    assert_eq!(parsed.new_images.len(), 1);
    assert!(
        parser.placements.is_empty(),
        "virtual transmit has no screen anchor"
    );

    let cells =
        "\x1b[38;5;42m\u{10eeee}\u{0305}\u{0305}\u{06dc}\u{10eeee}\u{0305}\u{030d}\u{06dc}\r\n\
         \u{10eeee}\u{030d}\u{0305}\u{06dc}\u{10eeee}\u{030d}\u{030d}\u{06dc}\x1b[39m";
    terminal.process(cells.as_bytes());
    parser.update_kitty_placeholders(terminal.screen(), cells.as_bytes());

    assert_eq!(parser.placements.len(), 1);
    let placement = &parser.placements[0];
    assert_eq!((placement.row, placement.col), (0, 0));
    assert_eq!((placement.width_cells, placement.height_cells), (2, 2));
    assert_eq!(placement.protocol, ImageProtocol::Kitty);
    assert_eq!(crate::screen_cell_char(terminal.screen(), 0, 0), " ");
}

#[test]
fn kitty_compressed_final_chunk_without_metadata_survives_tmux_passthrough() {
    use std::io::{Cursor, Write};

    let pixels = [255, 0, 0, 0, 255, 0]; // 2x1 RGB: red, green
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&pixels).unwrap();
    let payload = base64::engine::general_purpose::STANDARD.encode(encoder.finish().unwrap());
    let split1 = (payload.len() / 3) / 4 * 4;
    let split2 = (payload.len() * 2 / 3) / 4 * 4;
    let first = &payload[..split1];
    let middle = &payload[split1..split2];
    let final_chunk = &payload[split2..];
    let wrap = |apc: String| format!("\x1bPtmux;{}\x1b\\", apc.replace('\x1b', "\x1b\x1b"));

    let mut parser = ImageParser::new();
    let first = wrap(format!(
        "\x1b_Ga=T,q=2,f=24,o=z,m=1,C=1,s=2,v=1,i=73;{first}\x1b\\"
    ));
    let result = parser.process(first.as_bytes());
    assert!(result.new_images.is_empty());
    assert!(result.clean_bytes.is_empty());

    // Kitty's continuation packets may omit the image id; the final
    // packet can omit m=0 and all image metadata as well.
    let middle = wrap(format!("\x1b_Ga=T,q=2,m=1;{middle}\x1b\\"));
    let result = parser.process(middle.as_bytes());
    assert!(result.new_images.is_empty());
    assert!(result.clean_bytes.is_empty());

    let final_chunk = wrap(format!("\x1b_Ga=T,q=2;{final_chunk}\x1b\\"));
    let result = parser.process(final_chunk.as_bytes());
    assert!(result.clean_bytes.is_empty());
    assert_eq!(result.new_images.len(), 1);
    assert_eq!(result.new_images[0].1.mime_type, "image/png");

    let decoder = png::Decoder::new(Cursor::new(&result.new_images[0].1.data));
    let mut reader = decoder.read_info().unwrap();
    let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut decoded).unwrap();
    assert_eq!(&decoded[..frame.buffer_size()], &pixels);
}

#[test]
fn kitty_placeholders_decode_an_id_whose_high_byte_is_past_the_first_marks() {
    // kitten picks ids across all 32 bits, so the third mark can be any of
    // the 297 entries, not just the first few.
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let image = format!("\x1b_Ga=T,U=1,f=100,i=2828986441,c=2,r=1;{b64}\x1b\\");
    parser.process(image.as_bytes());

    let mut terminal = vt100::Parser::new(2, 8, 0);
    let cells =
        "\x1b[38;2;158;232;73m\u{10eeee}\u{0305}\u{0305}\u{1dc5}\u{10eeee}\u{0305}\u{030d}\u{1dc5}\x1b[39m";
    terminal.process(cells.as_bytes());
    parser.update_kitty_placeholders(terminal.screen(), cells.as_bytes());

    assert_eq!(parser.placements.len(), 1);
    assert_eq!(parser.placements[0].width_cells, 2);
}

/// The placeholder walk costs rows × cols and sits on every output chunk's
/// path, so it runs only for chunks that can change a placement: one that
/// writes a placeholder cell, or one arriving while a placement is on screen.
/// Plain output in a pane that never showed one, or whose picture has
/// scrolled away, walks nothing.
#[test]
fn placeholder_scan_runs_only_when_a_placement_can_change() {
    let mut parser = ImageParser::new();
    let mut terminal = vt100::Parser::new(4, 8, 0);
    let plain = b"hello\r\n";

    for _ in 0..50 {
        terminal.process(plain);
        parser.update_kitty_placeholders(terminal.screen(), plain);
    }
    assert_eq!(
        parser.placeholder_scans, 0,
        "plain output never walks the grid"
    );

    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let image = format!("\x1b_Ga=T,U=1,f=100,i=7,c=1,r=1;{b64}\x1b\\");
    parser.process(image.as_bytes());
    let cells = "\x1b[38;5;7m\u{10eeee}\u{0305}\u{0305}\x1b[39m\r\n";
    terminal.process(cells.as_bytes());
    parser.update_kitty_placeholders(terminal.screen(), cells.as_bytes());
    assert_eq!(parser.placeholder_scans, 1);
    assert_eq!(parser.placements.len(), 1);

    // With the picture on screen, plain output may overwrite or scroll it,
    // so each chunk rescans — until the picture is gone.
    terminal.process(plain);
    parser.update_kitty_placeholders(terminal.screen(), plain);
    assert_eq!(parser.placeholder_scans, 2);
    assert_eq!(parser.placements.len(), 1, "still on screen after one line");

    for _ in 0..4 {
        terminal.process(plain);
        parser.update_kitty_placeholders(terminal.screen(), plain);
    }
    assert!(parser.placements.is_empty(), "scrolled off a 4-row screen");
    let settled = parser.placeholder_scans;
    for _ in 0..50 {
        terminal.process(plain);
        parser.update_kitty_placeholders(terminal.screen(), plain);
    }
    assert_eq!(
        parser.placeholder_scans, settled,
        "nothing left to rescan for"
    );
}

/// A pane printing placeholder images in a loop remembers a bounded number
/// of kitty ids, the oldest going first (SEC-22).
#[test]
fn kitty_id_map_is_bounded() {
    let mut parser = ImageParser::new();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    let total = MAX_KITTY_IMAGE_IDS as u32 * 2;
    for kitty_id in 1..=total {
        let image = format!("\x1b_Ga=T,U=1,f=100,i={kitty_id},c=1,r=1;{b64}\x1b\\");
        parser.process(image.as_bytes());
    }
    assert_eq!(parser.kitty_image_ids.len(), MAX_KITTY_IMAGE_IDS);
    assert!(!parser.kitty_image_ids.contains_key(&1));
    assert!(parser.kitty_image_ids.contains_key(&total));
    assert_eq!(parser.kitty_virtual_images.len(), MAX_KITTY_IMAGE_IDS);
}
