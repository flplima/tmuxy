use super::*;
use base64::Engine;

impl ImageParser {
    // -------------------------------------------------------------------
    // iTerm2 Inline Images
    // -------------------------------------------------------------------

    pub(super) fn try_parse_iterm2(
        &mut self,
        data: &[u8],
    ) -> Option<(usize, Option<(u32, StoredImage)>)> {
        let prefix = b"\x1b]1337;";
        if data.len() < prefix.len() || &data[..prefix.len()] != prefix {
            return None;
        }

        let (end, content) = find_osc_end(&data[2..])?;
        let end = end + 2;
        let content_str = String::from_utf8_lossy(content);

        if !content_str.starts_with("1337;File=") {
            return Some((end, None));
        }
        let file_part = &content_str["1337;File=".len()..];
        let colon_pos = file_part.find(':')?;
        let args_str = &file_part[..colon_pos];
        let base64_data = &file_part[colon_pos + 1..];

        let mut width_cells: u16 = 0;
        let mut height_cells: u16 = 0;
        let mut inline = false;
        let mut stretch = false;
        for arg in args_str.split(';') {
            if let Some(val) = arg.strip_prefix("width=") {
                width_cells = parse_iterm2_dim(val, 8);
            } else if let Some(val) = arg.strip_prefix("height=") {
                height_cells = parse_iterm2_dim(val, 16);
            } else if arg == "inline=1" {
                inline = true;
            } else if arg == "preserveAspectRatio=0" {
                stretch = true;
            }
        }
        if !inline {
            return Some((end, None));
        }

        let decoded = base64_decode(base64_data);
        if decoded.is_empty() {
            return Some((end, None));
        }
        let mime_type = detect_mime_type(&decoded);

        if width_cells == 0 {
            width_cells = 40;
        }
        if height_cells == 0 {
            height_cells = 20;
        }

        let id = self.next_id;
        self.next_id += 1;
        self.place(ImagePlacement {
            id,
            row: self.cursor_row,
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::ITerm2,
            stretch,
        });
        Some((
            end,
            Some((
                id,
                StoredImage {
                    data: decoded,
                    mime_type,
                },
            )),
        ))
    }

    // -------------------------------------------------------------------
    // Sixel (DCS Pq...ST)
    //
    // We decode the palette-based raster using icy_sixel (pure Rust) and
    // re-encode as PNG. This keeps the frontend renderer uniform — every
    // protocol funnels through an <img src> served by /api/images.
    // -------------------------------------------------------------------

    pub(super) fn try_parse_sixel(
        &mut self,
        data: &[u8],
    ) -> Option<(usize, Option<(u32, StoredImage)>)> {
        if data.len() < 4 || data[0] != 0x1B || data[1] != b'P' {
            return None;
        }
        let mut end = 2;
        while end + 1 < data.len() {
            if data[end] == 0x1B && data[end + 1] == b'\\' {
                break;
            }
            end += 1;
        }
        if end + 1 >= data.len() {
            return None;
        }
        let consumed = end + 2;
        let body = &data[2..end];

        // Sixel data starts after the `q` introducer, and all that may come
        // before it is the introducer's numeric parameters (`P1;P2;P3`). Other
        // DCS strings can hold a `q` too without being pictures: nvim asks the
        // terminal about its capabilities with XTGETTCAP (`ESC P + q <hex>`)
        // when it starts, and DECRQSS is `ESC P $ q`. Decoded as Sixel, those
        // left a few black pixels wherever the cursor happened to be.
        let q_pos = match body.iter().position(|&b| b == b'q') {
            Some(p) if body[..p].iter().all(|&b| b.is_ascii_digit() || b == b';') => p,
            _ => return Some((consumed, None)),
        };
        let sixel_payload = &body[q_pos + 1..];

        // icy_sixel's full-DCS decoder expects the whole envelope including
        // ESC P ... ESC \. Hand it the full slice.
        let full = &data[..consumed];
        let img = match icy_sixel::SixelImage::decode(full) {
            Ok(img) => img,
            Err(_) => {
                // Fall back to payload-only decode in case the wrapper rejects
                // some non-standard parameter strings.
                let settings = icy_sixel::decoder::DcsSettings::new(None, None, None);
                match icy_sixel::SixelImage::decode_from_dcs(sixel_payload, settings) {
                    Ok(img) => img,
                    Err(_) => return Some((consumed, None)),
                }
            }
        };

        let png = match rgba_to_png(&img.pixels, 32, img.width as u32, img.height as u32) {
            Some(b) => b,
            None => return Some((consumed, None)),
        };

        // Approximate grid placement from pixel dims; cells are ~8x16.
        let width_cells = (img.width as u32 / 8).clamp(1, 200) as u16;
        let height_cells = (img.height as u32 / 16).clamp(1, 100) as u16;

        let id = self.next_id;
        self.next_id += 1;
        self.place(ImagePlacement {
            id,
            row: self.cursor_row,
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::Sixel,
            stretch: false,
        });

        Some((
            consumed,
            Some((
                id,
                StoredImage {
                    data: png,
                    mime_type: "image/png".to_string(),
                },
            )),
        ))
    }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/// Whether the bytes end with a cursor move to the top left (CUP to 1;1).
/// Whether two placements share a cell.
pub(super) fn overlaps(a: &ImagePlacement, b: &ImagePlacement) -> bool {
    let span = |start: u16, len: u16| (start, start.saturating_add(len.max(1)));
    let (a_left, a_right) = span(a.col, a.width_cells);
    let (b_left, b_right) = span(b.col, b.width_cells);
    let (a_top, a_bottom) = span(a.row, a.height_cells);
    let (b_top, b_bottom) = span(b.row, b.height_cells);
    a_left < b_right && b_left < a_right && a_top < b_bottom && b_top < a_bottom
}

pub(super) fn ends_with_cursor_home(bytes: &[u8]) -> bool {
    [
        &b"\x1b[H"[..],
        b"\x1b[1;1H",
        b"\x1b[;H",
        b"\x1b[1H",
        b"\x1b[f",
        b"\x1b[1;1f",
    ]
    .iter()
    .any(|home| bytes.ends_with(home))
}

/// Whether DECSET/DECRST parameters name an alternate-screen mode.
pub(super) fn names_alternate_screen(params: &[u8]) -> bool {
    params
        .split(|&b| b == b';')
        .any(|p| p == b"1049" || p == b"1047" || p == b"47")
}

fn parse_iterm2_dim(raw: &str, px_per_cell: u16) -> u16 {
    // iTerm2 dimensions can be cells (`10`), pixels (`100px`), or percent
    // (`50%`). Percent without a viewport is ambiguous; clamp it to a
    // reasonable default.
    if let Some(px) = raw.strip_suffix("px") {
        return px
            .parse::<u16>()
            .map(|n| (n / px_per_cell).max(1))
            .unwrap_or(0);
    }
    if let Some(pct) = raw.strip_suffix('%') {
        return pct
            .parse::<u16>()
            .map(|n| ((n as u32 * 80 / 100) as u16).max(1))
            .unwrap_or(0);
    }
    raw.parse::<u16>().unwrap_or(0)
}

/// True if `content` contains a string-sequence terminator (BEL or ST `ESC \`).
/// Used to tell an *incomplete* image escape (none present → split across the
/// %output boundary) from a complete one that simply isn't an image.
/// Read a tmux passthrough body up to its terminating `ESC \`, restoring every
/// doubled `ESC` on the way. Returns the payload and how many bytes it spanned,
/// or `None` when the terminator has not arrived yet.
pub(super) fn undouble_escapes(body: &[u8]) -> Option<(Vec<u8>, usize)> {
    let mut payload = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        if body[i] == 0x1B {
            match body.get(i + 1) {
                None => return None,
                Some(0x1B) => {
                    payload.push(0x1B);
                    i += 2;
                }
                Some(b'\\') => return Some((payload, i + 2)),
                Some(_) => {
                    payload.push(body[i]);
                    i += 1;
                }
            }
        } else {
            payload.push(body[i]);
            i += 1;
        }
    }
    None
}

pub(super) fn has_escape_terminator(content: &[u8]) -> bool {
    content
        .iter()
        .enumerate()
        .any(|(i, &b)| b == 0x07 || (b == 0x1B && content.get(i + 1) == Some(&b'\\')))
}

/// Find the end of an OSC sequence (BEL or ESC \).
/// Input starts after `ESC ]` (so `content[0]` is the first byte after `]`).
/// Returns (bytes consumed from input INCLUDING terminator, content slice).
/// Find the terminator of an OSC body (BEL or ESC \\). `content` starts
/// AFTER the `ESC ]` prefix; returns (bytes consumed from `content`, body).
/// Shared with `OscParser` — the two modules used to carry near-identical
/// copies with different slicing conventions.
pub(crate) fn find_osc_end(content: &[u8]) -> Option<(usize, &[u8])> {
    for i in 0..content.len() {
        if content[i] == 0x07 {
            return Some((i + 1, &content[..i]));
        }
        if i + 1 < content.len() && content[i] == 0x1B && content[i + 1] == b'\\' {
            return Some((i + 2, &content[..i]));
        }
    }
    None
}

/// Decode standard base64 (and url-safe), tolerating embedded whitespace.
pub(super) fn base64_decode(input: &str) -> Vec<u8> {
    // Strip whitespace that real-world payloads often inject for readability.
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(&cleaned) {
        return b;
    }
    if let Ok(b) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(&cleaned) {
        return b;
    }
    if let Ok(b) = base64::engine::general_purpose::URL_SAFE.decode(&cleaned) {
        return b;
    }
    if let Ok(b) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&cleaned) {
        return b;
    }
    Vec::new()
}

/// Detect MIME type from the magic bytes of a buffer.
pub(super) fn detect_mime_type(data: &[u8]) -> String {
    if data.starts_with(b"\x89PNG") {
        "image/png".to_string()
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        "image/jpeg".to_string()
    } else if data.starts_with(b"GIF8") {
        "image/gif".to_string()
    } else if data.starts_with(b"RIFF") && data.len() >= 12 && &data[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

/// Encode raw RGB(format=24) or RGBA(format=32) pixel data as a PNG byte
/// buffer. Returns `None` if the dimensions don't match the payload length.
pub(super) fn rgba_to_png(pixels: &[u8], format: u32, width: u32, height: u32) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return None;
    }
    let (channels, color) = match format {
        24 => (3usize, png::ColorType::Rgb),
        32 => (4usize, png::ColorType::Rgba),
        _ => return None,
    };
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(channels)?;
    if pixels.len() < expected {
        return None;
    }
    let mut out = Vec::with_capacity(pixels.len() / 2);
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&pixels[..expected]).ok()?;
    }
    Some(out)
}
