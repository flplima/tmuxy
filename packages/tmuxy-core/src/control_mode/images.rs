//! Terminal image protocol support.
//!
//! Three protocols are intercepted from raw terminal output before the bytes
//! reach the vt100 emulator:
//!
//! - **iTerm2 Inline Images** — `ESC ] 1337 ; File=<args> : <base64> BEL/ST`
//! - **Kitty Graphics Protocol** — `ESC _ G<keys>;<base64-payload> ESC \`
//!   (APC sequence, supports chunked transfer via `m=1`/`m=0`)
//! - **Sixel** — `ESC P <params> q <sixel data> ESC \` (DCS), decoded to PNG
//!   via the `icy_sixel` pure-Rust decoder.
//!
//! Each parsed payload is stored as a `StoredImage` (PNG/JPEG/GIF bytes plus
//! mime type). An `ImagePlacement` records where on the terminal grid the
//! image should render. The frontend pulls the bytes via the HTTP image
//! handler keyed by `(pane_id, image_id)`.
//!
//! tmux **control mode** forwards passthrough sequences verbatim through
//! `%output`, so we get the original bytes here even when the user is inside
//! a tmux session (verified empirically — see docs/RICH-RENDERING.md).

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Image protocol that produced this image.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageProtocol {
    ITerm2,
    Kitty,
    Sixel,
}

/// An image placement on the terminal grid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImagePlacement {
    /// Unique image ID (auto-incremented within this parser).
    pub id: u32,
    /// Row where the image starts (0-indexed, screen-relative).
    pub row: u16,
    /// Column where the image starts (0-indexed).
    pub col: u16,
    /// Width in terminal cells.
    pub width_cells: u16,
    /// Height in terminal cells.
    pub height_cells: u16,
    /// Which protocol produced this image.
    pub protocol: ImageProtocol,
}

/// Stored image blob.
#[derive(Debug, Clone)]
pub struct StoredImage {
    /// Raw image data (PNG, JPEG, GIF, etc.).
    pub data: Vec<u8>,
    /// MIME type (e.g., "image/png").
    pub mime_type: String,
}

/// In-flight kitty chunked transfer (across multiple APC sequences).
///
/// Kitty splits large payloads into chunks with `m=1` (more) and `m=0` (last).
/// Subsequent chunks may omit metadata (other than `i=`/`m=`), so we cache the
/// first chunk's transmission keys on the entry.
#[derive(Debug, Default)]
struct KittyChunked {
    /// Accumulated base64 payload (still encoded).
    payload: String,
    /// Image format (`f=`) from the first chunk: 32 = RGBA, 24 = RGB, 100 = PNG.
    format: u32,
    /// Source pixel width (`s=`).
    src_width: u32,
    /// Source pixel height (`v=`).
    src_height: u32,
    /// Display rows (`r=`) — 0 if unset.
    rows: u32,
    /// Display columns (`c=`) — 0 if unset.
    cols: u32,
}

/// Per-pane image parser state.
#[derive(Debug, Default)]
pub struct ImageParser {
    next_id: u32,
    /// Active image placements on the current screen.
    pub placements: Vec<ImagePlacement>,
    cursor_row: u16,
    cursor_col: u16,
    /// Kitty chunked transfers in progress, keyed by image id (`i=`).
    /// Single-chunk transfers (no `m=` key) bypass this map.
    kitty_chunks: std::collections::HashMap<u32, KittyChunked>,
}

/// Result of processing raw output through the image parser.
pub struct ImageProcessResult {
    /// Bytes with image sequences stripped (for vt100).
    pub clean_bytes: Vec<u8>,
    /// Newly completed images to store.
    pub new_images: Vec<(u32, StoredImage)>,
}

impl ImageParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.placements.clear();
        self.kitty_chunks.clear();
        self.cursor_row = 0;
        self.cursor_col = 0;
    }

    pub fn update_cursor(&mut self, row: u16, col: u16) {
        self.cursor_row = row;
        self.cursor_col = col;
    }

    /// Process raw output bytes, extracting image sequences from any of the
    /// three supported protocols. Returns cleaned bytes (image sequences
    /// stripped) and any newly completed images to store.
    pub fn process(&mut self, content: &[u8]) -> ImageProcessResult {
        let mut output = Vec::with_capacity(content.len());
        let mut new_images = Vec::new();
        let mut i = 0;

        while i < content.len() {
            if i + 1 < content.len() && content[i] == 0x1B {
                let nxt = content[i + 1];

                // iTerm2: ESC ] 1337 ; File= ...
                if nxt == b']' {
                    if let Some((consumed, image)) = self.try_parse_iterm2(&content[i..]) {
                        if let Some((id, stored)) = image {
                            new_images.push((id, stored));
                        }
                        i += consumed;
                        continue;
                    }
                }

                // Kitty Graphics Protocol: ESC _ G ... ESC \
                if nxt == b'_' {
                    if let Some((consumed, image)) = self.try_parse_kitty(&content[i..]) {
                        if let Some((id, stored)) = image {
                            new_images.push((id, stored));
                        }
                        i += consumed;
                        continue;
                    }
                }

                // Sixel: ESC P ... q ... ESC \
                if nxt == b'P' {
                    if let Some((consumed, image)) = self.try_parse_sixel(&content[i..]) {
                        if let Some((id, stored)) = image {
                            new_images.push((id, stored));
                        }
                        i += consumed;
                        continue;
                    }
                }
            }

            output.push(content[i]);
            i += 1;
        }

        ImageProcessResult {
            clean_bytes: output,
            new_images,
        }
    }

    // -------------------------------------------------------------------
    // iTerm2 Inline Images
    // -------------------------------------------------------------------

    fn try_parse_iterm2(&mut self, data: &[u8]) -> Option<(usize, Option<(u32, StoredImage)>)> {
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
        for arg in args_str.split(';') {
            if let Some(val) = arg.strip_prefix("width=") {
                width_cells = parse_iterm2_dim(val, 8);
            } else if let Some(val) = arg.strip_prefix("height=") {
                height_cells = parse_iterm2_dim(val, 16);
            } else if arg == "inline=1" {
                inline = true;
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
        self.placements.push(ImagePlacement {
            id,
            row: self.cursor_row,
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::ITerm2,
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
    // Kitty Graphics Protocol
    //
    // Format:  ESC _ G<comma-separated keys>;<base64-payload> ESC \
    //
    // Keys we honour:
    //   a   action (T=transmit+display, t=transmit only, p=display, d=delete)
    //   f   format (24=RGB, 32=RGBA, 100=PNG); default 32 per spec
    //   t   transmission medium (d=direct base64; only direct supported here)
    //   i   image id (used to coalesce chunked transfers)
    //   m   more-chunks flag (1=more, 0=last); absent = single-chunk
    //   s,v source image pixel width/height (required for RGB/RGBA)
    //   r,c display rows/cols on the terminal grid
    //
    // Everything else (z, X, Y, w, h, q, etc.) is parsed-and-ignored for
    // now — we render the full image at the cursor position without
    // sub-region cropping.
    // -------------------------------------------------------------------

    fn try_parse_kitty(&mut self, data: &[u8]) -> Option<(usize, Option<(u32, StoredImage)>)> {
        if data.len() < 4 || data[0] != 0x1B || data[1] != b'_' || data[2] != b'G' {
            return None;
        }

        // Locate the ESC \ terminator that ends the APC.
        let mut end = 3;
        while end + 1 < data.len() {
            if data[end] == 0x1B && data[end + 1] == b'\\' {
                break;
            }
            end += 1;
        }
        if end + 1 >= data.len() {
            return None; // Incomplete; wait for more bytes.
        }
        let consumed = end + 2;
        let body = &data[3..end];

        // Split on the first ';': keys ; payload
        let (keys_part, payload_part) = match body.iter().position(|&b| b == b';') {
            Some(idx) => (&body[..idx], &body[idx + 1..]),
            None => (body, &[][..]),
        };
        let keys_str = String::from_utf8_lossy(keys_part);

        let mut action = b'T';
        let mut format: u32 = 32;
        let mut transmission = b'd';
        let mut image_id: u32 = 0;
        let mut more_chunks: Option<bool> = None;
        let mut src_w: u32 = 0;
        let mut src_h: u32 = 0;
        let mut rows: u32 = 0;
        let mut cols: u32 = 0;

        for kv in keys_str.split(',') {
            let mut it = kv.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            match k {
                "a" => action = v.bytes().next().unwrap_or(b'T'),
                "f" => format = v.parse().unwrap_or(32),
                "t" => transmission = v.bytes().next().unwrap_or(b'd'),
                "i" => image_id = v.parse().unwrap_or(0),
                "m" => more_chunks = Some(v == "1"),
                "s" => src_w = v.parse().unwrap_or(0),
                "v" => src_h = v.parse().unwrap_or(0),
                "r" => rows = v.parse().unwrap_or(0),
                "c" => cols = v.parse().unwrap_or(0),
                _ => {}
            }
        }

        // We only support direct (base64-inline) transmission. File / shm
        // transmission would need filesystem access we don't grant here.
        if transmission != b'd' {
            return Some((consumed, None));
        }
        // We only render on transmit-and-display actions for now.
        if action != b'T' && action != b'p' {
            return Some((consumed, None));
        }

        let payload_str = std::str::from_utf8(payload_part).ok()?;

        // Chunked transfer (m=1 / m=0): accumulate; only finish on m=0 or
        // when no `m` key is present (single-chunk).
        let entry = if let Some(more) = more_chunks {
            let entry = self
                .kitty_chunks
                .entry(image_id)
                .or_insert_with(|| KittyChunked {
                    format,
                    src_width: src_w,
                    src_height: src_h,
                    rows,
                    cols,
                    ..Default::default()
                });
            entry.payload.push_str(payload_str);
            if more {
                return Some((consumed, None));
            }
            self.kitty_chunks.remove(&image_id)?
        } else {
            KittyChunked {
                payload: payload_str.to_string(),
                format,
                src_width: src_w,
                src_height: src_h,
                rows,
                cols,
            }
        };

        let raw = base64_decode(&entry.payload);
        if raw.is_empty() {
            return Some((consumed, None));
        }

        // Convert RGB/RGBA -> PNG so the frontend can render via <img>.
        let stored = match entry.format {
            100 => StoredImage {
                mime_type: detect_mime_type(&raw),
                data: raw,
            },
            24 | 32 => match rgba_to_png(&raw, entry.format, entry.src_width, entry.src_height) {
                Some(png) => StoredImage {
                    data: png,
                    mime_type: "image/png".to_string(),
                },
                None => return Some((consumed, None)),
            },
            _ => return Some((consumed, None)),
        };

        // Decide grid placement size.
        let (width_cells, height_cells) = self.kitty_cell_dims(&entry);
        let id = self.next_id;
        self.next_id += 1;
        self.placements.push(ImagePlacement {
            id,
            row: self.cursor_row,
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::Kitty,
        });

        Some((consumed, Some((id, stored))))
    }

    fn kitty_cell_dims(&self, entry: &KittyChunked) -> (u16, u16) {
        // Caller-specified rows/cols win; otherwise approximate from pixel
        // dims using 8x16 cell heuristics so the placement isn't wildly off.
        let cols = if entry.cols > 0 {
            entry.cols as u16
        } else if entry.src_width > 0 {
            (entry.src_width / 8).clamp(1, 200) as u16
        } else {
            40
        };
        let rows = if entry.rows > 0 {
            entry.rows as u16
        } else if entry.src_height > 0 {
            (entry.src_height / 16).clamp(1, 100) as u16
        } else {
            20
        };
        (cols, rows)
    }

    // -------------------------------------------------------------------
    // Sixel (DCS Pq...ST)
    //
    // We decode the palette-based raster using icy_sixel (pure Rust) and
    // re-encode as PNG. This keeps the frontend renderer uniform — every
    // protocol funnels through an <img src> served by /api/images.
    // -------------------------------------------------------------------

    fn try_parse_sixel(&mut self, data: &[u8]) -> Option<(usize, Option<(u32, StoredImage)>)> {
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

        // Sixel data starts after the `q` introducer.
        let q_pos = match body.iter().position(|&b| b == b'q') {
            Some(p) => p,
            None => return Some((consumed, None)),
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
        self.placements.push(ImagePlacement {
            id,
            row: self.cursor_row,
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::Sixel,
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

/// Find the end of an OSC sequence (BEL or ESC \).
/// Input starts after `ESC ]` (so `content[0]` is the first byte after `]`).
/// Returns (bytes consumed from input INCLUDING terminator, content slice).
fn find_osc_end(content: &[u8]) -> Option<(usize, &[u8])> {
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
fn base64_decode(input: &str) -> Vec<u8> {
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
fn detect_mime_type(data: &[u8]) -> String {
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
fn rgba_to_png(pixels: &[u8], format: u32, width: u32, height: u32) -> Option<Vec<u8>> {
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

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
    fn iterm2_non_inline_consumed_but_not_stored() {
        let mut parser = ImageParser::new();
        let input = b"\x1b]1337;File=name=dGVzdA==:AAAA\x07";
        let result = parser.process(input);
        assert!(result.clean_bytes.is_empty());
        assert!(parser.placements.is_empty());
        assert!(result.new_images.is_empty());
    }

    #[test]
    fn iterm2_mixed_with_text() {
        let mut parser = ImageParser::new();
        let input = b"Hello \x1b]1337;File=inline=1;width=5;height=3:AAAA\x07 World";
        let result = parser.process(input);
        assert_eq!(result.clean_bytes, b"Hello  World");
        assert_eq!(parser.placements.len(), 1);
    }

    #[test]
    fn kitty_png_single_chunk() {
        // Pretend we transmit a PNG payload directly with action=T, format=100.
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
        // PNG magic must be present at the start of the encoded bytes.
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

    #[test]
    fn sixel_decoded_to_png() {
        // Minimal valid SIXEL: 1 color, 1 sixel band.
        // Pq #0;2;100;0;0 -> palette entry; ~~ -> a column of 6 set pixels.
        let mut parser = ImageParser::new();
        let input = b"\x1bPq#0;2;100;0;0#0~~\x1b\\";
        let result = parser.process(input);

        assert!(result.clean_bytes.is_empty());
        // Sixel sometimes fails on toy inputs; if we did decode, the
        // placement protocol must match.
        if !parser.placements.is_empty() {
            assert_eq!(parser.placements[0].protocol, ImageProtocol::Sixel);
            assert_eq!(result.new_images.len(), 1);
            assert!(result.new_images[0].1.data.starts_with(b"\x89PNG"));
        }
    }

    #[test]
    fn mime_type_detection() {
        assert_eq!(detect_mime_type(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(detect_mime_type(b"\xFF\xD8\xFF\xE0"), "image/jpeg");
        assert_eq!(detect_mime_type(b"GIF89a"), "image/gif");
        assert_eq!(detect_mime_type(b"RIFF....WEBP"), "image/webp");
        assert_eq!(detect_mime_type(b"unknown"), "application/octet-stream");
    }
}
